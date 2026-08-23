"use client";

import { listQueue, removeQueued, bumpAttempts, saveConflict, type QueuedMutation } from "./db";

/**
 * FR-8 SYNC ENGINE
 * ----------------
 * Conflict policy matrix (authoritative copy in supabase/migrations/
 * 00004_field_sync_rpcs.sql header):
 *
 *   incidents.status            → SERVER-AUTHORITATIVE + ORDERED REPLAY:
 *     queued transitions are replayed against live server state; a transition
 *     the state machine rejects is treated as CONFLICT and surfaced (never
 *     silently dropped), because e.g. auto-escalation may have moved the
 *     incident while the device was offline.
 *   triage_scores.vitals        → MANUAL-SURFACE: submit_field_triage returns
 *     {status:'conflict'} when the server holds newer data than our base;
 *     stored locally as a conflict for the UI to adjudicate. NEVER overwritten.
 *   units position              → LWW with server-side GPS drift guard backstop.
 *
 * Ordering: queue is drained FIFO per device; status chains replay in the
 * order the user performed them (created_at sort). Idempotency keys make any
 * retry after partial failure safe (server dedupes via sync_queue /
 * client_mutation_id).
 */

export interface MutationResult {
  id: string;
  outcome: "applied" | "duplicate" | "conflict" | "rejected" | "error";
  detail?: Record<string, unknown>;
}

export async function flushQueue(): Promise<MutationResult[]> {
  const queue = await listQueue();
  if (queue.length === 0) return [];

  // /api/sync applies mutations sequentially under the service role, records
  // every attempt in sync_queue (server mirror), and returns per-item results.
  let results: MutationResult[];
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mutations: queue }),
    });
    if (!res.ok) throw new Error(`sync endpoint ${res.status}`);
    results = (await res.json()).results as MutationResult[];
  } catch {
    // Network still down — leave queue intact, try again later.
    return [];
  }

  for (const r of results) {
    if (r.outcome === "conflict") {
      await saveConflict({
        id: crypto.randomUUID(),
        mutation_id: r.id,
        entity: String(r.detail?.entity ?? "unknown"),
        entity_id: String(r.detail?.incident_id ?? r.detail?.entity_id ?? ""),
        detail: r.detail ?? {},
      });
    }
    if (r.outcome !== "error") {
      await removeQueued(r.id);
    } else {
      await bumpAttempts(r.id);
    }
  }
  return results;
}

export function installConnectivityHandlers(onFlush: () => void) {
  const handler = () => {
    if (navigator.onLine) onFlush();
  };
  window.addEventListener("online", handler);
  const interval = window.setInterval(handler, 30_000);
  return () => {
    window.removeEventListener("online", handler);
    window.clearInterval(interval);
  };
}

export type { QueuedMutation };
