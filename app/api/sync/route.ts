import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { QueuedMutation } from "@/lib/offline/sync";

/**
 * POST /api/sync — batched offline mutation reconciliation (FR-8).
 *
 * Auth: callers must hold a valid Supabase session (field personnel). The
 * service-role client applies mutations through the SAME role-checked SECURITY
 * DEFINER RPCs used online, so authorization and business rules are identical
 * on both paths — the endpoint is a transport, not a privilege escalation.
 *
 * Every attempt is mirrored into sync_queue (server-side ledger) with outcome
 * applied | conflict | rejected, keyed by client_mutation_id for idempotency.
 */

interface SyncResult {
  id: string;
  outcome: "applied" | "duplicate" | "conflict" | "rejected" | "error";
  detail?: Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const supabase = createServiceClient();

  // Validate the caller's session before touching anything.
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData } = await supabase.auth.getUser(token);
  if (!userData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = userData.user.id;
  // Reused for identity-forwarding on role-checked RPCs below.
  const callerToken = token;

  let body: { mutations?: QueuedMutation[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const queue = Array.isArray(body.mutations) ? body.mutations.slice(0, 100) : [];
  if (queue.length === 0) {
    return NextResponse.json({ results: [] as SyncResult[] });
  }

  // Resolve caller's personnel row for audit attribution.
  const { data: person } = await supabase
    .from("personnel")
    .select("id, agency_id, role")
    .eq("id", userId)
    .single();

  const results: SyncResult[] = [];

  // Sequential application preserves user-performed ordering (status chains).
  for (const m of queue) {
    if (!m.id || !m.kind || typeof m.payload !== "object" || m.payload === null) {
      results.push({ id: m.id ?? "?", outcome: "rejected", detail: { reason: "malformed" } });
      continue;
    }

    // Idempotency (FR-8): a retried mutation whose key was already APPLIED
    // must never re-execute — return duplicate so the device drops it.
    const { data: prior } = await supabase
      .from("sync_queue")
      .select("status")
      .eq("client_mutation_id", m.id)
      .maybeSingle();
    if (prior?.status === "applied") {
      results.push({ id: m.id, outcome: "duplicate" });
      continue;
    }

    let result: SyncResult;
    try {
      switch (m.kind) {
        case "incident_status":
          result = await applyIncidentStatus(supabase, m);
          break;
        case "triage_submit":
          result = await applyTriageSubmit(supabase, m, callerToken);
          break;
        case "unit_position":
          result = await applyUnitPosition(supabase, m, callerToken);
          break;
        default:
          result = { id: m.id, outcome: "rejected", detail: { reason: "unknown kind" } };
      }
    } catch (err) {
      result = {
        id: m.id,
        outcome: "error",
        detail: { message: err instanceof Error ? err.message : String(err) },
      };
    }

    // Server-side mirror of every reconciliation attempt.
    await supabase.from("sync_queue").upsert(
      {
        client_mutation_id: m.id,
        personnel_id: person?.id ?? null,
        entity:
          m.kind === "incident_status"
            ? "incidents"
            : m.kind === "triage_submit"
              ? "triage_scores"
              : "units",
        entity_id: (m.payload.incident_id as string) ??
                   (m.payload.unit_id as string) ?? null,
        op: m.kind === "triage_submit" ? "INSERT" : "UPDATE",
        payload: m.payload,
        client_timestamp: m.client_ts ?? null,
        status:
          result.outcome === "applied" || result.outcome === "duplicate"
            ? "applied"
            : result.outcome === "conflict"
              ? "conflict"
              : "rejected",
        conflict_detail: result.detail ?? null,
        applied_at: result.outcome === "applied" ? new Date().toISOString() : null,
      },
      { onConflict: "client_mutation_id" },
    );

    results.push(result);
  }

  return NextResponse.json({ results });
}

async function applyIncidentStatus(
  supabase: ReturnType<typeof createServiceClient>,
  m: QueuedMutation,
): Promise<SyncResult> {
  const p = m.payload as {
    incident_id: string;
    new_status: string;
    destination_hospital_id?: string | null;
    diversion_ack?: boolean;
  };

  const { data, error } = await supabase.rpc("update_incident_status", {
    p_incident_id: p.incident_id,
    p_new_status: p.new_status,
    p_destination_hospital_id: p.destination_hospital_id ?? null,
    p_diversion_ack: false,
    p_capacity_ack: false,
  });

  if (!error) return { id: m.id, outcome: "applied" };

  const msg = error.message;
  if (msg.includes("TG104")) {
    return {
      id: m.id,
      outcome: "conflict",
      detail: {
        entity: "hospitals",
        incident_id: p.incident_id,
        code: "HOSPITAL_ON_DIVERSION",
        message: msg,
      },
    };
  }
  if (msg.includes("TG105")) {
    return {
      id: m.id,
      outcome: "conflict",
      detail: {
        entity: "hospitals",
        incident_id: p.incident_id,
        code: "HOSPITAL_AT_CAPACITY",
        message: msg,
      },
    };
  }
  if (msg.includes("INVALID_TRANSITION") || msg.includes("TG102")) {
    // SERVER-AUTHORITATIVE: state moved while offline (auto-escalation etc).
    return {
      id: m.id,
      outcome: "conflict",
      detail: {
        entity: "incidents",
        incident_id: p.incident_id,
        code: "INVALID_TRANSITION",
        attempted_status: p.new_status,
        message: msg,
      },
    };
  }
  if (msg.includes("TG106")) {
    return { id: m.id, outcome: "rejected", detail: { code: "NOT_AUTHORIZED", message: msg } };
  }
  throw new Error(msg);
}

async function applyTriageSubmit(
  supabase: ReturnType<typeof createServiceClient>,
  m: QueuedMutation,
  callerToken: string,
): Promise<SyncResult> {
  const p = m.payload as {
    incident_id: string;
    vitals: Record<string, unknown>;
    override_score?: number | null;
    base_created_at?: string | null;
  };

  // Identity forwarding: re-issue the caller's own JWT so the role-checked
  // RPC sees the field user, not the service role. The endpoint is transport
  // only — authorization happens inside the same RPC used online.
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const authedClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
    auth: { persistSession: false },
  });

  const { data, error } = await authedClient.rpc("submit_field_triage", {
    p_incident_id: p.incident_id,
    p_vitals: p.vitals,
    p_override_score: p.override_score ?? null,
    p_client_mutation_id: m.id,
    p_base_created_at: p.base_created_at ?? null,
  });

  if (error) {
    if (error.message.includes("TG106")) {
      return { id: m.id, outcome: "rejected", detail: { code: "NOT_AUTHORIZED" } };
    }
    throw new Error(error.message);
  }

  if (data?.status === "conflict") {
    return {
      id: m.id,
      outcome: "conflict",
      detail: {
        entity: "triage_scores",
        incident_id: p.incident_id,
        code: "NEWER_TRIAGE_SERVER_SIDE",
        server_rows: data.conflict?.server_rows,
        client_vitals: p.vitals,
        client_override: p.override_score ?? null,
      },
    };
  }
  return { id: m.id, outcome: "applied" };
}

async function applyUnitPosition(
  supabase: ReturnType<typeof createServiceClient>,
  m: QueuedMutation,
  callerToken: string,
): Promise<SyncResult> {
  const p = m.payload as { unit_id: string; lat: number; lng: number };

  // Same identity-forwarding pattern as triage submit.
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const authedClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
    auth: { persistSession: false },
  });

  const { error } = await authedClient.rpc("update_unit_position", {
    p_unit_id: p.unit_id,
    p_lat: p.lat,
    p_lng: p.lng,
  });
  if (error) {
    if (error.message.includes("IMPLAUSIBLE_LOCATION_JUMP")) {
      // Drift guard rejected: drop as rejected (device keeps last good fix).
      return { id: m.id, outcome: "rejected", detail: { code: "GPS_DRIFT_REJECTED" } };
    }
    if (error.message.includes("TG106")) {
      return { id: m.id, outcome: "rejected", detail: { code: "NOT_AUTHORIZED" } };
    }
    throw new Error(error.message);
  }
  return { id: m.id, outcome: "applied" };
}
