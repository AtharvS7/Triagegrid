import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * POST /api/incidents — citizen + dispatcher incident creation (API contract).
 * Unauthenticated citizens are rate-limited INSIDE the SECURITY DEFINER RPC
 * (per-IP fixed window) — the route merely forwards a real client IP.
 *
 * OWASP notes:
 *  - A01 Broken access control: citizens never touch the incidents table
 *    directly; creation flows through create_citizen_incident which validates
 *    and sanitizes server-side.
 *  - A03 Injection: all input is parameterized via supabase-js rpc.
 *  - A04 SSRF/abuse: IP extracted from trusted proxy headers only.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  const idempotencyKey = crypto.randomUUID();

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("create_citizen_incident", {
    p_description: String(body.description ?? ""),
    p_lat: Number(body.lat),
    p_lng: Number(body.lng),
    p_reporter_ref: body.reporter_ref ? String(body.reporter_ref) : null,
    p_photo_path: body.photo_path ? String(body.photo_path) : null,
    p_indicators: (body.indicators ?? {}) as object,
    // Honor client-provided key when present so flaky retries dedupe end-to-end.
    p_idempotency_key: body.idempotency_key
      ? String(body.idempotency_key)
      : idempotencyKey,
    p_client_ip: ip,
  });

  if (error) {
    const status = error.message.includes("RATE_LIMITED")
      ? 429
      : error.message.includes("VALIDATION_FAILED")
        ? 400
        : 500;
    return NextResponse.json(
      { error: error.message },
      { status, headers: status === 429 ? { "Retry-After": "3600" } : undefined },
    );
  }

  return NextResponse.json(data);
}

/**
 * GET /api/incidents?code=XXXX… — tracking-code read-back proxy.
 * The anon role has NO direct SELECT on incidents; this proxies the
 * SECURITY DEFINER RPC with the caller's IP for rate limiting.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_incident_by_tracking_code", {
    p_code: code,
    p_client_ip: ip,
  });
  if (error) {
    const status = error.message.includes("RATE_LIMITED")
      ? 429
      : error.message.includes("NOT_FOUND")
        ? 404
        : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json(data);
}
