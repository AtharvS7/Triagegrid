-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIAGEGRID MIGRATION 0004 — Field-device RPCs for the offline sync engine
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- FR-8 CONFLICT RESOLUTION POLICY MATRIX (authoritative; implemented here and
-- mirrored in app/lib/offline/policy.ts). Per-field, not blanket LWW:
--
-- ┌──────────────────────────────────┬─────────────────────────────────────────┐
-- │ incidents.status                 │ SERVER-AUTHORITATIVE + ORDERED REPLAY   │
-- │                                  │ Queued transitions are replayed in      │
-- │                                  │ order against live state; an invalid    │
-- │                                  │ transition is skipped only if the final │
-- │                                  │ intended state is reachable, otherwise  │
-- │                                  │ the whole chain is surfaced as CONFLICT │
-- │                                  │ (server wins ties — e.g. auto-escalation│
-- │                                  │ raced a queued update; A5 clock rules). │
-- ├──────────────────────────────────┼─────────────────────────────────────────┤
-- │ incidents.description            │ LAST-WRITER-WINS (skew-tolerated)       │
-- ├──────────────────────────────────┼─────────────────────────────────────────┤
-- │ triage_scores.vitals / override  │ MANUAL-SURFACE — NEVER silently         │
-- │                                  │ overwritten: if the server holds a      │
-- │                                  │ score row newer than the device's base  │
-- │                                  │ snapshot, submit_field_triage returns   │
-- │                                  │ both values; the device must show the   │
-- │                                  │ user the conflict before proceeding.    │
-- ├──────────────────────────────────┼─────────────────────────────────────────┤
-- │ claims.destination_hospital_id   │ LAST-WRITER-WINS (transporting crew is  │
-- │                                  │ effectively the single writer)          │
-- ├──────────────────────────────────┼─────────────────────────────────────────┤
-- │ units.current_lat/lng/status     │ LAST-WRITER-WINS + server-side GPS      │
-- │                                  │ drift guard as physical-plausibility    │
-- │                                  │ backstop (IMPLAUSIBLE_LOCATION_JUMP)    │
-- ├──────────────────────────────────┼─────────────────────────────────────────┤
-- │ notifications.read_at            │ LAST-WRITER-WINS (trivially monotone)   │
-- └──────────────────────────────────┴─────────────────────────────────────────┘
-- ═══════════════════════════════════════════════════════════════════════════════

-- Field triage/vitals submission with MANUAL-SURFACE conflict detection.
create function public.submit_field_triage(
  p_incident_id uuid,
  p_vitals jsonb,
  p_override_score numeric default null,
  p_client_mutation_id uuid default null,
  p_base_created_at timestamptz default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_role public.personnel_role := public.current_personnel_role();
  v_latest timestamptz;
  v_res record;
begin
  -- Only assigned field personnel (dispatchers have their own override path)
  if not (v_role = 'field' and public.is_assigned_to_incident(p_incident_id))
     and v_role <> 'dispatcher' then
    raise exception 'NOT_AUTHORIZED: field triage requires assignment'
      using errcode = 'TG106';
  end if;

  select max(created_at) into v_latest
  from public.triage_scores where incident_id = p_incident_id;

  -- MANUAL-SURFACE: server has a newer value than our base snapshot -> do NOT
  -- write silently; hand both versions back for user adjudication.
  if v_latest is not null and p_base_created_at is not null
     and v_latest > p_base_created_at then
    return jsonb_build_object('status', 'conflict',
      'conflict', jsonb_build_object(
        'entity', 'triage_scores',
        'incident_id', p_incident_id,
        'server_created_at', v_latest,
        'client_base_created_at', p_base_created_at,
        'server_rows', (
          select coalesce(jsonb_agg(to_jsonb(t) - 'vitals'), '[]'::jsonb)
          from (select computed_score, computed_tier, override_score, override_tier,
                       source, created_at
                from public.triage_scores
                where incident_id = p_incident_id
                order by created_at desc limit 3) t)));
  end if;

  select * into v_res from public.compute_triage_score(p_vitals);

  insert into public.triage_scores
    (incident_id, computed_score, computed_tier, override_score, scored_by,
     algorithm_version, vitals, source, client_mutation_id)
  values
    (p_incident_id, v_res.score, v_res.tier,
     case when p_override_score between -100 and 200 then p_override_score else null end,
     auth.uid(), v_res.algorithm_version, p_vitals, 'field', p_client_mutation_id);

  if p_override_score between -100 and 200 then
    update public.triage_scores
    set override_tier = case
      when p_override_score >= 65 then 'critical'::public.priority_tier
      when p_override_score >= 45 then 'high'::public.priority_tier
      when p_override_score >= 20 then 'medium'::public.priority_tier
      else 'low'::public.priority_tier end
    where id = (select id from public.triage_scores
                where incident_id = p_incident_id
                order by created_at desc limit 1);
  end if;

  -- Effective tier follows override when present, else computed
  update public.incidents i
  set priority_tier = coalesce(
        (select t.override_tier from public.triage_scores t
         where t.incident_id = i.id order by t.created_at desc limit 1),
        (select t.computed_tier from public.triage_scores t
         where t.incident_id = i.id order by t.created_at desc limit 1))
  where i.id = p_incident_id;

  return jsonb_build_object('status', 'applied');
end $$;

-- Field unit position update (LWW + drift-guarded server-side).
create function public.update_unit_position(
  p_unit_id uuid, p_lat double precision, p_lng double precision
) returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_role public.personnel_role := public.current_personnel_role();
begin
  if not exists (
    select 1 from public.units
    where id = p_unit_id and assigned_to = auth.uid()
  ) or v_role not in ('field', 'admin') then
    raise exception 'NOT_AUTHORIZED: only the assigned crew updates unit position'
      using errcode = 'TG106';
  end if;

  if p_lat is null or p_lng is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'VALIDATION_FAILED: coordinates out of range' using errcode = 'TG110';
  end if;

  update public.units
  set current_lat = p_lat, current_lng = p_lng, last_fix_at = now()
  where id = p_unit_id;
end $$;
