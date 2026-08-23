import { Client } from "pg";

export const DB_URL =
  process.env.TRIAGEGRID_DB_URL ??
  "postgres://postgres:postgres@127.0.0.1:54322/postgres";

/** Fixed IDs matching supabase/seed.sql. */
export const IDS = {
  agency: "11111111-1111-1111-1111-111111111111",
  admin: "aaaaaaaa-0000-0000-0000-00000000aaa1",
  dispatcher: "aaaaaaaa-0000-0000-0000-00000000aaa2",
  field: "aaaaaaaa-0000-0000-0000-00000000aaa3",
  hospitalAdmin: "aaaaaaaa-0000-0000-0000-00000000aaa4",
  field2: "aaaaaaaa-0000-0000-0000-00000000aaa5",
  unitM1: "22222222-0000-0000-0000-000000000001",
  unitM2: "22222222-0000-0000-0000-000000000002",
  hospitalA: "33333333-3333-3333-3333-333333333333",
  hospitalB: "33333333-3333-3333-3333-333333333334",
};

export async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  return c;
}

/**
 * Emulate a PostgREST-authenticated request context on a raw connection:
 * SET ROLE authenticated + request.jwt.claims so auth.uid()/RLS behave
 * exactly as they do through the API.
 */
export async function actAs(c: Client, userId: string | null) {
  if (userId === null) {
    await c.query("RESET ROLE");
    await c.query("SELECT set_config('request.jwt.claims', '', false)");
    await c.query("SET ROLE anon");
    return;
  }
  await c.query("SET ROLE authenticated");
  await c.query(
    "SELECT set_config('request.jwt.claims', $1, false)",
    [JSON.stringify({ sub: userId, role: "authenticated" })],
  );
}

export async function resetToWorld(): Promise<Client> {
  // Truncate operational tables (keep config + auth users from seed).
  const c = await connect();
  await c.query("RESET ROLE");
  await c.query(`
    -- Tests run against local dev DBs only: pause pg_cron so background
    -- sweeps cannot contend with test transactions on the audit chain lock.
    do $$ declare r record;
    begin
      for r in select jobid from cron.job loop
        perform cron.unschedule(r.jobid);
      end loop;
    exception when undefined_table then null;
    end $$;

    truncate table public.resource_claims, public.triage_scores, public.escalations,
      public.notifications, public.sync_queue, public.matching_batch_runs,
      public.audit_log, public.rate_limits restart identity cascade;
    delete from public.incidents;
    update public.units set status = 'available', current_lat = case callsign
        when 'M-1' then 34.0522 when 'M-2' then 34.0610 when 'R-7' then 34.048 else 34.07 end;
    update public.hospitals
      set diversion = false, diversion_reason = null,
          beds_available = case id
            when '33333333-3333-3333-3333-333333333333' then 45
            else 12 end;
  `);
  return c;
}

let dbAvailable: boolean | null = null;

/** Skip DB-dependent suites gracefully when local Supabase isn't running. */
export async function dbUp(): Promise<boolean> {
  if (dbAvailable !== null) return dbAvailable;
  try {
    const c = await connect();
    await c.query("select 1");
    await c.end();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  return dbAvailable;
}
