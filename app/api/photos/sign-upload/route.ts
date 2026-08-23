import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * POST /api/photos/sign-upload — issues a single-use signed upload URL for a
 * citizen photo into the PRIVATE incident-photos bucket. Path convention:
 * {agency_id}/{random}. Citizens never receive bucket-wide credentials.
 * Rate limiting rides on create_citizen_incident; this endpoint additionally
 * caps uploads per IP via the same limiter scope.
 */
export async function POST(req: NextRequest) {
  let body: { agency_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const supabase = createServiceClient();

  // Reuse the citizen rate limiter for upload issuance (shared hourly budget).
  const { data: allowed } = await supabase.rpc("check_rate_limit", {
    p_scope: "citizen_photo",
    p_identifier: ip,
    p_limit: 5,
    p_window_seconds: 3600,
  });
  if (!allowed) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  const agencyId =
    body.agency_id ??
    (
      await supabase.from("agencies").select("id").order("created_at").limit(1)
    ).data?.[0]?.id;
  if (!agencyId) {
    return NextResponse.json({ error: "no agency" }, { status: 500 });
  }

  const ext = "jpg";
  const path = `${agencyId}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage
    .from("incident-photos")
    .createSignedUploadUrl(path);

  if (error || !data) {
    return NextResponse.json({ error: "signing failed" }, { status: 500 });
  }
  return NextResponse.json({
    path,
    token: data.token,
    signed_url: data.signedUrl,
  });
}
