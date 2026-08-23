// ═════════════════════════════════════════════════════════════════════════════
// TRIAGEGRID EDGE FUNCTION: match-batch
//
// FR-3 — Batched weighted bipartite assignment.
//
// DESIGN NOTE (per build directives):
// Chosen over greedy nearest-eligible because under simultaneous multi-incident
// load, greedy commits the best unit to whichever incident evaluates first,
// starving later (sometimes higher-priority) incidents. A batched pass solves
// the incident×unit problem globally, minimizing total weighted cost.
// Tradeoff: slightly stale assignments (up to one batch interval, default 60s)
// versus measurably better global utilization; mitigated by the immediate
// trigger path for critical-tier incidents (trg_critical_match_trigger) and by
// escalation re-runs (FR-7).
//
// BATCHING INTERVAL: pg_cron fires `run_matching_batch()` every minute (ceiling);
// the function self-gates against `matching.batch_interval_seconds` so effective
// cadence matches config without redeploying schedules.
//
// UNIT UNAVAILABLE BETWEEN BATCHES: this solver only PROPOSES pairs; finalization
// goes through apply_match_proposals -> try_claim_pair which locks the unit row
// and re-validates. Stale proposals fail as typed conflicts, are skipped here,
// and their incidents simply re-enter the next batch (age accrues toward FR-7
// escalation). No partial-failure state exists because proposals carry no state.
//
// PERFORMANCE: bounded by candidate cap K (config matching.max_candidates_per_
// incident, default 15) — matrix is |incidents| × |candidate-union|, solved by
// Jonker–Volgenant shortest-augmenting-path in O(n²m). Target: <200ms for
// 50 open incidents × 100 available units (measured locally during step 11).
// ═════════════════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Solver lives in _shared so it can be unit-tested with Vitest directly.
import { hungarian, LARGE } from "../_shared/hungarian.ts";

interface Incident {
  id: string;
  agency_id: string;
  priority_tier: string;
  current_lat: number;
  current_lng: number;
  seconds_in_triage: number | null;
}

interface Unit {
  id: string;
  agency_id: string;
  capabilities: string[];
  capacity: number;
  unit_type: string;
  current_lat: number;
  current_lng: number;
  active_load: number;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}


async function handler(req: Request): Promise<Response> {
  const secret = Deno.env.get("MATCH_BATCH_SECRET") ?? "";
  // Shared-secret gate: only the DB (which holds the same secret in config)
  // may invoke this function. The secret rides in x-match-secret because the
  // platform gateway requires the Authorization header to carry a platform
  // JWT (anon key) for transit.
  const auth =
    req.headers.get("x-match-secret") ??
    req.headers.get("Authorization") ?? "";
  if (!secret || auth !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let runId: number | null = null;
  try {
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    runId = body?.run_id ?? null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // server-only; bypasses RLS deliberately
    );

    const { data: cfgRows } = await supabase
      .from("config")
      .select("key,value")
      .in("key", [
        "matching.weights",
        "matching.max_candidates_per_incident",
      ]);
    const cfg = Object.fromEntries((cfgRows ?? []).map((r: any) => [r.key, r.value]));
    const weights = cfg["matching.weights"] ?? {
      distance: 0.5,
      capability_penalty: 0.2,
      capacity_deficit: 0.15,
      active_load: 0.15,
    };
    const K = Number(cfg["matching.max_candidates_per_incident"] ?? 15);

    const { data: problem, error: probErr } = await supabase.rpc(
      "load_matching_problem",
    );
    if (probErr) throw new Error(`load_matching_problem: ${probErr.message}`);

    const incidents: Incident[] = problem.incidents;
    const units: Unit[] = problem.units;

    let pairsApplied = 0;
    let pairsProposed = 0;

    if (incidents.length > 0 && units.length > 0) {
      // Candidate pruning: keep the K nearest units per incident (same-agency).
      const cand = new Map<string, Set<string>>(); // incidentId -> unitIds
      for (const inc of incidents) {
        const ranked = units
          .filter((u) => u.agency_id === inc.agency_id)
          .map((u) => ({
            u,
            d: haversineKm(inc.current_lat, inc.current_lng, u.current_lat, u.current_lng),
          }))
          .sort((a, b) => a.d - b.d)
          .slice(0, K);
        cand.set(inc.id, new Set(ranked.map((r) => r.u.id)));
      }
      const unitIds = [...new Set([...cand.values()].flatMap((s) => [...s]))];
      const colOf = new Map(unitIds.map((id, idx) => [id, idx]));
      const maxDistKm = 50; // normalization ceiling; beyond this effectively excluded

      // Cost matrix: lower = better fit (weights sum to 1, components in [0,1])
      const matrix = incidents.map((inc) => {
        const row = unitIds.map(() => LARGE);
        const required = inc.priority_tier === "critical" ? ["als"] : [];
        for (const uid of cand.get(inc.id)!) {
          const u = units.find((x) => x.id === uid)!;
          const dNorm = Math.min(
            haversineKm(inc.current_lat, inc.current_lng, u.current_lat, u.current_lng) /
              maxDistKm,
            1,
          );
          const capPenalty = required.some((c) => !u.capabilities.includes(c)) ? 1 : 0;
          const deficit = Math.min(1 / u.capacity, 1);
          const load = Math.min(u.active_load / 3, 1);
          row[colOf.get(uid)!] =
            weights.distance * dNorm +
            weights.capability_penalty * capPenalty +
            weights.capacity_deficit * deficit +
            weights.active_load * load;
        }
        return row;
      });

      const rowToCol = hungarian(matrix);

      const pairs = rowToCol
        .map((col, row) => (col >= 0 && matrix[row][col] < LARGE
          ? { incident_id: incidents[row].id, unit_id: unitIds[col] }
          : null))
        .filter((p): p is { incident_id: string; unit_id: string } => p !== null);

      pairsProposed = pairs.length;

      if (pairs.length > 0) {
        const { data: result, error: applyErr } = await supabase.rpc(
          "apply_match_proposals",
          { p_pairs: pairs },
        );
        if (applyErr) throw new Error(`apply_match_proposals: ${applyErr.message}`);
        pairsApplied = result?.applied ?? 0;
      }
    }

    // Heartbeat completion (pg_net fire-and-forget mitigation)
    if (runId != null) {
      await supabase
        .from("matching_batch_runs")
        .update({
          status: "success",
          finished_at: new Date().toISOString(),
          incidents_open: incidents.length,
          pairs_proposed: pairsProposed,
          pairs_applied: pairsApplied,
        })
        .eq("id", runId);
    }

    return new Response(
      JSON.stringify({ ok: true, incidents_open: incidents.length, pairs_proposed: pairsProposed, pairs_applied: pairsApplied }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (runId != null) {
      try {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        await supabase
          .from("matching_batch_runs")
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            error_detail: String(err instanceof Error ? err.message : err),
          })
          .eq("id", runId);
      } catch {
        /* health-check cron will flag the stuck run regardless */
      }
    }
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

Deno.serve(handler);
