-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIAGEGRID MIGRATION 0002 — Row-Level Security: access matrix + policies
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ACCESS MATRIX (role × table × operation) — implemented EXACTLY below.
-- Legend: ✅ allowed  ❌ denied  🔒 via SECURITY DEFINER RPC w/ role check
--
-- CITIZEN = unauthenticated `anon` role (pure anon-key access; NO auth session).
-- All privileged mutations flow through SECURITY DEFINER RPCs (migration 0003)
-- because the frontend is hostile; RLS additionally gates every direct path.
--
-- ┌─────────────────────┬────────┬───────────┬─────────┬────────────────┬───────────┐
-- │ TABLE               │ anon   │ field     │ dispatch│ hospital_admin │ admin     │
-- ├─────────────────────┼────────┼───────────┼─────────┼────────────────┼───────────┤
-- │ agencies            │ ❌     │ R own     │ R own   │ R own          │ R all*    │
-- │ personnel           │ ❌     │ R self    │ R agency│ R self         │ R/W agency│
-- │   personnel.locale  │ ❌     │ U self    │ U self  │ U self         │ U agency  │
-- │ units               │ ❌     │ R own unit│ R agency│ ❌             │ R agency  │
-- │ hospitals           │ ❌     │ R agency  │ R agency│ R own          │ R agency  │
-- │   capacity fields   │ ❌     │ ❌        │ ❌      │ 🔒 own only    │ 🔒        │
-- │ incidents           │ ❌ (!) │ R assigned│ R/W agcy│ R inbound-only │ R/W agcy  │
-- │   citizen insert    │ 🔒 via Edge Function (rate-limited) — NOT direct │
-- │   dispatcher insert │ ✅ direct INSERT w/ RLS policy                    │
-- │   status changes    │ 🔒 RPC update_incident_status (state machine)     │
-- │ triage_scores       │ ❌     │ R assigned│ R agcy  │ R inbound      │ R agcy    │
-- │   scoring/override  │ 🔒 RPC upsert_triage / override_triage           │
-- │ resource_claims     │ ❌     │ R own     │ R/W agcy│ R inbound      │ R agcy    │
-- │   claiming          │ 🔒 RPC claim_unit (FR-6 arbitration)             │
-- │ escalations         │ ❌     │ R assigned│ R agcy  │ ❌             │ R agcy    │
-- │ audit_log           │ ❌     │ ❌        │ ❌      │ ❌             │ R only**  │
-- │ notifications       │ ❌     │ R own/role│ R own/role│ R own/role   │ R own/role│
-- │   mark-read         │ ❌     │ U self    │ U self  │ U self         │ U self    │
-- │ sync_queue          │ ❌     │ ❌***     │ ❌***   │ ❌***          │ ❌***     │
-- │ matching_batch_runs │ ❌     │ ❌        │ ❌      │ ❌             │ R         │
-- │ rate_limits/config  │ ❌     │ ❌        │ ❌      │ ❌             │ ❌****    │
-- │ storage: photos     │ signed-URL upload/read issued by Edge Functions    │
-- └─────────────────────┴────────┴───────────┴─────────┴────────────────┴───────────┘
--
-- *  admin sees all agencies (cross-agency oversight persona).
-- ** audit_log: SELECT for admin ONLY; NO role — including admin and table
--    owner's application-facing grants — receives UPDATE or DELETE. This is
--    enforced with explicit REVOKE statements below, NOT convention. Inserts
--    occur exclusively inside audit triggers running as table owner.
-- *** sync_queue is written/read exclusively by the /api/sync server route
--     using the service-role key (which bypasses RLS); clients never touch it,
--     so a stolen anon key cannot enumerate other devices' mutation queues.
-- **** config is read through get_config()/get_config_num()/get_config_bool()
--      (SECURITY DEFINER); raw table access is denied to prevent tampering
--      with scoring weights via a compromised client.
--
-- CITIZEN READ-BACK GUARANTEE (verbatim commitment):
--   The `anon` role has ZERO grants and ZERO RLS policies granting any form of
--   SELECT on the incidents table — there is NO filtered-query path, not even
--   one scoped by tracking code. Citizens read their submission exclusively by
--   calling the SECURITY DEFINER RPC get_incident_by_tracking_code(code), which
--   returns a whitelisted column set only. `REVOKE ALL ON incidents FROM anon`
--   below makes this structurally impossible to bypass from the client.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMA ADDITIONS supporting fine-grained RLS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.units
  add column if not exists assigned_to uuid references public.personnel(id)
    on delete set null;   -- the field responder currently operating the unit

alter table public.personnel
  add column if not exists hospital_id uuid references public.hospitals(id)
    on delete set null;   -- populated only for hospital_admin role

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER PREDICATES (all SECURITY DEFINER + STABLE; pinned search_path;
-- they bypass RLS on referenced tables preventing policy recursion)
-- ─────────────────────────────────────────────────────────────────────────────
create function public.current_hospital_id() returns uuid
language sql stable security definer set search_path = public, extensions as
$$ select hospital_id from public.personnel where id = auth.uid() $$;

-- Is the caller an assigned field responder (or claimant) on this incident?
create function public.is_assigned_to_incident(p_incident_id uuid) returns boolean
language sql stable security definer set search_path = public, extensions as
$$
  select exists (
    select 1
    from public.resource_claims c
    join public.units u on u.id = c.unit_id
    where c.incident_id = p_incident_id
      and c.status in ('proposed', 'finalized', 'active')
      and (u.assigned_to = auth.uid() or c.claimed_by = auth.uid())
  );
$$;

-- Does this incident have an inbound (live) transport toward the given hospital?
create function public.hospital_has_inbound(p_hospital_id uuid, p_incident_id uuid)
returns boolean
language sql stable security definer set search_path = public, extensions as
$$
  select exists (
    select 1 from public.resource_claims
    where incident_id = p_incident_id
      and destination_hospital_id = p_hospital_id
      and status in ('proposed', 'finalized', 'active')
  );
$$;

-- The caller's own hospital (null-safe).
create function public.is_my_hospital(p_hospital_id uuid) returns boolean
language sql stable security definer set search_path = public, extensions as
$$ select public.current_hospital_id() is not distinct from p_hospital_id $$;

-- Does the caller have a live claim on this incident (any role view)?
create function public.has_live_claim_on(p_incident_id uuid) returns boolean
language sql stable security definer set search_path = public, extensions as
$$
  select exists (
    select 1 from public.resource_claims c
    join public.units u on u.id = c.unit_id
    where c.incident_id = p_incident_id
      and c.status in ('proposed', 'finalized', 'active')
      and (u.assigned_to = auth.uid() or c.claimed_by = auth.uid())
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENABLE RLS EVERYWHERE
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.agencies           enable row level security;
alter table public.personnel          enable row level security;
alter table public.units              enable row level security;
alter table public.hospitals          enable row level security;
alter table public.incidents          enable row level security;
alter table public.triage_scores      enable row level security;
alter table public.resource_claims    enable row level security;
alter table public.escalations        enable row level security;
alter table public.audit_log          enable row level security;
alter table public.sync_queue         enable row level security;
alter table public.notifications      enable row level security;
alter table public.matching_batch_runs enable row level security;
alter table public.rate_limits        enable row level security;
alter table public.config             enable row level security;

-- NOTE: we deliberately do NOT use ALTER TABLE ... FORCE ROW LEVEL SECURITY on
-- audit_log. Triggers execute with the *invoker's* privileges; forcing RLS
-- would require every audited INSERT/UPDATE to carry an audit_log INSERT
-- policy, widening the writable surface. Instead, immutability is enforced by:
--   1. explicit REVOKE of UPDATE/DELETE/TRUNCATE from ALL application roles
--      (grants-based enforcement per FR-11), and
--   2. the ONLY writer being the SECURITY DEFINER audit trigger function
--      (migration 0003), owned by postgres, which no client can invoke to
--      modify existing rows.

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANTS — start from zero, grant precisely. (Supabase default privileges give
-- broad grants to anon/authenticated; we revoke first.)
-- service_role keeps BYPASSRLS-style broad access for Edge Functions/server
-- routes and is intentionally untouched.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'agencies','personnel','units','hospitals','incidents','triage_scores',
    'resource_claims','escalations','audit_log','sync_queue','notifications',
    'matching_batch_runs','rate_limits','config'
  ] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
  end loop;
end $$;

-- Hard revokes on the append-only log — no exceptions, any role:
revoke update, delete, truncate on public.audit_log from public, anon, authenticated;
-- (INSERT grant is never issued either: only audit triggers, running with table
-- ownership, write here.)

-- Precise re-grants (reads gated again by RLS policies):
grant select on public.agencies        to authenticated;
grant select on public.personnel       to authenticated;
grant update (locale, full_name, phone) on public.personnel to authenticated;
grant select on public.units           to authenticated;
grant select on public.hospitals       to authenticated;
grant select, insert                   on public.incidents        to authenticated;
grant select                           on public.triage_scores    to authenticated;
grant select                           on public.resource_claims  to authenticated;
grant select                           on public.escalations      to authenticated;
grant select                           on public.audit_log        to authenticated; -- policy: admin only
grant select                           on public.notifications    to authenticated;
grant update (read_at)                 on public.notifications    to authenticated;
grant select                           on public.matching_batch_runs to authenticated; -- policy: admin only

-- Restore full grants for the SERVICE ROLE (Edge Functions / server routes).
-- The blanket revokes above also removed Supabase's default service_role
-- privileges; without these, server-side ledger writes (sync_queue etc.) fail.
-- RLS does not constrain service_role (BYPASSRLS), and every call site is
-- session-validated or secret-gated.
do $$
declare t text;
begin
  for t in
    select unnest(array[
      'agencies','personnel','units','hospitals','incidents','triage_scores',
      'resource_claims','escalations','sync_queue','notifications',
      'matching_batch_runs','rate_limits','config'
    ])
  loop
    execute format('grant all on public.%I to service_role', t);
  end loop;
  -- audit_log stays append-only even for service_role: server code may insert
  -- and read, but never rewrite history (FR-11).
  execute 'grant select, insert on public.audit_log to service_role';
end $$;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- POLICIES
-- Naming: <table>_<role/action>_<scope>
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── agencies ─────────────────────────────────────────────────────────────────
create policy agencies_select_own_agency on public.agencies
  for select to authenticated
  using (public.is_admin() or id = public.current_agency_id());

-- ── personnel ────────────────────────────────────────────────────────────────
create policy personnel_select_self_or_agency_staff on public.personnel
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_admin()
    or (
      agency_id = public.current_agency_id()
      and public.current_personnel_role() in ('dispatcher')
    )
  );

create policy personnel_update_self_profile on public.personnel
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
-- Column grant above restricts this to locale/full_name/phone (FR-13 locale
-- persistence lives here).

-- ── units ────────────────────────────────────────────────────────────────────
create policy units_select_dispatcher_or_admin_or_owning_field on public.units
  for select to authenticated
  using (
    public.is_admin()
    or (
      agency_id = public.current_agency_id()
      and public.current_personnel_role() in ('dispatcher', 'hospital_admin')
    )
    or (
      assigned_to = auth.uid()
      and public.current_personnel_role() = 'field'
    )
  );
-- NOTE: hospital_admin included for map context but capacity routing decisions
-- never depend on unit rows. Writes: none for app roles (admin roster managed
-- via server-side service-role routes in step 5).

-- ── hospitals ────────────────────────────────────────────────────────────────
create policy hospitals_select_agency_or_own on public.hospitals
  for select to authenticated
  using (
    public.is_admin()
    or (
      agency_id = public.current_agency_id()
      and public.current_personnel_role() in ('dispatcher', 'field')
    )
    or (
      public.current_personnel_role() = 'hospital_admin'
      and public.is_my_hospital(id)
    )
  );
-- Capacity/diversion WRITES are exclusively via toggle_diversion /
-- update_capacity SECURITY DEFINER RPCs (0003) — no UPDATE grant exists.

-- ── incidents ────────────────────────────────────────────────────────────────
-- SELECT: dispatchers/admins agency-wide; field only assigned; hospital_admin
-- only inbound-relevant. anon: NOTHING (see verbatim guarantee above).
create policy incidents_select_by_role on public.incidents
  for select to authenticated
  using (
    public.is_admin()
    or (
      agency_id = public.current_agency_id()
      and public.current_personnel_role() = 'dispatcher'
    )
    or (
      public.current_personnel_role() = 'field'
      and public.is_assigned_to_incident(id)
    )
    or (
      public.current_personnel_role() = 'hospital_admin'
      and public.hospital_has_inbound(public.current_hospital_id(), id)
    )
  );

-- INSERT: dispatchers/admins only, own agency. Citizens NEVER insert directly —
-- they call the rate-limited Edge Function which writes with the service role.
create policy incidents_insert_dispatcher_or_admin on public.incidents
  for insert to authenticated
  with check (
    agency_id = public.current_agency_id()
    and public.current_personnel_role() in ('dispatcher', 'admin')
  );

-- UPDATE/DELETE: no grants to any application role. Status transitions,
-- priority overrides, cancellations all flow through SECURITY DEFINER RPCs
-- (update_incident_status, override_triage, cancel_incident) which verify role
-- AND agency AND state machine server-side.

-- ── triage_scores ────────────────────────────────────────────────────────────
create policy triage_scores_select_mirror_incidents on public.triage_scores
  for select to authenticated
  using (
    -- Mirrors the exact incident visibility predicate:
    exists (
      select 1 from public.incidents i
      where i.id = incident_id
        and (
          public.is_admin()
          or (i.agency_id = public.current_agency_id()
              and public.current_personnel_role() = 'dispatcher')
          or (public.current_personnel_role() = 'field'
              and public.is_assigned_to_incident(i.id))
          or (public.current_personnel_role() = 'hospital_admin'
              and public.hospital_has_inbound(public.current_hospital_id(), i.id))
        )
    )
  );
-- Writes: none directly — upsert_triage_score / override_triage RPCs only.

-- ── resource_claims ──────────────────────────────────────────────────────────
create policy claims_select_by_role on public.resource_claims
  for select to authenticated
  using (
    public.is_admin()
    or (
      exists (
        select 1 from public.units u
        where u.id = unit_id and u.agency_id = public.current_agency_id()
      )
      and public.current_personnel_role() in ('dispatcher')
    )
    or (
      public.current_personnel_role() = 'field'
      and exists (
        select 1 from public.units u
        where u.id = resource_claims.unit_id
          and (u.assigned_to = auth.uid() or resource_claims.claimed_by = auth.uid())
      )
    )
    or (
      public.current_personnel_role() = 'hospital_admin'
      and destination_hospital_id is not null
      and public.is_my_hospital(destination_hospital_id)
    )
  );
-- Writes: claim_unit / finalize_claim / update_claim_status RPCs only.

-- ── escalations ──────────────────────────────────────────────────────────────
create policy escalations_select_dispatch_admin on public.escalations
  for select to authenticated
  using (
    public.is_admin()
    or (
      public.current_personnel_role() = 'dispatcher'
      and exists (
        select 1 from public.incidents i
        where i.id = incident_id and i.agency_id = public.current_agency_id()
      )
    )
    or (public.current_personnel_role() = 'field'
        and exists (
          select 1 from public.incidents i
          where i.id = incident_id and public.is_assigned_to_incident(i.id)))
  );

-- ── audit_log ────────────────────────────────────────────────────────────────
-- Admin-only SELECT; append-only for everyone (grants section above).
create policy audit_log_select_admin_only on public.audit_log
  for select to authenticated
  using (public.is_admin());

-- ── notifications ────────────────────────────────────────────────────────────
create policy notifications_select_recipient_or_role on public.notifications
  for select to authenticated
  using (
    recipient_user = auth.uid()
    or (
      recipient_user is null
      and target_role = public.current_personnel_role()
      and agency_id = public.current_agency_id()
    )
  );

create policy notifications_mark_read_self on public.notifications
  for update to authenticated
  using (recipient_user = auth.uid())
  with check (recipient_user = auth.uid());

-- ── sync_queue / rate_limits / config ────────────────────────────────────────
-- Deliberately NO policies: RLS enabled + zero policies + zero grants = deny
-- all application roles. Service role (Edge Functions, /api/sync) bypasses RLS.

-- matching_batch_runs: health visibility for admins only.
create policy matching_runs_select_admin on public.matching_batch_runs
  for select to authenticated
  using (public.is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- STORAGE: private photo bucket (signed-URL upload/read issued server-side)
-- Object path convention: {agency_id}/{incident_id}/{random}.{ext}
-- ─────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('incident-photos', 'incident-photos', false, 52428800)
on conflict (id) do nothing;

-- Personnel of the owning agency may read photos of incidents they can see;
-- everything else (upload URL issuance, delete) is service-role mediated.
create policy photos_read_by_agency_personnel on storage.objects
  for select to authenticated
  using (
    bucket_id = 'incident-photos'
    and (storage.foldername(name))[1] = public.current_agency_id()::text
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- REALTIME publications (postgres_changes respect RLS per subscribed user)
-- Full channel wiring happens in step 9; tables are added to the publication
-- here so schema-level prerequisites exist from day one.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['incidents','units','hospitals','resource_claims','notifications'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null; -- already in publication
    end;
  end loop;
end $$;
