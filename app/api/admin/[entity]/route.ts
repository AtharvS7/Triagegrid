import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Admin-only server routes (System Admin persona).
 * RLS grants admins SELECT only; writes for roster/hospital management go
 * through here, gated by a validated admin session. Audit trails still apply:
 * service-role writes trigger the same audit triggers.
 */

async function requireAdmin(req: NextRequest) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const supabase = createServiceClient();
  const { data } = await supabase.auth.getUser(token);
  if (!data?.user) return null;
  const { data: person } = await supabase
    .from("personnel")
    .select("role")
    .eq("id", data.user.id)
    .single();
  return person?.role === "admin" ? supabase : null;
}

const TABLES = new Set(["personnel", "units", "hospitals"]);

export async function POST(
  req: NextRequest,
  { params }: { params: { entity: string } },
) {
  const supabase = await requireAdmin(req);
  if (!supabase) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!TABLES.has(params.entity)) {
    return NextResponse.json({ error: "unknown entity" }, { status: 404 });
  }

  const body = await req.json();

  if (params.entity === "units") {
    const { data: agency } = await supabase
      .from("agencies")
      .select("id")
      .order("created_at")
      .limit(1);
    const { data, error } = await supabase
      .from("units")
      .insert({
        agency_id: body.agency_id ?? agency?.[0]?.id,
        callsign: String(body.callsign ?? "").trim(),
        unit_type: String(body.unit_type ?? "ambulance"),
        capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
        capacity: Math.max(1, Number(body.capacity ?? 1)),
        status: "available",
        current_lat: Number(body.current_lat),
        current_lng: Number(body.current_lng),
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data);
  }

  if (params.entity === "hospitals") {
    const { data: agency } = await supabase
      .from("agencies")
      .select("id")
      .order("created_at")
      .limit(1);
    const { data, error } = await supabase
      .from("hospitals")
      .insert({
        agency_id: body.agency_id ?? agency?.[0]?.id,
        name: String(body.name ?? "").trim(),
        current_lat: Number(body.current_lat),
        current_lng: Number(body.current_lng),
        total_beds: Math.max(0, Number(body.total_beds ?? 0)),
        beds_available: Math.max(0, Number(body.beds_available ?? 0)),
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(data);
  }

  // personnel — links an existing auth user; role/agency assignment.
  const { data, error } = await supabase.from("personnel").upsert(
    {
      id: String(body.id),
      agency_id: String(body.agency_id),
      role: body.role,
      full_name: body.full_name ?? null,
      hospital_id: body.hospital_id ?? null,
    },
    { onConflict: "id" },
  ).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
