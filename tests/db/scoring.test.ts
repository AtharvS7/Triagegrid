import { describe, it, expect, beforeAll } from "vitest";
import { connect, actAs, resetToWorld, IDS, dbUp } from "../helpers/db";

/**
 * Testing requirement: unit tests for the triage scoring function across
 * representative severity inputs. compute_triage_score is config-driven
 * (migration 0003); these tests pin its contract.
 */
describe("triage scoring (compute_triage_score)", () => {
  let c: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    if (!(await dbUp())) return;
    c = await resetToWorld();
  });

  async function score(indicators: object): Promise<{ score: number; tier: string }> {
    const r = await c.query(
      "select score::float8 as score, tier from public.compute_triage_score($1)",
      [JSON.stringify(indicators)],
    );
    return r.rows[0];
  }

  it("empty indicators -> low", async () => {
    if (!(await dbUp())) return;
    expect(await score({})).toEqual({ score: 0, tier: "low" });
  });

  it("single mild indicator (chest_pain 15) stays low", async () => {
    if (!(await dbUp())) return;
    const s = await score({ chest_pain: true });
    expect(s.score).toBe(15);
    expect(s.tier).toBe("low");
  });

  it("medium cutoff at 20 (severe_bleeding)", async () => {
    if (!(await dbUp())) return;
    const s = await score({ severe_bleeding: true });
    expect(s.score).toBe(20);
    expect(s.tier).toBe("medium");
  });

  it("high tier (respiratory_distress + entrapment = 40... high needs >=45)", async () => {
    if (!(await dbUp())) return;
    const s = await score({ respiratory_distress: true, entrapment: true, chest_pain: true });
    expect(s.score).toBe(55);
    expect(s.tier).toBe("high");
  });

  it("critical tier (unresponsive + respiratory_distress + amputation = 80)", async () => {
    if (!(await dbUp())) return;
    const s = await score({
      unresponsive: true,
      respiratory_distress: true,
      traumatic_amputation: true,
    });
    expect(s.score).toBe(80);
    expect(s.tier).toBe("critical");
  });

  it("numeric indicators multiply weight, capped at 5", async () => {
    if (!(await dbUp())) return;
    const three = await score({ multiple_victims: 3 });
    const ten = await score({ multiple_victims: 10 });
    expect(three.score).toBe(30);   // 10 * 3
    expect(ten.score).toBe(50);     // capped at multiplier 5
  });

  it("unknown indicators contribute zero", async () => {
    if (!(await dbUp())) return;
    expect((await score({ alien_abduction: true })).score).toBe(0);
  });

  it("walking_wounded subtracts", async () => {
    if (!(await dbUp())) return;
    expect((await score({ walking_wounded: true })).score).toBe(-20);
  });

  it("override_triage retains computed values and moves incident tier", async () => {
    if (!(await dbUp())) return;
    await actAs(c, null);
    // seed an incident via the citizen path
    const ins = await c.query(
      "select (public.create_citizen_incident('scoring override test', 34.05, -118.24, null, null, '{}', gen_random_uuid(), '10.9.0.1'))->'incident'->>'id' as id",
    );
    const incId = ins.rows[0].id;

    await actAs(c, IDS.dispatcher);
    await c.query("select public.override_triage($1, 70)", [incId]);

    const row = await c.query(
      `select computed_score, computed_tier, override_score, override_tier
       from public.triage_scores where incident_id = $1
       order by created_at desc limit 1`,
      [incId],
    );
    expect(Number(row.rows[0].computed_score)).toBe(0);
    expect(row.rows[0].computed_tier).toBe("low");
    expect(Number(row.rows[0].override_score)).toBe(70);
    expect(row.rows[0].override_tier).toBe("critical");

    const inc = await c.query(
      "select priority_tier from public.incidents where id = $1",
      [incId],
    );
    expect(inc.rows[0].priority_tier).toBe("critical");
  });
});
