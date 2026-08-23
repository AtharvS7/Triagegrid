-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIAGEGRID MIGRATION 0001 — Schema, constraints, indexes, core triggers
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- DESIGN DECISIONS DOCUMENTED UP FRONT (per build directives):
--
-- FR-6 CONCURRENCY STRATEGY (double-dispatch prevention)
-- -------------------------------------------------------
-- Two independent database-level mechanisms guard resource_claims:
--
--   1. A PARTIAL UNIQUE INDEX: at most ONE claim per unit may exist in any live
--      state ('proposed' | 'finalized' | 'active'). A second partial unique
--      index guarantees at most ONE live PRIMARY claim per incident.
--   2. The claim RPC (migration 0003, claim_unit()) runs in a single
--      transaction that takes SELECT ... FOR UPDATE on the unit row first,
--      serializing all concurrent claim attempts for that unit, then re-checks
--      preconditions before inserting. The unique indexes are the backstop even
--      if a code path forgets the lock.
--
-- Why this prevents double-dispatch: Postgres row locks are exclusive for the
-- duration of the claim transaction, so concurrent claimants queue; after the
-- lock is released, the second claimant re-reads state inside its own
-- transaction (READ COMMITTED sees the committed winner) and fails its
-- precondition check. Even under pathological interleavings the unique index
-- makes the second INSERT physically impossible — it errors instead of
-- committing. Exactly one writer commits; all others receive typed, catchable
-- SQLSTATE P0001 exceptions (UNIT_ALREADY_CLAIMED / INCIDENT_ALREADY_CLAIMED).
-- No application-level "check then write" is involved anywhere.
--
-- CITIZEN TRACKING CODE — GENERATION METHOD AND ENTROPY
-- ------------------------------------------------------
-- Tracking codes are 22 characters drawn uniformly from a 62-character
-- alphabet (0-9A-Za-z) using UNBIASED rejection sampling over gen_random_bytes()
-- (Postgres built-in cryptographically secure PRNG, CTR_DRBG backed).
-- Keyspace: 62^22 ≈ 2^130; input entropy 128 bits of CSPRNG output per code.
-- At 10,000 guesses/sec against get_incident_by_tracking_code(), expected time
-- to hit a valid code exceeds 10^15 years. Brute-force resistance therefore
-- lives in the code itself, NOT merely in IP rate-limiting (rate limiting on
-- the read-back RPC remains as defense-in-depth). Collision retries are handled
-- inside the generator trigger; codes are UNIQUE-indexed.
--
-- MATCH-BATCH HEARTBEAT (pg_net fire-and-forget mitigation)
-- ---------------------------------------------------------
-- matching_batch_runs records every scheduled matching pass: the scheduler
-- wrapper inserts a 'running' row BEFORE invoking the Edge Function and the
-- function updates it to 'success'|'failed' on completion. A separate health
-- check (step 4) flags overdue batches (no success within 3x the configured
-- interval) AND independently scans for incidents stranded past SLA regardless
-- of heartbeat state, so a silently-failed invocation cannot strand a critical
-- incident unnoticed. Both conditions emit notifications + escalations rows.
--
-- GPS DRIFT GUARD
-- ---------------
-- Unit location updates are validated by trigger against a maximum plausible
-- speed (config key 'unit.max_speed_kmh'). An update implying faster-than-
-- physical movement between fixes is rejected (IMPLAUSIBLE_LOCATION_JUMP) and
-- the device retains its last good fix.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron;          -- schedules match-batch + health checks (FR-7)
create extension if not exists pg_net;           -- fire-and-forget HTTP to Edge Functions
create extension if not exists pgcrypto;         -- gen_random_bytes, digest (hash-chained audit)

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
create type public.personnel_role as enum ('dispatcher', 'field', 'hospital_admin', 'admin');

create type public.incident_status as enum (
  'reported', 'triaged', 'dispatched', 'en_route',
  'on_scene', 'transporting', 'resolved', 'closed', 'cancelled'
);

create type public.incident_source as enum ('citizen', 'dispatcher');

create type public.priority_tier as enum ('low', 'medium', 'high', 'critical');
-- Ordering lets us compare tiers directly:
create function public.priority_tier_ord(t public.priority_tier) returns int language sql immutable as $$
  select case t
    when 'low' then 0 when 'medium' then 1 when 'high' then 2 when 'critical' then 3 end;
$$;

create type public.unit_status as enum (
  'available', 'assigned', 'en_route', 'on_scene', 'transporting',
  'offline', 'out_of_service'
);

create type public.claim_status as enum (
  'proposed', 'finalized', 'active', 'completed', 'cancelled', 'rejected'
);

create type public.sync_op_status as enum ('pending', 'applied', 'conflict', 'rejected');

-- ─────────────────────────────────────────────────────────────────────────────
-- CONFIG TABLE (FR-2: scoring/matching/timeouts are data, not hardcoded)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.config (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

insert into public.config (key, value, description) values
  ('triage.scoring', jsonb_build_object(
    'algorithm_version', 'start-mod-1',
    'indicators', jsonb_build_object(
      'walking_wounded',        -20,
      'respiratory_distress',    25,
      'unresponsive',            30,
      'severe_bleeding',         20,
      'chest_pain',              15,
      'traumatic_amputation',    25,
      'burn_majority_body',      25,
      'pediatric_involved',      10,
      'multiple_victims',        10,
      'entrapment',              15),
    'tier_cutoffs', jsonb_build_object('medium', 20, 'high', 45, 'critical', 65)),
   'START-style additive scoring: score = sum(indicator weights); tier_cutoffs maps score to priority_tier (>= medium cutoff => medium, >= high => high, >= critical => critical, else low).'),

  ('matching.batch_interval_seconds', to_jsonb(60), 'How often the batched bipartite matching pass runs (pg_cron schedule).'),
  ('matching.critical_trigger_enabled', to_jsonb(true), 'If true, a critical-tier incident entering triaged triggers an immediate incremental match pass.'),
  ('matching.max_candidates_per_incident', to_jsonb(15), 'Cap eligible units considered per incident (nearest K) to bound Hungarian algorithm size.'),
  ('matching.weights', jsonb_build_object(
     'distance', 0.50, 'capability_penalty', 0.20, 'capacity_deficit', 0.15, 'active_load', 0.15),
   'Cost-matrix weights for weighted bipartite assignment (sum to 1.0).'),

  ('escalation.triaged_timeout_seconds', to_jsonb(600), 'Incident sitting in triaged with no live claim beyond this is auto-escalated (FR-7).'),
  ('escalation.health_check_interval_seconds', to_jsonb(300), 'Interval for matching-health / stranding check cron.'),
  ('escalation.overdue_batch_multiplier', to_jsonb(3), 'Batch is overdue when now - last_success > multiplier * batch_interval.'),

  ('unit.max_speed_kmh', to_jsonb(160), 'Plausibility ceiling for consecutive GPS fixes; faster implied movement is rejected as drift.'),
  ('eta.default_speed_kmh', to_jsonb(45), 'Free-tier haversine ETA provider speed factor (pluggable interface, P2).'),

  ('sync.clock_skew_tolerance_seconds', to_jsonb(300), 'Client timestamps deviating more than this from server time use server ordering.'),
  ('rate_limits.citizen_create_per_hour', to_jsonb(5), 'Per-IP citizen incident creation limit (fixed window).'),
  ('rate_limits.tracking_lookup_per_hour', to_jsonb(20), 'Per-IP tracking-code lookup limit (defense-in-depth).')
on conflict (key) do nothing;

create function public.get_config(p_key text) returns jsonb
language sql stable security definer set search_path = public, extensions as
$$ select value from public.config where key = p_key $$;
-- SECURITY DEFINER: config is world-readable by design (weights are not secret);
-- definer avoids granting SELECT on config to anon and keeps RLS simple.

-- Scalar convenience accessor: works for bare numeric/bool/json scalars.
create function public.get_config_num(p_key text, p_default numeric default null)
returns numeric
language sql stable security definer set search_path = public, extensions as
$$ select coalesce(nullif(public.get_config(p_key) #>> '{}', ''), p_default::text)::numeric $$;

create function public.get_config_bool(p_key text, p_default boolean default false)
returns boolean
language sql stable security definer set search_path = public, extensions as
$$ select coalesce(nullif(public.get_config(p_key) #>> '{}', ''), p_default::text)::boolean $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CORE TABLES
-- ─────────────────────────────────────────────────────────────────────────────
create table public.agencies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

-- Linked 1:1 to a Supabase auth user. The PK *is* the auth user id.
create table public.personnel (
  id          uuid primary key references auth.users(id) on delete cascade,
  agency_id   uuid not null references public.agencies(id),
  role        public.personnel_role not null,
  full_name   text,
  phone       text,
  locale      text not null default 'en' check (locale in ('en', 'es')),  -- FR-13
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index personnel_agency_idx on public.personnel (agency_id);

create table public.units (
  id             uuid primary key default gen_random_uuid(),
  agency_id      uuid not null references public.agencies(id),
  callsign       text not null,
  unit_type      text not null default 'ambulance',   -- ambulance | fire | rescue | ...
  capabilities   text[] not null default '{}',        -- e.g. {als,bls,bariatric,critical_care}
  capacity       int not null default 1 check (capacity > 0),
  status         public.unit_status not null default 'available',
  current_lat    double precision,
  current_lng    double precision,
  -- Generated spatial column keeps geometry consistent with lat/lng writes:
  location       geography(point, 4326) generated always as (
                   case when current_lat is null or current_lng is null then null
                        else ST_SetSRID(ST_MakePoint(current_lng, current_lat), 4326)::geography end
                 ) stored,
  last_fix_at    timestamptz not null default now(),
  last_status_change_at timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (agency_id, callsign)
);
create index units_agency_status_idx on public.units (agency_id, status);
create index units_location_idx      on public.units using gist (location);

create table public.hospitals (
  id                      uuid primary key default gen_random_uuid(),
  agency_id               uuid not null references public.agencies(id),
  name                    text not null,
  current_lat             double precision not null,
  current_lng             double precision not null,
  location                geography(point, 4326) generated always as (
                            ST_SetSRID(ST_MakePoint(current_lng, current_lat), 4326)::geography
                          ) stored,
  total_beds              int not null check (total_beds >= 0),
  beds_available          int not null check (beds_available >= 0 and beds_available <= total_beds),
  diversion               boolean not null default false,       -- FR-10
  diversion_reason        text,
  diversion_updated_at    timestamptz,
  last_capacity_update_at timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index hospitals_agency_idx     on public.hospitals (agency_id);
create index hospitals_diversion_idx  on public.hospitals (diversion) where diversion;
create index hospitals_location_idx   on public.hospitals using gist (location);

create table public.incidents (
  id             uuid primary key default gen_random_uuid(),
  agency_id      uuid not null references public.agencies(id),
  tracking_code  text not null unique,                -- see entropy comment above
  status         public.incident_status not null default 'reported',
  priority_tier  public.priority_tier not null default 'medium',
  source         public.incident_source not null,
  description    text not null,
  -- Sanitization: raw user text is stripped of control characters by trigger
  -- (sanitize_text below) before storage; display-side escaping is React-native.
  location       geography(point, 4326) generated always as (
                   ST_SetSRID(ST_MakePoint(current_lng, current_lat), 4326)::geography
                 ) stored,
  current_lat    double precision not null,           -- FR-1: location REQUIRED
  current_lng    double precision not null,
  photo_path     text,                                -- private storage bucket path
  reporter_ref   text,                                -- optional non-PII callback ref
  created_by     uuid references auth.users(id) on delete set null,  -- null => citizen
  escalation_count int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  triaged_at     timestamptz,
  dispatched_at  timestamptz,
  closed_at      timestamptz
);
create index incidents_agency_status_idx on public.incidents (agency_id, status);
create index incidents_status_open_idx   on public.incidents (status)
  where status in ('reported', 'triaged', 'dispatched');
create index incidents_location_idx      on public.incidents using gist (location);
create index incidents_created_at_idx    on public.incidents (created_at desc);

create table public.triage_scores (
  id                 uuid primary key default gen_random_uuid(),
  incident_id        uuid not null references public.incidents(id) on delete cascade,
  computed_score     numeric not null,
  computed_tier      public.priority_tier not null,
  override_score     numeric,                          -- retained, never overwritten (FR-2)
  override_tier      public.priority_tier,
  scored_by          uuid references auth.users(id) on delete set null,
  algorithm_version  text not null,
  vitals             jsonb,                            -- resp/perfusion/mental etc.
  source             text not null default 'auto'
                       check (source in ('auto', 'field', 'dispatcher')),
  client_mutation_id uuid,                             -- offline-sync idempotency (FR-8)
  created_at         timestamptz not null default now()
);
create index triage_scores_incident_idx on public.triage_scores (incident_id, created_at desc);

create table public.resource_claims (
  id                      uuid primary key default gen_random_uuid(),
  incident_id             uuid not null references public.incidents(id) on delete cascade,
  unit_id                 uuid not null references public.units(id),
  is_primary              boolean not null default true,
  status                  public.claim_status not null default 'proposed',
  proposed_by             text not null default 'auto_matcher'
                            check (proposed_by in ('auto_matcher', 'dispatcher', 'field')),
  claimed_by              uuid references auth.users(id) on delete set null,
  destination_hospital_id uuid references public.hospitals(id) on delete set null,
  created_at              timestamptz not null default now(),
  finalized_at            timestamptz,
  completed_at            timestamptz
);
-- ── FR-6 GUARANTEES (partial unique indexes — the DB-level backstop) ─────────
-- One LIVE claim per unit: the double-dispatch backstop. Historical rows
-- (completed/cancelled/rejected) do not participate, so a unit can be reused.
create unique index claims_unit_live_unique on public.resource_claims (unit_id)
  where status in ('proposed', 'finalized', 'active');
-- One live PRIMARY claim per incident: prevents two matcher runs (or two
-- dispatchers) assigning the same incident concurrently. Secondary support
-- units remain possible (is_primary = false).
create unique index claims_incident_live_primary_unique on public.resource_claims (incident_id)
  where is_primary and status in ('proposed', 'finalized', 'active');
create index claims_incident_idx  on public.resource_claims (incident_id);
create index claims_unit_idx      on public.resource_claims (unit_id);

create table public.escalations (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references public.incidents(id) on delete cascade,
  triggered_by  text not null default 'timeout' check (triggered_by in ('timeout', 'manual')),
  previous_tier public.priority_tier,
  new_tier      public.priority_tier not null,
  action_taken  text not null,
  created_at    timestamptz not null default now()
);
create index escalations_incident_idx on public.escalations (incident_id);

-- APPEND-ONLY AUDIT LOG (FR-11). No FKs by design: history outlives source rows.
-- Hash chain (P2): row_hash = sha256(prev_hash || ts || actor || table || row ||
-- op || before || after). Chain head verified by verify_audit_chain() in 0003.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor       uuid references auth.users(id) on delete set null,
  actor_role  text,
  table_name  text not null,
  row_id      text not null,
  operation   text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  before      jsonb,
  after       jsonb,
  prev_hash   text,
  row_hash    text not null
);
create index audit_log_table_row_idx on public.audit_log (table_name, row_id, id);
create index audit_log_time_idx      on public.audit_log (occurred_at desc);

-- Server-side mirror of offline client mutations (FR-8 reconciliation ledger).
create table public.sync_queue (
  id                 uuid primary key default gen_random_uuid(),
  client_mutation_id uuid not null unique,            -- idempotency key from device
  personnel_id       uuid references public.personnel(id) on delete set null,
  entity             text not null,                   -- 'incidents' | 'triage_scores' | ...
  entity_id          uuid,
  op                 text not null check (op in ('INSERT', 'UPDATE')),
  payload            jsonb not null,
  client_version     int,                             -- logical clock marker
  client_timestamp   timestamptz,                     -- device clock (skew-tolerated)
  status             public.sync_op_status not null default 'pending',
  conflict_detail    jsonb,                           -- surfaced to user when status='conflict'
  received_at        timestamptz not null default now(),
  applied_at         timestamptz
);
create index sync_queue_personnel_status_idx on public.sync_queue (personnel_id, status);

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid not null references public.agencies(id),
  recipient_user  uuid references auth.users(id) on delete cascade,  -- null => role broadcast
  target_role     public.personnel_role,
  incident_id     uuid references public.incidents(id) on delete cascade,
  type            text not null,                      -- 'escalation'|'diversion'|'claim_conflict'|...
  title           text not null,
  body            text,
  channel         text not null default 'in_app' check (channel in ('in_app', 'webhook', 'both')),
  delivery_status text not null default 'pending'
                    check (delivery_status in ('pending', 'sent', 'failed')),
  payload         jsonb,
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);
create index notifications_agency_created_idx on public.notifications (agency_id, created_at desc);
create index notifications_recipient_idx      on public.notifications (recipient_user, read_at)
  where read_at is null;

-- Heartbeat for pg_net-invoked matching passes (see header comment).
create table public.matching_batch_runs (
  id             bigint generated always as identity primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'success', 'failed', 'timeout')),
  incidents_open int,
  pairs_proposed int,
  pairs_applied  int,
  error_detail   text
);
create index matching_runs_status_idx on public.matching_batch_runs (started_at desc);

-- Fixed-window rate limiter used inside SECURITY DEFINER RPCs (citizen paths).
create table public.rate_limits (
  key          text primary key,                      -- e.g. 'ip:203.0.113.9:citizen_create'
  window_start timestamptz not null default now(),
  count        int not null default 0
);

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER FUNCTIONS (identity resolution for RLS + business logic)
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER helpers avoid recursive RLS evaluation on personnel.
-- search_path pinned to prevent search-path hijacking (OWASP: SQL injection /
-- privilege confusion hardening).

create function public.current_personnel_row()
returns public.personnel
language sql stable security definer set search_path = public, extensions as
$$
  select p.* from public.personnel p where p.id = auth.uid();
$$;

create function public.current_personnel_role()
returns public.personnel_role
language sql stable security definer set search_path = public, extensions as
$$
  select role from public.personnel where id = auth.uid();
$$;

create function public.current_agency_id()
returns uuid
language sql stable security definer set search_path = public, extensions as
$$
  select agency_id from public.personnel where id = auth.uid();
$$;

create function public.is_admin()
returns boolean
language sql stable security definer set search_path = public, extensions as
$$
  select coalesce((select role = 'admin' from public.personnel where id = auth.uid()), false);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TEXT SANITIZATION (Security NFR): strip control/invisible chars from
-- user-submitted text before storage. Rendering stays React-escaped.
-- ─────────────────────────────────────────────────────────────────────────────
create function public.sanitize_text(t text) returns text
language plpgsql immutable as $$
declare
  -- Control chars (C0 minus \n \t, plus DEL and C1) and invisible/bidi-injection
  -- Unicode (ZWSP, ZWNJ, ZWJ, LRM, RLM, LS, PS, BOM). Built via chr() so the
  -- migration file stays ASCII-clean and portable across editors.
  pattern text :=
       '[' || chr(1)   || '-' || chr(8)
    ||       chr(11)  || chr(12)
    ||       chr(14)  || '-' || chr(31)
    ||       chr(127) || '-' || chr(159)
    ||       chr(8203) || chr(8204) || chr(8205)
    ||       chr(8206) || chr(8207)
    ||       chr(8232) || chr(8233)
    ||       chr(65279) || ']';
  cleaned text;
begin
  if t is null then return null; end if;
  cleaned := regexp_replace(t, pattern, '', 'g');
  return btrim(cleaned);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRACKING CODE GENERATOR (see header entropy analysis)
-- Unbiased rejection sampling: accept byte b only when b < 248 (= 4 * 62),
-- emit chr(b % 62) mapped onto the 62-char alphabet.
-- ─────────────────────────────────────────────────────────────────────────────
create function public.generate_tracking_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  bytes   bytea;
  b       int;
  i       int;
  code    text;
begin
  loop
    code := '';
    bytes := gen_random_bytes(32);
    for i in 1 .. octet_length(bytes) loop
      exit when length(code) >= 22;
      b := get_byte(bytes, i - 1);
      continue when b >= 248;               -- rejection sample: keep distribution uniform
      code := code || substr(alphabet, (b % 62) + 1, 1);
    end loop;
    exit when length(code) = 22;
    -- ran out of bytes before 22 accepted chars (vanishingly unlikely) -> resample
  end loop;
  return code;
end $$;

create function public.assign_tracking_code()
returns trigger language plpgsql volatile as $$
begin
  if new.tracking_code is null or new.tracking_code = '' then
    loop
      new.tracking_code := public.generate_tracking_code();
      exit when not exists (
        select 1 from public.incidents i where i.tracking_code = new.tracking_code
      );
    end loop;
  end if;
  return new;
end $$;

create trigger trg_assign_tracking_code
  before insert on public.incidents
  for each row execute function public.assign_tracking_code();

-- ─────────────────────────────────────────────────────────────────────────────
-- SANITIZATION TRIGGER on user-text columns
-- ─────────────────────────────────────────────────────────────────────────────
create function public.sanitize_incident_text()
returns trigger language plpgsql volatile as $$
begin
  new.description := public.sanitize_text(new.description);
  new.reporter_ref := public.sanitize_text(new.reporter_ref);
  return new;
end $$;

create trigger trg_sanitize_incident
  before insert or update on public.incidents
  for each row execute function public.sanitize_incident_text();

-- ─────────────────────────────────────────────────────────────────────────────
-- FR-5 STATE MACHINE — enforced at DATABASE layer (invalid transitions rejected
-- here, not merely hidden in UI).
-- Allowed transitions:
--   reported     -> triaged | cancelled
--   triaged      -> dispatched | cancelled
--   dispatched   -> en_route | cancelled
--   en_route     -> on_scene | cancelled
--   on_scene     -> transporting | cancelled
--   transporting -> resolved
--   resolved     -> closed
--   cancelled/closed are terminal.
-- ─────────────────────────────────────────────────────────────────────────────
create function public.enforce_incident_state_machine()
returns trigger language plpgsql volatile as $$
declare
  allowed public.incident_status[] := array[
    'triaged', 'dispatched', 'en_route', 'on_scene',
    'transporting', 'resolved', 'closed', 'cancelled']::public.incident_status[];
begin
  if new.status = old.status then
    return new;
  end if;

  if not (new.status = any(allowed)) then
    raise exception 'INVALID_TRANSITION: unknown target status %', new.status
      using errcode = 'check_violation';
  end if;

  if not (
    (old.status = 'reported'     and new.status in ('triaged', 'cancelled')) or
    (old.status = 'triaged'      and new.status in ('dispatched', 'cancelled')) or
    (old.status = 'dispatched'   and new.status in ('en_route', 'cancelled')) or
    (old.status = 'en_route'     and new.status in ('on_scene', 'cancelled')) or
    (old.status = 'on_scene'     and new.status in ('transporting', 'cancelled')) or
    (old.status = 'transporting' and new.status = 'resolved') or
    (old.status = 'resolved'     and new.status = 'closed')
  ) then
    raise exception 'INVALID_TRANSITION: % -> % is not permitted', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Maintain lifecycle timestamps
  if new.status = 'triaged'     then new.triaged_at    := coalesce(new.triaged_at, now()); end if;
  if new.status = 'dispatched'  then new.dispatched_at := coalesce(new.dispatched_at, now()); end if;
  if new.status in ('resolved', 'closed', 'cancelled')
                              then new.closed_at     := coalesce(new.closed_at, now()); end if;

  return new;
end $$;

create trigger trg_incident_state_machine
  before update on public.incidents
  for each row execute function public.enforce_incident_state_machine();

-- ─────────────────────────────────────────────────────────────────────────────
-- GPS DRIFT GUARD on units (edge case: implausible location jump)
-- ─────────────────────────────────────────────────────────────────────────────
create function public.guard_unit_location_jump()
returns trigger language plpgsql volatile as $$
declare
  max_kmh  numeric;
  meters   numeric;
  seconds  numeric;
  implied_kmh numeric;
begin
  if new.current_lat is null or new.current_lng is null then
    return new;                                   -- clearing the fix is always allowed
  end if;

  if old.current_lat is not null and old.last_fix_at is not null
     and new.last_fix_at is not null then
    seconds := greatest(extract(epoch from (new.last_fix_at - old.last_fix_at)), 1);
    if seconds > 2 then                          -- only judge pairs with meaningful Δt
      meters := ST_Distance(
        ST_SetSRID(ST_MakePoint(old.current_lng, old.current_lat), 4326)::geography,
        ST_SetSRID(ST_MakePoint(new.current_lng, new.current_lat), 4326)::geography);
      max_kmh := public.get_config_num('unit.max_speed_kmh', 160);
      implied_kmh := (meters / seconds) * 3.6;
      if implied_kmh > max_kmh then
        raise exception 'IMPLAUSIBLE_LOCATION_JUMP: % km/h between fixes (limit %)',
          round(implied_kmh::numeric, 1), max_kmh
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger trg_unit_gps_guard
  before update on public.units
  for each row execute function public.guard_unit_location_jump();

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at maintenance
-- ─────────────────────────────────────────────────────────────────────────────
create function public.touch_updated_at()
returns trigger language plpgsql volatile as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_touch_personnel before update on public.personnel
  for each row execute function public.touch_updated_at();
create trigger trg_touch_units before update on public.units
  for each row execute function public.touch_updated_at();
create trigger trg_touch_hospitals before update on public.hospitals
  for each row execute function public.touch_updated_at();
create trigger trg_touch_incidents before update on public.incidents
  for each row execute function public.touch_updated_at();

-- Hospital capacity freshness (drives matching staleness decisions in 0003)
create function public.touch_capacity_ts()
returns trigger language plpgsql volatile as $$
begin
  if new.beds_available is distinct from old.beds_available
     or new.total_beds is distinct from old.total_beds then
    new.last_capacity_update_at := now();
  end if;
  return new;
end $$;

create trigger trg_touch_capacity before update on public.hospitals
  for each row execute function public.touch_capacity_ts();
