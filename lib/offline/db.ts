"use client";

import { openDB, type IDBPDatabase } from "idb";

/**
 * IndexedDB outbox for offline-tolerant field operations (FR-8).
 * Every mutation gets a client-generated idempotency key (uuid) BEFORE it is
 * attempted; the server deduplicates on that key, so retries after flaky
 * reconnects can never double-apply.
 */

export type MutationKind =
  | "incident_status"
  | "triage_submit"
  | "unit_position";

export interface QueuedMutation {
  id: string; // idempotency key (client-generated uuid)
  kind: MutationKind;
  payload: Record<string, unknown>;
  client_ts: string; // device clock, forensics only (server clock is authoritative)
  attempts: number;
  created_at: string;
}

export interface ConflictRecord {
  id: string;
  mutation_id: string;
  entity: string;
  entity_id: string;
  detail: Record<string, unknown>; // server + client versions for side-by-side UI
  resolved: boolean;
  created_at: string;
}

const DB_NAME = "triagegrid";
const DB_VERSION = 1;

let dbp: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains("outbox")) {
          const os = d.createObjectStore("outbox", { keyPath: "id" });
          os.createIndex("created_at", "created_at");
        }
        if (!d.objectStoreNames.contains("conflicts")) {
          d.createObjectStore("conflicts", { keyPath: "id" });
        }
        if (!d.objectStoreNames.contains("kv")) {
          d.createObjectStore("kv");
        }
      },
    });
  }
  return dbp;
}

export async function enqueue(m: Omit<QueuedMutation, "attempts" | "created_at">) {
  const d = await db();
  await d.put("outbox", {
    ...m,
    attempts: 0,
    created_at: new Date().toISOString(),
  } satisfies QueuedMutation);
}

export async function listQueue(): Promise<QueuedMutation[]> {
  const d = await db();
  const all = (await d.getAll("outbox")) as QueuedMutation[];
  return all.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function removeQueued(id: string) {
  const d = await db();
  await d.delete("outbox", id);
}

export async function bumpAttempts(id: string) {
  const d = await db();
  const tx = d.transaction("outbox", "readwrite");
  const store = tx.objectStore("outbox");
  const cur = (await store.get(id)) as QueuedMutation | undefined;
  if (cur) await store.put({ ...cur, attempts: cur.attempts + 1 });
  await tx.done;
}

export async function saveConflict(c: Omit<ConflictRecord, "resolved" | "created_at">) {
  const d = await db();
  await d.put("conflicts", { ...c, resolved: false, created_at: new Date().toISOString() });
}

export async function listConflicts(): Promise<ConflictRecord[]> {
  const d = await db();
  return ((await d.getAll("conflicts")) as ConflictRecord[]).filter((c) => !c.resolved);
}

export async function resolveConflict(id: string) {
  const d = await db();
  const tx = d.transaction("conflicts", "readwrite");
  const cur = (await tx.store.get(id)) as ConflictRecord | undefined;
  if (cur) await tx.store.put({ ...cur, resolved: true });
  await tx.done;
}

/** Last-known incident snapshot cache so the PWA renders assigned data offline. */
export interface IncidentCacheEntry {
  incident_id: string;
  snapshot: unknown;
  cached_at: string;
}

export async function cacheIncident(entry: IncidentCacheEntry) {
  const d = await db();
  await d.put("kv", entry, `incident:${entry.incident_id}`);
}

export async function readCachedIncident(incidentId: string): Promise<unknown | null> {
  try {
    const d = await db();
    return (await d.get("kv", `incident:${incidentId}`)) ?? null;
  } catch {
    return null;
  }
}
