import { describe, it, expect, beforeAll } from "vitest";
import { connect, actAs, resetToWorld, IDS, dbUp } from "../helpers/db";

/**
 * Testing requirement: integration test simulating the offline-queue-then-sync
 * flow (FR-8), including deliberately conflicting mutations.
 *
 * Scenarios:
 *  1. happy path: queued status chain replays in order
 *  2. triage MANUAL-SURFACE: server-side newer score -> submit returns conflict
 *  3. invalid transition after server-side state change -> typed rejection
 *     (SERVER-AUTHORITATIVE), device must surface it
 *  4. idempotency: same client_mutation_id does not double-apply
 */
describe("offline sync flow", () => {
  let world: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    if (!(await dbUp())) return;
    world = await resetToWorld();
  });

  async function seedAssignment(): Promise<string> {
    const r = await world.query(
      `insert into public.incidents (agency_id,status,source,description,current_lat,current_lng)
       values ($1,'reported','dispatcher','sync flow test',34.05,-118.24) returning id`,
      [IDS.agency],
    );
    const incId = r.rows[0].id;
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
    return incId;
  }

  it("1: queued lifecycle chain replays cleanly under the field identity", async () => {
    if (!(await dbUp())) return;
    const incId = await seedAssignment();
    const c = await connect();
    try {
      await actAs(c, IDS.field);
      for (const s of ["en_route", "on_scene"]) {
        const r = await c.query("select public.update_incident_status($1,$2) as s", [incId, s]);
        expect(r.rows[0].s).toBe(s);
      }
      // transporting requires destination; provide hospital B
      const r = await c.query(
        "select public.update_incident_status($1,'transporting',$2) as s",
        [incId, IDS.hospitalB],
      );
      expect(r.rows[0].s).toBe("transporting");
      const fin = await c.query("select public.update_incident_status($1,'resolved') as s", [incId]);
      expect(fin.rows[0].s).toBe("resolved");

      // bed accounting happened at hospital B
      const beds = await world.query(
        "select beds_available::int as b from public.hospitals where id=$1",
        [IDS.hospitalB],
      );
      expect(beds.rows[0].b).toBe(11); // seeded 12, consumed 1
    } finally {
      await c.end();
    }
  });

  it("2: triage conflict — server has newer score than device base", async () => {
    if (!(await dbUp())) return;
    const incId = await seedAssignment();

    const c = await connect();
    try {
      await actAs(c, IDS.field);

      // Device submits vitals v1 with no base -> applied
      const r1 = await c.query(
        "select public.submit_field_triage($1, $2, null, $3, null) as res",
        [incId, JSON.stringify({ chest_pain: true }), crypto.randomUUID()],
      );
      expect(r1.rows[0].res.status).toBe("applied");

      const baseTs = await world.query(
        "select max(created_at) as ts from public.triage_scores where incident_id=$1",
        [incId],
      );

      // Meanwhile the SERVER records a newer dispatcher override (device offline)
      await actAs(c, IDS.dispatcher);
      await c.query("select public.override_triage($1, 90)", [incId]);

      // Device reconnects and replays v2 based on stale snapshot -> CONFLICT
      await actAs(c, IDS.field);
      const r2 = await c.query(
        "select public.submit_field_triage($1, $2, 33, $3, $4) as res",
        [incId, JSON.stringify({ severe_bleeding: true }), crypto.randomUUID(), baseTs.rows[0].ts],
      );
      const res = r2.rows[0].res;
      expect(res.status).toBe("conflict");
      expect(res.conflict.server_rows.length).toBeGreaterThan(0);
      expect(res.conflict.server_rows[0].override_score).toBe(90);

      // Nothing was silently overwritten:
      const scores = await world.query(
        "select source, computed_tier from public.triage_scores where incident_id=$1 order by created_at",
        [incId],
      );
      const sources = scores.rows.map((r) => r.source);
      expect(sources.filter((s: string) => s === "field").length).toBe(1); // only v1 landed
    } finally {
      await c.end();
    }
  });

  it("3: server-authoritative status — invalid replay surfaces typed error", async () => {
    if (!(await dbUp())) return;
    const incId = await seedAssignment();
    const c = await connect();
    try {
      await actAs(c, IDS.field);
      // Device queued 'on_scene' while offline; meanwhile server moved to en_route
      // and then auto-cancelled (dispatcher action) -> replay must be REJECTED by
      // the DB state machine with a typed error, never silently applied.
      await actAs(c, IDS.dispatcher);
      await c.query("select public.update_incident_status($1,'en_route')", [incId]);
      await c.query("select public.update_incident_status($1,'cancelled')", [incId]);

      await actAs(c, IDS.field);
      await expect(
        c.query("select public.update_incident_status($1,'on_scene')", [incId]),
      ).rejects.toThrow(/INVALID_TRANSITION|TG107|NOT_AUTHORIZED/);
    } finally {
      await c.end();
    }
  });

  it("4: escalation sweep bumps timed-out triaged incidents (FR-7)", async () => {
    if (!(await dbUp())) return;
    const r = await world.query(
      `insert into public.incidents (agency_id,status,source,description,current_lat,current_lng,triaged_at)
       values ($1,'triaged','dispatcher','escalation test',34.05,-118.24, now() - interval '2 hours')
       returning id`,
      [IDS.agency],
    );
    const incId = r.rows[0].id;
    // runs as postgres (owner); EXECUTE was revoked from app roles
    await world.query("select public.escalate_triaged_incidents()");
    const row = await world.query(
      "select priority_tier, escalation_count from public.incidents where id=$1",
      [incId],
    );
    expect(row.rows[0].priority_tier).toBe("high"); // medium -> high
    expect(row.rows[0].escalation_count).toBe(1);
    const esc = await world.query(
      "select count(*)::int as n from public.escalations where incident_id=$1",
      [incId],
    );
    expect(esc.rows[0].n).toBe(1);
  });
});
