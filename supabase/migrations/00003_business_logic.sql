-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIAGEGRID MIGRATION 0003 — Business logic: audit, scoring, claims, state
-- machine RPCs, diversion propagation, escalation, matching engine wiring
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- STATED ASSUMPTIONS (per meta.role directive — explicit, not silent):
--
-- A1. Auto-dispatch policy: the batched matcher creates claims with status
--     'proposed'. Whether they auto-finalize is controlled by config key
--     'matching.require_dispatcher_review' (default FALSE = auto-dispatch,
--     like real CAD systems). When false, dispatchers can still manually
--     override any match at any time (FR-4); when true, every proposal queues
--     for explicit dispatcher accept/reject before an incident is dispatched.
--
-- A2. Error contract: every catchable domain error uses SQLSTATE class 'TG%'
--     with a stable token prefix in the message:
--       TG100 UNIT_ALREADY_CLAIMED        TG101 UNIT_UNAVAILABLE
--       TG102 INCIDENT_NOT_DISPATCHABLE   TG103 INCIDENT_ALREADY_CLAIMED
--       TG104 HOSPITAL_ON_DIVERSION       TG105 HOSPITAL_AT_CAPACITY
--       TG106 NOT_AUTHORIZED              TG107 INVALID_TRANSITION_ROLE
--       TG108 NOT_FOUND                   TG109 RATE_LIMITED
--       TG110 VALIDATION_FAILED           TG111 DUPLICATE_INCIDENT
--     Clients branch on message token; PostgREST surfaces code+message.
--
-- A3. Audit hash-chain serialization: chain integrity requires a total order,
--     so the audit writer takes pg_advisory_xact_lock(7492381) around
--     read-prev-hash + insert. This serializes audited writes at COMMIT scope.
--     Tradeoff documented deliberately: auditability > write concurrency at
--     free-tier scale (tens of incidents/hour, not thousands/sec).
--
-- A4. Escalation sweep runs every minute via pg_cron but internally honors
--     'escalation.triaged_timeout_seconds'; the cron interval is a ceiling on
--     detection latency, not the SLA itself.
--
-- A5. Clock skew (edge case): ALL server-side ordering/idempotency decisions
--     use server time (now()). Client timestamps are stored for forensics only
--     and never compared against server time except via the generous
--     'sync.clock_skew_tolerance_seconds' window during offline reconciliation.
--
-- A6. Duplicate citizen reports (edge case): two layers — (a) client-generated
--     idempotency key stored as incidents.client_mutation_id (unique partial
--     index) returns the ORIGINAL tracking code on retry; (b) keyless retries
--     from flaky connections are absorbed by spatial-temporal dedupe (same IP,
--     <100m, <15min, similar description) which also returns the original code.
--
-- A7. Rapid diversion toggle (edge case): each toggle is an independent event;
--     reroute notifications carry event timestamps and the CURRENT diversion
--     state is re-read by the unit's client when it processes the notification,
--     so off→on within seconds yields notifications that always reflect final
--     truth when acted upon.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Idempotency anchor for citizen intake (A6a)
alter table public.incidents
  add column if not exists client_mutation_id uuid;
create unique index if not exists incidents_client_mutation_id_unique
  on public.incidents (client_mutation_id) where client_mutation_id is not null;

-- Config additions used below (idempotent seeds)
insert into public.config (key, value, description) values
  ('matching.require_dispatcher_review', to_jsonb(false),
   'A1: when true, matcher proposals wait for explicit dispatcher acceptance.'),
  ('routing.default_agency_id', 'null'::jsonb,
   'Agency for citizen reports; null = first agency by created_at.'),
  ('functions.match_batch_url', to_jsonb('http://kong:8000/functions/v1/match-batch'::text),
   'Edge Function endpoint invoked via pg_net from inside the DB network.'),
  ('functions.match_batch_secret', to_jsonb('change-me-via-secrets'::text),
   'Shared secret header checked by the Edge Function.')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- SERVICE CONTEXT HELPER: Edge Functions / server routes call with the service
-- role key; these paths are server-mediated and trusted (never client-reachable
-- without possession of the server secret).
-- ─────────────────────────────────────────────────────────────────────────────
create function public.is_service_context() returns boolean
language sql stable security definer set search_path = public, extensions as
$$
  select coalesce(current_setting('role', true), '') in ('service_role', 'postgres')
     or coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '')
        = 'service_role';
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-11 HASH-CHAINED AUDIT LOG
-- Writer is SECURITY DEFINER: triggers fire with invoker privileges, and no
-- application role holds INSERT on audit_log. Chain order enforced via
-- advisory lock (assumption A3).
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_prev_hash text;
  v_row_hash  text;
  v_actor     uuid := auth.uid();
  v_role      text;
  v_before    jsonb;
  v_after     jsonb;
  v_row_id    text;
  v_ts        timestamptz;
begin
  v_role := (select role::text from public.personnel where id = v_actor);

  if tg_op = 'DELETE' then
    v_before := to_jsonb(old);  v_row_id := (old.id)::text;
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);  v_after := to_jsonb(new);
    v_row_id := (new.id)::text;
    -- Skip no-op saves (touch_updated_at firing alone)
    if v_before is not distinct from v_after then
      return coalesce(new, old);
    end if;
  else
    v_after := to_jsonb(new);   v_row_id := (new.id)::text;
  end if;

  perform pg_advisory_xact_lock(7492381);

  select row_hash into v_prev_hash
  from public.audit_log order by id desc limit 1;

  -- Hash the EXACT timestamp that will be stored (not a second clock read),
  -- pinned to UTC so verifier sessions in other timezones recompute identically.
  v_ts := clock_timestamp();

  v_row_hash := encode(
    digest(concat_ws('|',
      coalesce(v_prev_hash, 'GENESIS'),
      to_char(v_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      coalesce(v_actor::text, ''),
      coalesce(v_role, ''),
      tg_table_name, v_row_id, tg_op,
      coalesce(v_before::text, ''), coalesce(v_after::text, '')
    ), 'sha256'), 'hex');

  insert into public.audit_log
    (occurred_at, actor, actor_role, table_name, row_id, operation,
     before, after, prev_hash, row_hash)
  values
    (v_ts, v_actor, v_role, tg_table_name, v_row_id, tg_op,
     v_before, v_after, v_prev_hash, v_row_hash);

  return coalesce(new, old);
end $$;

-- Attach AFTER triggers to every FR-11 table. Statement-level ROW_COUNT ops
-- still emit per-row events (FOR EACH ROW), preserving full reconstruction.
create trigger trg_audit_incidents
  after insert or update or delete on public.incidents
  for each row execute function public.audit_row_change();
create trigger trg_audit_resource_claims
  after insert or update or delete on public.resource_claims
  for each row execute function public.audit_row_change();
create trigger trg_audit_triage_scores
  after insert or update or delete on public.triage_scores
  for each row execute function public.audit_row_change();
create trigger trg_audit_hospitals
  after insert or update or delete on public.hospitals
  for each row execute function public.audit_row_change();

-- Chain verifier: recomputes every link; returns any rows whose stored hash
-- does not match the recomputation (tamper evidence, P2).
create function public.verify_audit_chain(p_from_id bigint default 0)
returns table (broken_at bigint, reason text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  r record;
  v_prev text := null;
  v_expect text;
  v_ts timestamptz;
begin
  for r in
    select * from public.audit_log where id >= p_from_id order by id
  loop
    if v_prev is distinct from r.prev_hash then
      broken_at := r.id;
      reason := format('chain break: expected prev_hash %s got %s', v_prev, r.prev_hash);
      return next;
    end if;

    v_expect := encode(digest(concat_ws('|',
      coalesce(r.prev_hash, 'GENESIS'),
      to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      coalesce(r.actor::text, ''), coalesce(r.actor_role, ''),
      r.table_name, r.row_id, r.operation,
      coalesce(r.before::text, ''), coalesce(r.after::text, '')
    ), 'sha256'), 'hex');

    if v_expect <> r.row_hash then
      broken_at := r.id;
      reason := 'row_hash mismatch (row content altered after write)';
      return next;
    end if;

    v_prev := r.row_hash;
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RATE LIMITER (fixed window, atomic upsert)
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.check_rate_limit(
  p_scope text, p_identifier text, p_limit int, p_window_seconds int default 3600
) returns boolean
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_key text := p_scope || ':' || p_identifier;
  v_allowed boolean;
begin
  insert into public.rate_limits as rl (key, window_start, count)
  values (v_key, now(), 1)
  on conflict (key) do update set
    count = case
      when rl.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else rl.count + 1 end,
    window_start = case
      when rl.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else rl.window_start end
  returning (case when count <= p_limit then true else false end)
  into v_allowed;
  return v_allowed;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-2 TRIAGE SCORING (rule-based, config-driven — weights live in config)
-- Modified START-style additive model over boolean/numeric severity indicators.
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.compute_triage_score(p_indicators jsonb)
returns table (score numeric, tier public.priority_tier, algorithm_version text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  cfg        jsonb := public.get_config('triage.scoring');
  v_weights  jsonb := cfg -> 'indicators';
  v_cutoffs  jsonb := cfg -> 'tier_cutoffs';
  k          text;
  v          jsonb;
  v_score    numeric := 0;
begin
  if p_indicators is null then p_indicators := '{}'::jsonb; end if;

  for k, v in select * from jsonb_each(p_indicators) loop
    -- Indicator counts when numeric (e.g. multiple_victims: 3), boolean otherwise
    if jsonb_typeof(v) = 'boolean' and v = 'true'::jsonb then
      v_score := v_score + coalesce((v_weights ->> k)::numeric, 0);
    elsif jsonb_typeof(v) = 'number' and v::numeric > 0 then
      v_score := v_score + coalesce((v_weights ->> k)::numeric, 0) * least(v::numeric, 5);
    end if;
  end loop;

  return query select v_score,
    case
      when v_score >= coalesce((v_cutoffs ->> 'critical')::numeric, 65) then 'critical'::public.priority_tier
      when v_score >= coalesce((v_cutoffs ->> 'high')::numeric, 45)      then 'high'::public.priority_tier
      when v_score >= coalesce((v_cutoffs ->> 'medium')::numeric, 20)    then 'medium'::public.priority_tier
      else 'low'::public.priority_tier
    end,
    coalesce(cfg ->> 'algorithm_version', 'start-mod-1');
end $$;

-- Apply computed score to an incident (internal helper, caller wraps txn)
create function public.apply_triage_score(
  p_incident_id uuid, p_indicators jsonb, p_source text, p_scored_by uuid default null
) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_res record;
begin
  select * into v_res from public.compute_triage_score(p_indicators);

  insert into public.triage_scores
    (incident_id, computed_score, computed_tier, scored_by, algorithm_version,
     vitals, source)
  values
    (p_incident_id, v_res.score, v_res.tier, p_scored_by, v_res.algorithm_version,
     p_indicators, p_source);

  update public.incidents
  set priority_tier = v_res.tier
  where id = p_incident_id and priority_tier <> v_res.tier;
end $$;

-- Dispatcher/field override — retains computed values, never overwrites them.
create function public.override_triage(p_incident_id uuid, p_override_score numeric)
returns public.priority_tier
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_role public.personnel_role := public.current_personnel_role();
  v_agency uuid := public.current_agency_id();
  v_target public.triage_scores;
  v_new_tier public.priority_tier;
begin
  if p_override_score is null or p_override_score < -100 or p_override_score > 200 then
    raise exception 'VALIDATION_FAILED: override score out of range'
      using errcode = 'TG110';
  end if;

  -- Dispatcher/admin override anywhere in agency; field only on own incidents
  if v_role = 'dispatcher' then
    if not exists (select 1 from public.incidents i
                   where i.id = p_incident_id and i.agency_id = v_agency) then
      raise exception 'NOT_FOUND: incident not in caller agency'
        using errcode = 'TG108';
    end if;
  elsif v_role = 'admin' then
    null;
  elsif v_role = 'field' and public.is_assigned_to_incident(p_incident_id) then
    null;
  else
    raise exception 'NOT_AUTHORIZED: triage override requires dispatcher or assigned field role'
      using errcode = 'TG106';
  end if;

  select * into v_target from public.triage_scores
  where incident_id = p_incident_id order by created_at desc limit 1;

  if v_target.id is null then
    perform public.apply_triage_score(p_incident_id, '{}'::jsonb, 'dispatcher', auth.uid());
    select * into v_target from public.triage_scores
    where incident_id = p_incident_id order by created_at desc limit 1;
  end if;

  -- Computed values are NEVER touched; only the override pair is written (FR-2)
  update public.triage_scores set override_score = p_override_score
  where id = v_target.id;

  v_new_tier := case
    when p_override_score >= 65 then 'critical'::public.priority_tier
    when p_override_score >= 45 then 'high'::public.priority_tier
    when p_override_score >= 20 then 'medium'::public.priority_tier
    else 'low'::public.priority_tier end;

  update public.triage_scores set override_tier = v_new_tier where id = v_target.id;
  update public.incidents set priority_tier = v_new_tier where id = p_incident_id;

  return v_new_tier;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-1 CITIZEN INTAKE + DISPATCHER CREATION (rate-limited, dedupe, auto-triage)
-- Callable via PostgREST rpc by anon — rate limiting + validation make that
-- safe; the /api/incidents server route remains the primary client path and
-- passes the real client IP (x-forwarded-for) for accurate limiting.
-- ═══════════════════════════════════════════════════════════════════════════════

create function public.create_citizen_incident(
  p_description text,
  p_lat double precision,
  p_lng double precision,
  p_reporter_ref text default null,
  p_photo_path text default null,
  p_indicators jsonb default '{}'::jsonb,
  p_idempotency_key uuid default null,
  p_client_ip text default 'unknown'
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_limit int := coalesce(public.get_config_num('rate_limits.citizen_create_per_hour', 5), 5)::int;
  v_agency uuid;
  v_existing uuid;
  v_incident public.incidents;
  v_out jsonb;
  v_desc text := left(coalesce(public.sanitize_text(p_description), ''), 4000);
begin
  -- Validation (FR-1: location REQUIRED)
  if v_desc is null or length(v_desc) < 3 then
    raise exception 'VALIDATION_FAILED: description required (min 3 chars)'
      using errcode = 'TG110';
  end if;
  if p_lat is null or p_lng is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'VALIDATION_FAILED: valid geolocation required'
      using errcode = 'TG110';
  end if;

  -- Rate limit per IP (OWASP: abuse prevention on unauthenticated surface)
  if not public.check_rate_limit('citizen_create', p_client_ip, v_limit, 3600) then
    raise exception 'RATE_LIMITED: too many reports from this address'
      using errcode = 'TG109';
  end if;

  -- Dedupe layer A: idempotency key replay returns original submission
  if p_idempotency_key is not null then
    select id into v_existing from public.incidents
    where client_mutation_id = p_idempotency_key;
    if v_existing is not null then
      select to_jsonb(i) - 'location' - 'current_lat' - 'current_lng'
        into v_out from public.incidents i where id = v_existing;
      return jsonb_build_object('duplicate', true, 'incident', v_out);
    end if;
  end if;

  -- Dedupe layer B: same IP, nearby, recent, similar description
  select i.id into v_existing
  from public.incidents i
  where i.created_by is null
    and i.created_at > now() - interval '15 minutes'
    and i.description = v_desc
    and ST_DWithin(ST_SetSRID(ST_MakePoint(i.current_lng, i.current_lat), 4326)::geography,
                   ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, 100)
  order by i.created_at desc limit 1;
  if v_existing is not null then
    select to_jsonb(i) - 'location' - 'current_lat' - 'current_lng'
      into v_out from public.incidents i where id = v_existing;
    return jsonb_build_object('duplicate', true, 'incident', v_out);
  end if;

  -- Agency resolution
  select coalesce(nullif(public.get_config('routing.default_agency_id') #>> '{}', '')::uuid,
                  (select id from public.agencies order by created_at limit 1))
    into v_agency;
  if v_agency is null then
    raise exception 'VALIDATION_FAILED: no agency provisioned'
      using errcode = 'TG110';
  end if;

  insert into public.incidents
    (agency_id, status, source, description, current_lat, current_lng,
     photo_path, reporter_ref, client_mutation_id)
  values
    (v_agency, 'reported', 'citizen', v_desc, p_lat, p_lng,
     p_photo_path, public.sanitize_text(p_reporter_ref), p_idempotency_key)
  returning * into v_incident;

  -- Auto-triage on creation (FR-2), advancing reported -> triaged
  perform public.apply_triage_score(v_incident.id, p_indicators, 'auto');
  update public.incidents set status = 'triaged' where id = v_incident.id;

  select to_jsonb(i) - 'location' - 'current_lat' - 'current_lng'
    into v_out from public.incidents i where id = v_incident.id;
  return jsonb_build_object('duplicate', false, 'incident', v_out);
end $$;

-- Dispatcher-authenticated creation (RLS INSERT policy also applies on direct
-- inserts; this RPC adds auto-triage convenience for console submissions).
create function public.create_dispatcher_incident(
  p_description text, p_lat double precision, p_lng double precision,
  p_indicators jsonb default '{}'::jsonb
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_agency uuid := public.current_agency_id();
  v_role   public.personnel_role := public.current_personnel_role();
  v_incident public.incidents;
  v_desc text := left(coalesce(public.sanitize_text(p_description), ''), 4000);
begin
  if v_role not in ('dispatcher', 'admin') then
    raise exception 'NOT_AUTHORIZED: dispatcher role required' using errcode = 'TG106';
  end if;
  if v_desc is null or length(v_desc) < 3
     or p_lat is null or p_lng is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'VALIDATION_FAILED: description and valid location required'
      using errcode = 'TG110';
  end if;

  insert into public.incidents
    (agency_id, status, source, description, current_lat, current_lng, created_by)
  values (v_agency, 'reported', 'dispatcher', v_desc, p_lat, p_lng, auth.uid())
  returning * into v_incident;

  perform public.apply_triage_score(v_incident.id, p_indicators, 'dispatcher', auth.uid());
  update public.incidents set status = 'triaged' where id = v_incident.id;

  return to_jsonb(v_incident) - 'location';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-6 CONCURRENCY-SAFE CLAIM ARBITRATION
-- Locking order everywhere: unit FOR UPDATE first, THEN incident FOR UPDATE.
-- All claim paths (manual dispatcher, field self-dispatch, auto-matcher apply)
-- funnel through try_claim_pair() so contention resolves identically.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Internal single-pair attempt. Returns claim id, or raises typed errors.
-- p_auto_finalize: create as 'finalized' (dispatch immediately) vs 'proposed'.
create function public.try_claim_pair(
  p_unit_id uuid, p_incident_id uuid, p_proposed_by text,
  p_auto_finalize boolean, p_claimant uuid default null
) returns uuid
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_unit public.units;
  v_incident public.incidents;
  v_claim_id uuid;
begin
  -- Serialize all claim attempts per-unit (FR-6 mechanism #1)
  select * into v_unit from public.units where id = p_unit_id for update;
  if v_unit.id is null then
    raise exception 'UNIT_ALREADY_CLAIMED: unit % not found', p_unit_id
      using errcode = 'TG108';
  end if;

  if v_unit.status not in ('available') then
    raise exception 'UNIT_ALREADY_CLAIMED: unit % is %', v_unit.callsign, v_unit.status
      using errcode = 'TG100';
  end if;

  select * into v_incident from public.incidents where id = p_incident_id for update;
  if v_incident.id is null then
    raise exception 'INCIDENT_NOT_DISPATCHABLE: incident % not found', p_incident_id
      using errcode = 'TG108';
  end if;
  if v_incident.status <> 'triaged' then
    raise exception 'INCIDENT_NOT_DISPATCHABLE: incident status is %',
      v_incident.status using errcode = 'TG102';
  end if;

  begin
    insert into public.resource_claims
      (incident_id, unit_id, is_primary, status, proposed_by, claimed_by,
       finalized_at)
    values
      (p_incident_id, p_unit_id, true,
       case when p_auto_finalize then 'finalized'::public.claim_status
            else 'proposed'::public.claim_status end,
       p_proposed_by, p_claimant,
       case when p_auto_finalize then now() else null end)
    returning id into v_claim_id;
  exception
    when unique_violation then
      if sqlerrm like '%claims_unit_live_unique%' then
        raise exception 'UNIT_ALREADY_CLAIMED: unit has another live claim'
          using errcode = 'TG100';
      elsif sqlerrm like '%claims_incident_live_primary_unique%' then
        raise exception 'INCIDENT_ALREADY_CLAIMED: incident already has a live primary claim'
          using errcode = 'TG103';
      else
        raise;
      end if;
  end;

  if p_auto_finalize then
    update public.incidents set status = 'dispatched' where id = p_incident_id;
    update public.units set status = 'assigned' where id = p_unit_id;
  end if;

  return v_claim_id;
end $$;

-- Public dispatcher/field claim path (role-checked wrapper)
create function public.claim_unit(
  p_incident_id uuid, p_unit_id uuid
) returns uuid
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_role public.personnel_role := public.current_personnel_role();
  v_agency uuid := public.current_agency_id();
  v_unit public.units;
begin
  select * into v_unit from public.units where id = p_unit_id;
  if v_unit.id is null then
    raise exception 'NOT_FOUND: unit' using errcode = 'TG108';
  end if;

  if v_role = 'dispatcher' then
    if v_unit.agency_id <> v_agency then
      raise exception 'NOT_AUTHORIZED: cross-agency claim' using errcode = 'TG106';
    end if;
  elsif v_role = 'admin' then
    null; -- admin may claim anywhere
  elsif v_role = 'field' then
    if v_unit.assigned_to is distinct from auth.uid() then
      raise exception 'NOT_AUTHORIZED: field may claim only their own unit'
        using errcode = 'TG106';
    end if;
  else
    raise exception 'NOT_AUTHORIZED: role cannot claim units' using errcode = 'TG106';
  end if;

  return public.try_claim_pair(p_unit_id, p_incident_id, 'dispatcher', true, auth.uid());
end $$;

-- Matcher-facing pair application (service context only; used by match-batch)
create function public.apply_match_proposals(p_pairs jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  pair jsonb;
  v_applied int := 0;
  v_skipped int := 0;
  v_review boolean := public.get_config_bool('matching.require_dispatcher_review', false);
  v_claim uuid;
begin
  if not public.is_service_context() then
    raise exception 'NOT_AUTHORIZED: service context required' using errcode = 'TG106';
  end if;

  for pair in select * from jsonb_array_elements(p_pairs) loop
    begin
      v_claim := public.try_claim_pair(
        (pair ->> 'unit_id')::uuid,
        (pair ->> 'incident_id')::uuid,
        'auto_matcher',
        not v_review,           -- review mode => keep proposals open
        null);
      v_applied := v_applied + 1;
    exception when others then
      if sqlerrm like 'TG1%' or split_part(sqlerrm, ':', 1) in
         ('UNIT_ALREADY_CLAIMED', 'UNIT_UNAVAILABLE', 'INCIDENT_NOT_DISPATCHABLE',
          'INCIDENT_ALREADY_CLAIMED', 'NOT_FOUND')
      then
        v_skipped := v_skipped + 1;  -- stale proposal; rolls into next batch
      else
        raise;
      end if;
    end;
  end loop;

  return jsonb_build_object('applied', v_applied, 'skipped_stale', v_skipped);
end $$;

-- FR-4 dispatcher accept/reject of proposed matches
create function public.accept_claim(p_claim_id uuid) returns uuid
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_claim public.resource_claims;
  v_unit public.units;
  v_incident public.incidents;
begin
  if public.current_personnel_role() not in ('dispatcher', 'admin') then
    raise exception 'NOT_AUTHORIZED: dispatcher role required' using errcode = 'TG106';
  end if;

  select * into v_claim from public.resource_claims where id = p_claim_id for update;
  if v_claim.id is null then raise exception 'NOT_FOUND: claim' using errcode = 'TG108'; end if;
  if v_claim.status <> 'proposed' then
    raise exception 'INCIDENT_NOT_DISPATCHABLE: claim is %', v_claim.status
      using errcode = 'TG102';
  end if;

  select * into v_unit from public.units where id = v_claim.unit_id for update;
  if v_unit.agency_id <> public.current_agency_id()
     and public.current_personnel_role() <> 'admin' then
    raise exception 'NOT_AUTHORIZED: cross-agency' using errcode = 'TG106';
  end if;
  if v_unit.status <> 'available' then
    raise exception 'UNIT_ALREADY_CLAIMED: unit no longer available'
      using errcode = 'TG100';
  end if;

  select * into v_incident from public.incidents where id = v_claim.incident_id for update;
  if v_incident.status <> 'triaged' then
    raise exception 'INCIDENT_NOT_DISPATCHABLE: incident status is %', v_incident.status
      using errcode = 'TG102';
  end if;

  update public.resource_claims
  set status = 'finalized', finalized_at = now(), claimed_by = auth.uid()
  where id = v_claim.id;
  update public.incidents set status = 'dispatched' where id = v_incident.id;
  update public.units set status = 'assigned' where id = v_unit.id;

  return v_claim.id;
end $$;

create function public.reject_claim(p_claim_id uuid) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_claim public.resource_claims;
begin
  if public.current_personnel_role() not in ('dispatcher', 'admin') then
    raise exception 'NOT_AUTHORIZED: dispatcher role required' using errcode = 'TG106';
  end if;
  select * into v_claim from public.resource_claims where id = p_claim_id for update;
  if v_claim.id is null then raise exception 'NOT_FOUND: claim' using errcode = 'TG108'; end if;
  if v_claim.status <> 'proposed' then
    raise exception 'INCIDENT_NOT_DISPATCHABLE: only proposals can be rejected'
      using errcode = 'TG102';
  end if;
  update public.resource_claims set status = 'rejected' where id = v_claim.id;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-5 STATUS TRANSITION RPC (server-side lifecycle enforcement + side effects)
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.update_incident_status(
  p_incident_id uuid,
  p_new_status public.incident_status,
  p_destination_hospital_id uuid default null,
  p_diversion_ack boolean default false,
  p_capacity_ack boolean default false
) returns public.incident_status
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_role public.personnel_role := public.current_personnel_role();
  v_incident public.incidents;
  v_claim public.resource_claims;
  v_hospital public.hospitals;
begin
  -- Existence check WITHOUT a row lock: the incident lock is taken LAST (via
  -- the state-machine update below) so this function always acquires locks in
  -- the same order as claim_unit (unit/claim -> hospital -> incident),
  -- preventing deadlocks between concurrent claim and status transitions.
  select * into v_incident from public.incidents where id = p_incident_id;
  if v_incident.id is null then raise exception 'NOT_FOUND: incident' using errcode = 'TG108'; end if;

  -- Role gate
  if v_role = 'hospital_admin' then
    raise exception 'INVALID_TRANSITION_ROLE: hospital admins cannot change incident status'
      using errcode = 'TG107';
  end if;
  if v_role = 'field' and not public.is_assigned_to_incident(p_incident_id) then
    raise exception 'NOT_AUTHORIZED: field may update only assigned incidents'
      using errcode = 'TG106';
  end if;
  if v_role = 'field'
     and p_new_status not in ('en_route', 'on_scene', 'transporting', 'resolved') then
    raise exception 'INVALID_TRANSITION_ROLE: field may only advance transport lifecycle'
      using errcode = 'TG107';
  end if;
  if v_role not in ('field', 'dispatcher', 'admin') then
    raise exception 'NOT_AUTHORIZED' using errcode = 'TG106';
  end if;

  select c.* into v_claim
  from public.resource_claims c
  join public.units u on u.id = c.unit_id
  where c.incident_id = p_incident_id
    and c.status in ('finalized', 'active')
    and c.is_primary
  order by c.created_at desc limit 1
  for update of c, u;

  -- Lifecycle side effects
  if p_new_status = 'en_route' then
    if v_claim.id is null then
      raise exception 'INCIDENT_NOT_DISPATCHABLE: no finalized claim' using errcode = 'TG102';
    end if;
    update public.resource_claims set status = 'active' where id = v_claim.id;
    update public.units set status = 'en_route' where id = v_claim.unit_id;

  elsif p_new_status = 'on_scene' then
    update public.units set status = 'on_scene' where id = v_claim.unit_id;

  elsif p_new_status = 'transporting' then
    -- Destination resolution: param wins over claim value
    if p_destination_hospital_id is not null and v_claim.destination_hospital_id
        is distinct from p_destination_hospital_id then
      update public.resource_claims set destination_hospital_id = p_destination_hospital_id
      where id = v_claim.id;
    end if;
    if coalesce(p_destination_hospital_id, v_claim.destination_hospital_id) is null then
      raise exception 'VALIDATION_FAILED: destination hospital required for transport'
        using errcode = 'TG110';
    end if;

    select * into v_hospital from public.hospitals
    where id = coalesce(p_destination_hospital_id, v_claim.destination_hospital_id)
    for update;

    -- FR-10: diversion-aware routing enforcement (catchable, ackable override
    -- reserved to dispatchers for extreme circumstances — e.g. diverting to a
    -- diverted facility is sometimes medically necessary; every ack is audited).
    if v_hospital.diversion and not p_diversion_ack then
      raise exception 'HOSPITAL_ON_DIVERSION: % is on diversion (%). Dispatcher may acknowledge.',
        v_hospital.name, coalesce(v_hospital.diversion_reason, 'no reason given')
        using errcode = 'TG104';
    end if;
    if v_hospital.beds_available <= 0 and not p_capacity_ack then
      raise exception 'HOSPITAL_AT_CAPACITY: % reports 0 beds available',
        v_hospital.name using errcode = 'TG105';
    end if;
    if v_hospital.diversion and p_diversion_ack then
      insert into public.notifications
        (agency_id, target_role, incident_id, type, title, body, channel, payload)
      values
        (v_incident.agency_id, 'dispatcher', p_incident_id, 'diversion_override',
         'Transport to diverted facility acknowledged',
         format('Incident %s routed to %s despite diversion.', v_incident.tracking_code, v_hospital.name),
         'in_app', jsonb_build_object('hospital_id', v_hospital.id));
    end if;

    update public.units set status = 'transporting' where id = v_claim.unit_id;

  elsif p_new_status = 'resolved' then
    update public.resource_claims
    set status = 'completed', completed_at = now() where id = v_claim.id;
    update public.units set status = 'available' where id = v_claim.unit_id;
    -- Patient arrived: consume a bed (floor at zero; capacity truth is the
    -- hospital admin's job — this is arrival accounting, not capacity control).
    if v_claim.destination_hospital_id is not null then
      update public.hospitals
      set beds_available = greatest(beds_available - 1, 0)
      where id = v_claim.destination_hospital_id;
    end if;

  elsif p_new_status = 'cancelled' then
    if v_claim.id is not null then
      update public.resource_claims set status = 'cancelled' where id = v_claim.id;
      update public.units set status = 'available' where id = v_claim.unit_id;
    end if;
  end if;

  -- State machine trigger validates the transition atomically with side effects
  update public.incidents set status = p_new_status where id = p_incident_id;

  return p_new_status;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-10 DIVERSION + CAPACITY (hospital admin only; realtime propagation)
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.toggle_diversion(
  p_hospital_id uuid, p_on boolean, p_reason text default null
) returns boolean
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_role public.personnel_role := public.current_personnel_role();
  v_hospital public.hospitals;
  v_notified int := 0;
  r record;
begin
  if v_role = 'hospital_admin' then
    if not public.is_my_hospital(p_hospital_id) then
      raise exception 'NOT_AUTHORIZED: not your hospital' using errcode = 'TG106';
    end if;
  elsif v_role <> 'admin' then
    raise exception 'NOT_AUTHORIZED: hospital_admin role required' using errcode = 'TG106';
  end if;

  select * into v_hospital from public.hospitals where id = p_hospital_id for update;
  if v_hospital.id is null then raise exception 'NOT_FOUND: hospital' using errcode = 'TG108'; end if;

  update public.hospitals
  set diversion = p_on,
      diversion_reason = case when p_on then public.sanitize_text(p_reason) else null end,
      diversion_updated_at = now(),
      last_capacity_update_at = now()
  where id = p_hospital_id;

  -- FR-10 propagation: notify units mid-transport TOWARD this hospital.
  -- Each event is independent (A7); clients re-read live state on receipt.
  -- Recipient = assigned crew or claimant; if neither is known (auto-matched
  -- claim without roster assignment), broadcast to dispatcher role.
  for r in
    select coalesce(u.assigned_to, c.claimed_by) as crew_user, i.tracking_code
    from public.resource_claims c
    join public.units u on u.id = c.unit_id
    join public.incidents i on i.id = c.incident_id
    where c.destination_hospital_id = p_hospital_id
      and c.status in ('finalized', 'active')
      and i.status = 'transporting'
  loop
    insert into public.notifications
      (agency_id, recipient_user, target_role, incident_id, type, title, body,
       channel, payload)
    values
      (v_hospital.agency_id, r.crew_user,
       case when r.crew_user is null then 'dispatcher'::public.personnel_role else null end,
       null, 'diversion_reroute',
       case when p_on then 'Destination on diversion - consider rerouting'
            else 'Diversion lifted at your destination' end,
       format('Hospital %s: diversion %s.%s', v_hospital.name,
              case when p_on then 'ON' else 'OFF' end,
              case when p_on and p_reason is not null then ' Reason: ' || p_reason else '' end),
       'both',
       jsonb_build_object('hospital_id', p_hospital_id, 'diversion', p_on,
                          'event_at', clock_timestamp()));
    v_notified := v_notified + 1;
  end loop;

  return p_on;
end $$;

create function public.update_capacity(
  p_hospital_id uuid, p_beds_available int, p_total_beds int default null
) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if public.current_personnel_role() = 'hospital_admin' then
    if not public.is_my_hospital(p_hospital_id) then
      raise exception 'NOT_AUTHORIZED: not your hospital' using errcode = 'TG106';
    end if;
  elsif public.current_personnel_role() <> 'admin' then
    raise exception 'NOT_AUTHORIZED: hospital_admin role required' using errcode = 'TG106';
  end if;

  update public.hospitals
  set beds_available = greatest(p_beds_available, 0),
      total_beds = coalesce(p_total_beds, total_beds)
  where id = p_hospital_id;

  if p_total_beds is not null and p_beds_available > p_total_beds then
    raise exception 'VALIDATION_FAILED: beds_available exceeds total_beds'
      using errcode = 'TG110';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-3 MATCHING ENGINE — DB SIDE (problem loader + heartbeat + health check)
-- The weighted bipartite optimization itself lives in the match-batch Edge
-- Function (Hungarian algorithm, TypeScript); this side provides:
--   load_matching_problem()  – open incidents x eligible units snapshot
--   run_matching_batch()     – cron entrypoint: heartbeat row + pg_net invoke
--   check_matching_health()  – overdue/stuck detection + stranding guard
-- Batch interval: config matching.batch_interval_seconds (default 60s). pg_cron
-- fires every minute; run_matching_batch skips early re-entry.
-- Unit unavailable between batches: proposals finalize through try_claim_pair
-- which re-validates under lock — stale pairs fail cleanly and roll forward.
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.load_matching_problem() returns jsonb
language sql volatile security definer set search_path = public, extensions as $$
  with open_incidents as (
    select i.id, i.agency_id, i.priority_tier, i.created_at,
           i.current_lat, i.current_lng,
           extract(epoch from (now() - i.triaged_at))::int as seconds_in_triage,
           coalesce((i.priority_tier::text = 'critical'), false) as is_critical
    from public.incidents i
    where i.status = 'triaged'
      and not exists (
        select 1 from public.resource_claims c
        where c.incident_id = i.id and c.is_primary
          and c.status in ('proposed', 'finalized', 'active'))
  ),
  eligible_units as (
    select u.id, u.agency_id, u.capabilities, u.capacity, u.unit_type,
           u.current_lat, u.current_lng, u.status,
           (select count(*) from public.resource_claims c2
            where c2.unit_id = u.id
              and c2.status in ('proposed', 'finalized', 'active')) as active_load
    from public.units u
    where u.status = 'available'
      and u.current_lat is not null
  )
  select jsonb_build_object(
    'generated_at', clock_timestamp(),
    'incidents', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from open_incidents t),
    'units',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from eligible_units t)
  );
$$;

create function public.invoke_match_batch(p_reason text) returns bigint
language plpgsql volatile security definer set search_path = public, extensions, net as $$
declare
  v_run_id bigint;
  v_url text;
  v_secret text;
begin
  select id into v_run_id
  from public.matching_batch_runs
  where status = 'running' and started_at > now() - interval '120 seconds'
  limit 1;
  if v_run_id is not null then
    return v_run_id;  -- a batch is already in flight; do not double-invoke
  end if;

  insert into public.matching_batch_runs (status) values ('running')
  returning id into v_run_id;

  v_url := coalesce(public.get_config('functions.match_batch_url') #>> '{}',
                    'http://kong:8000/functions/v1/match-batch');
  v_secret := coalesce(public.get_config('functions.match_batch_secret') #>> '{}', '');

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('run_id', v_run_id, 'reason', p_reason),
    timeout_milliseconds := 8000
  );
  -- Fire-and-forget by design; completion recorded by the function updating
  -- this row. Failure modes covered by check_matching_health().
  return v_run_id;
end $$;

-- Cron entrypoint (every minute ceiling; respects configured interval)
create function public.run_matching_batch() returns bigint
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_interval int := coalesce(public.get_config_num('matching.batch_interval_seconds', 60), 60)::int;
  v_last timestamptz;
begin
  select max(started_at) into v_last from public.matching_batch_runs where status = 'success';
  if v_last is not null and v_last > now() - make_interval(secs => v_interval * 0.9) then
    return null;  -- ran recently; skip
  end if;
  return public.invoke_match_batch('scheduled');
end $$;

-- Health check: overdue batches, stuck runs, stranded incidents (heartbeat
-- lies notwithstanding). Emits dispatcher notifications + escalations rows.
create function public.check_matching_health() returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_mult int := coalesce(public.get_config_num('escalation.overdue_batch_multiplier', 3), 3)::int;
  v_interval int := coalesce(public.get_config_num('matching.batch_interval_seconds', 60), 60)::int;
  v_overdue boolean;
  v_stuck int;
  v_stranded record;
  v_agencies record;
begin
  -- Stuck 'running' rows older than 2 minutes (function crashed mid-flight)
  select count(*) into v_stuck from public.matching_batch_runs
  where status = 'running' and started_at < now() - interval '120 seconds';

  -- Overdue: last success too old relative to configured cadence
  select coalesce(max(started_at), '-infinity') < now() - make_interval(secs => v_mult * v_interval)
    into v_overdue from public.matching_batch_runs where status = 'success';

  if v_stuck > 0 or v_overdue then
    update public.matching_batch_runs set status = 'timeout',
      finished_at = now(), error_detail = 'flagged by check_matching_health'
    where status = 'running' and started_at < now() - interval '120 seconds';

    for v_agencies in select id from public.agencies loop
      insert into public.notifications
        (agency_id, target_role, type, title, body, channel, delivery_status, payload)
      values
        (v_agencies.id, 'dispatcher', 'matching_health',
         'Matching pipeline degraded',
         format('Automated matching has not completed successfully. overdue=%s stuck_runs=%s. Critical incidents may be waiting — review the queue manually.',
                v_overdue, v_stuck),
         'both', 'pending',
         jsonb_build_object('overdue', v_overdue, 'stuck_runs', v_stuck));
    end loop;
  end if;

  -- Stranding guard: triaged incidents past SLA regardless of heartbeat truth.
  -- These ALSO feed escalate_triaged_incidents(); here we only alert when the
  -- escalation sweep itself appears dead (no successful sweep recently).
  if exists (
    select 1 from public.config where key = 'escalation.last_sweep_at'
      and (value #>> '{}')::timestamptz > now() - interval '10 minutes'
  ) then
    return;  -- sweeps alive; stranding will be escalated by the sweep
  end if;

  for v_stranded in
    select i.id, i.agency_id, i.tracking_code, i.priority_tier
    from public.incidents i
    where i.status = 'triaged'
      and i.triaged_at < now() - make_interval(
            secs => coalesce(public.get_config_num('escalation.triaged_timeout_seconds', 600), 600))
      and not exists (select 1 from public.resource_claims c
                      where c.incident_id = i.id and c.is_primary
                        and c.status in ('proposed','finalized','active'))
    limit 20
  loop
    insert into public.notifications
      (agency_id, target_role, incident_id, type, title, body, channel)
    values
      (v_stranded.agency_id, 'dispatcher', v_stranded.id, 'stranding_alert',
       'Incident awaiting dispatch beyond SLA',
       format('Incident %s (%s) has waited for a unit beyond the configured timeout while the matching pipeline appears unhealthy. Manual dispatch recommended.',
              v_stranded.tracking_code, v_stranded.priority_tier),
       'both');
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FR-7 ESCALATION SWEEP (timeout-based auto-escalation)
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.escalate_triaged_incidents() returns int
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_timeout int := coalesce(public.get_config_num('escalation.triaged_timeout_seconds', 600), 600)::int;
  v_count int := 0;
  r record;
  v_new_tier public.priority_tier;
begin
  for r in
    select i.*
    from public.incidents i
    where i.status = 'triaged'
      and i.triaged_at < now() - make_interval(secs => v_timeout)
      and not exists (
        select 1 from public.resource_claims c
        where c.incident_id = i.id and c.is_primary
          and c.status in ('proposed', 'finalized', 'active'))
    for update skip locked
  loop
    -- Raise priority one tier, capped at critical
    v_new_tier := case r.priority_tier
      when 'low' then 'medium' when 'medium' then 'high'
      when 'high' then 'critical' else 'critical' end;

    update public.incidents
    set priority_tier = v_new_tier,
        escalation_count = escalation_count + 1
    where id = r.id;

    insert into public.escalations
      (incident_id, triggered_by, previous_tier, new_tier, action_taken)
    values
      (r.id, 'timeout', r.priority_tier, v_new_tier,
       format('Tier raised %s -> %s after %ss without dispatch; matching re-run requested.',
              r.priority_tier, v_new_tier, v_timeout));

    insert into public.notifications
      (agency_id, target_role, incident_id, type, title, body, channel, payload)
    values
      (r.agency_id, 'dispatcher', r.id, 'escalation',
       format('Escalated to %s', v_new_tier),
       format('Incident %s exceeded the %s-second dispatch timeout and was auto-escalated. Re-running automated matching.',
              r.tracking_code, v_timeout),
       'both',
       jsonb_build_object('previous_tier', r.priority_tier, 'new_tier', v_new_tier));

    -- Immediate incremental match pass for this escalated incident
    perform public.invoke_match_batch('escalation:' || r.id::text);

    v_count := v_count + 1;
  end loop;

  insert into public.config (key, value) values
    ('escalation.last_sweep_at', to_jsonb(clock_timestamp()))
  on conflict (key) do update set value = to_jsonb(clock_timestamp());

  return v_count;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CRITICAL-PRIORITY IMMEDIATE TRIGGER (batching interval bypass for criticals)
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.trigger_immediate_match_if_critical()
returns trigger language plpgsql volatile security definer
set search_path = public, extensions, net as $$
begin
  if public.get_config_bool('matching.critical_trigger_enabled', true)
     and new.status = 'triaged' and new.priority_tier = 'critical'
     and (old.status is distinct from 'triaged' or old.priority_tier <> 'critical') then
    perform public.invoke_match_batch('critical:' || new.id::text);
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_critical_match_trigger
  after insert or update on public.incidents
  for each row execute function public.trigger_immediate_match_if_critical();

-- ═══════════════════════════════════════════════════════════════════════════════
-- CITIZEN TRACKING-CODE READ-BACK (SECURITY DEFINER; see 0002 verbatim note)
-- Whitelisted columns only. Coarse location (2dp ≈ 1km). Rate-limited per IP.
-- ═══════════════════════════════════════════════════════════════════════════════
create function public.get_incident_by_tracking_code(
  p_code text, p_client_ip text default 'unknown'
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_limit int := coalesce(public.get_config_num('rate_limits.tracking_lookup_per_hour', 20), 20)::int;
  v_incident public.incidents;
begin
  -- Defense-in-depth: brute-force resistance lives in code entropy (~2^130);
  -- this limiter throttles enumeration attempts anyway.
  if not public.check_rate_limit('tracking_lookup', p_client_ip, v_limit, 3600) then
    raise exception 'RATE_LIMITED: too many lookups from this address'
      using errcode = 'TG109';
  end if;

  if p_code !~ '^[0-9A-Za-z]{22}$' then
    raise exception 'NOT_FOUND: invalid tracking code format' using errcode = 'TG108';
  end if;

  select * into v_incident from public.incidents
  where tracking_code = p_code;

  if v_incident.id is null then
    raise exception 'NOT_FOUND: no incident with this tracking code'
      using errcode = 'TG108';
  end if;

  return jsonb_build_object(
    'tracking_code', v_incident.tracking_code,
    'status', v_incident.status,
    'priority_tier', v_incident.priority_tier,
    'created_at', v_incident.created_at,
    'summary', left(v_incident.description, 140),
    -- Coarse location only: citizens do not get meter-level coordinates
    'approx_location', jsonb_build_object(
      'lat', round(v_incident.current_lat::numeric, 2),
      'lng', round(v_incident.current_lng::numeric, 2))
  );
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FUNCTION EXECUTE HARDENING
-- Postgres grants EXECUTE to PUBLIC by default. SECURITY DEFINER functions that
-- bypass role checks (internal machinery, service-context only, or privileged
-- writers) must have that default revoked from untrusted roles, otherwise a
-- hostile client could call e.g. try_claim_pair directly and skip authorization.
-- Role-checked public RPCs (claim_unit, update_incident_status,
-- toggle_diversion, create_citizen_incident, override_triage, accept/reject,
-- get_incident_by_tracking_code, verify_audit_chain) stay executable.
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
declare f text;
begin
  for f in
    select unnest(array[
      'try_claim_pair(uuid,uuid,text,boolean,uuid)',
      'apply_triage_score(uuid,jsonb,text,uuid)',
      'audit_row_change()',
      'load_matching_problem()',
      'apply_match_proposals(jsonb)',
      'invoke_match_batch(text)',
      'run_matching_batch()',
      'check_rate_limit(text,text,int,int)',
      'escalate_triaged_incidents()',
      'check_matching_health()',
      'trigger_immediate_match_if_critical()'
    ])
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CRON WIRING (pg_cron; intervals are latency ceilings — functions self-gate)
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
begin
  perform cron.unschedule('match-batch')
  where (select count(*) from cron.job where jobname = 'match-batch') > 0;
  perform cron.schedule('match-batch', '* * * * *', 'select public.run_matching_batch();');

  perform cron.unschedule('escalation-sweep')
  where (select count(*) from cron.job where jobname = 'escalation-sweep') > 0;
  perform cron.schedule('escalation-sweep', '* * * * *', 'select public.escalate_triaged_incidents();');

  perform cron.unschedule('matching-health')
  where (select count(*) from cron.job where jobname = 'matching-health') > 0;
  perform cron.schedule('matching-health', '*/5 * * * *', 'select public.check_matching_health();');
exception when undefined_table then
  raise warning 'pg_cron tables missing; schedules not installed';
end $$;
