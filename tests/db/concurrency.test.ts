import { describe, it, expect, beforeAll } from "vitest";
import { connect, actAs, resetToWorld, IDS, dbUp } from "../helpers/db";

/**
 * Testing requirement: concurrency test firing N simultaneous claim attempts
 * at the same unit/incident pair; exactly one must succeed.
 * FR-6 guarantees: unit-row FOR UPDATE + two partial unique indexes.
 */
describe("FR-6 claim concurrency", () => {
  let world: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    if (!(await dbUp())) return;
    world = await resetToWorld();
  });

  async function seedTriagedIncident(): Promise<string> {
    const r = await world.query(
      `insert into public.incidents (agency_id, status, source, description, current_lat, current_lng)
       values ($1, 'reported', 'dispatcher', 'concurrency test incident', 34.05, -118.24)
       returning id`,
      [IDS.agency],
    );
    const id = r.rows[0].id as string;
    await world.query("update public.incidents set status='triaged' where id=$1", [id]);
    return id;
  }

  async function freeUnit(unitId: string) {
    await world.query(
      "update public.resource_claims set status='cancelled' where unit_id=$1 and status in ('proposed','finalized','active')",
      [unitId],
    );
    await world.query("update public.units set status='available' where id=$1", [unitId]);
  }

  it("N=10 simultaneous try_claim_pair attempts -> exactly 1 success", async () => {
    if (!(await dbUp())) return;
    const incidentId = await seedTriagedIncident();

    const clients = await Promise.all(
      Array.from({ length: 10 }, () => connect()),
    );
    try {
      // Release the barrier as simultaneously as possible from one event loop;
      // each attempt runs on its own connection so Postgres arbitrates locks.
      await Promise.all(clients.map((c) => c.query("select 1")));
      const results = await Promise.all(
        clients.map(async (c) => {
          try {
            await c.query("begin");
            const r = await c.query("select public.try_claim_pair($1,$2,'auto_matcher',true,null) as claim",
              [IDS.unitM1, incidentId]);
            await c.query("commit");
            return { ok: true, claim: r.rows[0]?.claim };
          } catch (e) {
            await c.query("rollback").catch(() => undefined);
            return { ok: false, msg: (e as Error).message };
          }
        }),
      );

      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(9);
      for (const l of losers) {
        expect(l.msg).toMatch(/UNIT_ALREADY_CLAIMED|INCIDENT_NOT_DISPATCHABLE|INCIDENT_ALREADY_CLAIMED/);
      }

      // DB state: exactly one live claim; incident dispatched; unit assigned.
      const claims = await world.query(
        "select count(*)::int as n from public.resource_claims where incident_id=$1 and status in ('proposed','finalized','active')",
        [incidentId],
      );
      expect(claims.rows[0].n).toBe(1);
      const inc = await world.query("select status from public.incidents where id=$1", [incidentId]);
      expect(inc.rows[0].status).toBe("dispatched");
      const u = await world.query("select status from public.units where id=$1", [IDS.unitM1]);
      expect(u.rows[0].status).toBe("assigned");
    } finally {
      await Promise.all(clients.map((c) => c.end()));
      await freeUnit(IDS.unitM1);
    }
  });

  it("a completed claim frees the unit for a later claim", async () => {
    if (!(await dbUp())) return;
    const incident1 = await seedTriagedIncident();
    const first = await world.query(
      "select public.try_claim_pair($1,$2,'auto_matcher',true,null) as id",
      [IDS.unitM1, incident1],
    );
    expect(first.rows[0].id).toBeTruthy();

    // Simulate completion: claim closed, unit released.
    await world.query("update public.resource_claims set status='completed' where id=$1", [
      first.rows[0].id,
    ]);
    await world.query("update public.units set status='available' where id=$1", [IDS.unitM1]);

    // A FRESH triaged incident can now claim the same unit (history preserved).
    const incident2 = await seedTriagedIncident();
    const second = await world.query(
      "select public.try_claim_pair($1,$2,'dispatcher',true,null) as id",
      [IDS.unitM1, incident2],
    );
    expect(second.rows[0].id).toBeTruthy();
  });
});
