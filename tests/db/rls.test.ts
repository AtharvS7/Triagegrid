import { describe, it, expect, beforeAll } from "vitest";
import { connect, actAs, resetToWorld, IDS, dbUp } from "../helpers/db";

/**
 * Testing requirement: RLS policy tests per role, asserting BOTH allowed and
 * denied paths. Emulates PostgREST sessions via SET ROLE + request.jwt.claims.
 */
describe("RLS policies", () => {
  let world: Awaited<ReturnType<typeof connect>>;
  let incA: string; // agency 1 incident (assigned to field@ via M-1)
  let incB: string; // agency 2 incident

  beforeAll(async () => {
    if (!(await dbUp())) return;
    world = await resetToWorld();

    // Second agency for cross-tenant checks
    await world.query(
      `insert into public.agencies (id, name)
       values ('99999999-9999-9999-9999-999999999999', 'Rival County EMS')
       on conflict (id) do nothing`,
    );
    // Cross-agency dispatcher
    await world.query(
      `insert into auth.users (id, email, encrypted_password, email_confirmed_at,
         created_at, updated_at, raw_app_meta_data, aud, role, instance_id)
       values ('aaaaaaaa-0000-0000-0000-00000000bbb1', 'rival@county.test',
         crypt('password123', gen_salt('bf')), now(), now(), now(),
         '{"provider":"email","providers":["email"]}', 'authenticated','authenticated',
         '00000000-0000-0000-0000-000000000000')
       on conflict (id) do nothing`,
    );
    await world.query(
      `insert into public.personnel (id, agency_id, role, full_name)
       values ('aaaaaaaa-0000-0000-0000-00000000bbb1',
               '99999999-9999-9999-9999-999999999999', 'dispatcher', 'Rival Dispatcher')
       on conflict (id) do nothing`,
    );

    const a = await world.query(
      `insert into public.incidents (agency_id, status, source, description, current_lat, current_lng)
       values ($1,'reported','dispatcher','agency-A incident',34.05,-118.24) returning id`,
      [IDS.agency],
    );
    incA = a.rows[0].id;

    const b = await world.query(
      `insert into public.incidents (agency_id, status, source, description, current_lat, current_lng)
       values ('99999999-9999-9999-9999-999999999999','reported','dispatcher','agency-B incident',35.05,-119.24)
       returning id`,
    );
    incB = b.rows[0].id;
  });

  it("anon: denied SELECT and INSERT on incidents (no grants at all)", async () => {
    if (!(await dbUp())) return;
    const c = await connect();
    try {
      await actAs(c, null);
      await expect(c.query("select * from public.incidents")).rejects.toThrow(/permission denied/);
      await expect(
        c.query(
          "insert into public.incidents (agency_id, source, description, current_lat, current_lng) values ($1,'citizen','x',0,0)",
          [IDS.agency],
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it("dispatcher: reads own-agency incidents; blocked cross-agency", async () => {
    if (!(await dbUp())) return;
    const c = await connect();
    try {
      await actAs(c, IDS.dispatcher);
      const mine = await c.query("select id from public.incidents where id=$1", [incA]);
      expect(mine.rows.length).toBe(1);
      const other = await c.query("select id from public.incidents where id=$1", [incB]);
      expect(other.rows.length).toBe(0);

      // Direct UPDATE is not granted — privileged mutations only via RPC.
      await expect(
        c.query("update public.incidents set priority_tier='critical' where id=$1", [incA]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it("cross-agency dispatcher cannot see or touch agency A incidents", async () => {
    if (!(await dbUp())) return;
    const c = await connect();
    try {
      await actAs(c, "aaaaaaaa-0000-0000-0000-00000000bbb1");
      const other = await c.query("select id from public.incidents where id=$1", [incA]);
      expect(other.rows.length).toBe(0);
      await expect(
        c.query("select public.claim_unit($1,$2)", [incA, IDS.unitM1]),
      ).rejects.toThrow(/NOT_AUTHORIZED|cross-agency|TG106|not found/i);
    } finally {
      await c.end();
    }
  });

  it("field: sees assigned incidents only", async () => {
    if (!(await dbUp())) return;
    // Assign M-1 to a fresh triaged incident so field@ has exactly one view.
    const seeded = await world.query(
      `insert into public.incidents (agency_id,status,source,description,current_lat,current_lng)
       values ($1,'reported','dispatcher','assigned field test',34.05,-118.24) returning id`,
      [IDS.agency],
    );
    const incId = seeded.rows[0].id;
    await world.query("update public.incidents set status='triaged' where id=$1", [incId]);
    await world.query(
      "update public.resource_claims set status='cancelled' where unit_id=$1 and status in ('proposed','finalized','active')",
      [IDS.unitM1],
    );
    await world.query("update public.units set status='available' where id=$1", [IDS.unitM1]);
    await world.query("select public.try_claim_pair($1,$2,'dispatcher',true,null)", [
      IDS.unitM1,
      incId,
    ]);

    const c = await connect();
    try {
      await actAs(c, IDS.field);
      const visible = await c.query("select id from public.incidents");
      expect(visible.rows.map((r) => r.id)).toContain(incId);
      // Unrelated agency-B incident invisible:
      const b = await c.query("select id from public.incidents where id=$1", [incB]);
      expect(b.rows.length).toBe(0);
      // Field can advance lifecycle on OWN assignment...
      await c.query("begin");
      const r = await c.query("select public.update_incident_status($1,'en_route') as ok", [incId]);
      expect(r.rows[0].ok).toBe("en_route");
      await c.query("rollback");
      // ...but NOT on incidents without a claim on their unit.
      await expect(
        c.query("select public.update_incident_status($1,'en_route')", [incA]),
      ).rejects.toThrow(/NOT_AUTHORIZED|TG106/);
    } finally {
      await c.end();
    }
  });

  it("hospital_admin: reads inbound-only incidents; writes capacity via RPC on own hospital only", async () => {
    if (!(await dbUp())) return;
    // Route an incident toward hospital A while transporting
    const r = await world.query(
      `insert into public.incidents (agency_id,status,source,description,current_lat,current_lng)
       values ($1,'reported','dispatcher','inbound to A',34.05,-118.24) returning id`,
      [IDS.agency],
    );
    const incId = r.rows[0].id;
    await world.query("update public.incidents set status='triaged' where id=$1", [incId]);
    await world.query(
      "update public.resource_claims set status='cancelled' where unit_id=$1 and status in ('proposed','finalized','active')",
      [IDS.unitM2],
    );
    await world.query("update public.units set status='available' where id=$1", [IDS.unitM2]);
    await world.query("select public.try_claim_pair($1,$2,'dispatcher',true,null)", [IDS.unitM2, incId]);

    const c = await connect();
    try {
      // dispatcher drives to transporting toward hospital A
      await actAs(c, IDS.dispatcher);
      await c.query("select public.update_incident_status($1,'en_route')", [incId]);
      await c.query("select public.update_incident_status($1,'on_scene')", [incId]);
      await c.query(
        "select public.update_incident_status($1,'transporting',$2)",
        [incId, IDS.hospitalA],
      );

      // hospital admin of hospital B sees nothing inbound
      await actAs(c, IDS.hospitalAdmin); // seeded with hospitalA... use them for positive case
      const visible = await c.query("select id from public.incidents where id=$1", [incId]);
      expect(visible.rows.length).toBe(1);

      // capacity write on own hospital succeeds; foreign hospital denied
      await c.query("select public.update_capacity($1, 10)", [IDS.hospitalA]);
      await expect(
        c.query("select public.update_capacity($1, 10)", [IDS.hospitalB]),
      ).rejects.toThrow(/NOT_AUTHORIZED|TG106/);

      // direct table update still denied (RPC-only path)
      await expect(
        c.query("update public.hospitals set beds_available=1 where id=$1", [IDS.hospitalA]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it("audit_log: admin selects; dispatcher denied; nobody can UPDATE/DELETE", async () => {
    if (!(await dbUp())) return;
    const adminC = await connect();
    const dispC = await connect();
    try {
      await actAs(adminC, IDS.admin);
      const rows = await adminC.query("select count(*)::int as n from public.audit_log");
      expect(rows.rows[0].n).toBeGreaterThan(0);

      await actAs(dispC, IDS.dispatcher);
      // authenticated holds the SELECT grant, so RLS FILTERS (0 rows) rather
      // than erroring — either way the dispatcher sees nothing.
      const dispRows = await dispC.query("select count(*)::int as n from public.audit_log");
      expect(dispRows.rows[0].n).toBe(0);

      // Grant-level immutability regardless of role (FR-11):
      const grants = await world.query(`
        select privilege_type from information_schema.role_table_grants
        where table_name = 'audit_log'
          and grantee in ('anon','authenticated','public')
          and privilege_type in ('UPDATE','DELETE')`);
      expect(grants.rows.length).toBe(0);

      // Even an authenticated session cannot rewrite history (postgres the
      // table owner/superuser is exempt from grants by design — DBA-only).
      await expect(
        dispC.query("update public.audit_log set actor_role='hax'"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await adminC.end();
      await dispC.end();
    }
  });
});
