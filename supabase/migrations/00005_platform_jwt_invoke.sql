-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIAGEGRID MIGRATION 0005 — Platform-JWT-aware matcher invocation
--
-- Supabase's gateway validates the Authorization header of Edge Function
-- requests as a platform JWT before the function runs. Our shared secret is
-- therefore moved to the `x-match-secret` header, while `Authorization`/
-- `apikey` carry the project's PUBLIC anon JWT (safe: it is a public value and
-- the function still enforces the shared secret itself).
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.config (key, value, description) values
  ('functions.platform_jwt', 'null'::jsonb,
   'Public anon JWT used by pg_net for gateway transit when invoking match-batch.')
on conflict (key) do nothing;

create or replace function public.invoke_match_batch(p_reason text) returns bigint
language plpgsql volatile security definer set search_path = public, extensions, net as $$
declare
  v_run_id bigint;
  v_url text;
  v_secret text;
  v_jwt text;
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
  v_jwt := coalesce(public.get_config('functions.platform_jwt') #>> '{}', '');

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_jwt,
      'Authorization', 'Bearer ' || v_jwt,
      'x-match-secret', v_secret),
    body := jsonb_build_object('run_id', v_run_id, 'reason', p_reason),
    timeout_milliseconds := 8000
  );
  -- Fire-and-forget by design; completion recorded by the function updating
  -- this row. Failure modes covered by check_matching_health().
  return v_run_id;
end $$;

revoke execute on function public.invoke_match_batch(text) from public, anon, authenticated;
