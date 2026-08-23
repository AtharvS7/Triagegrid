import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for SERVER ROUTES ONLY (never import from client code).
 * Bypasses RLS deliberately: /api/incidents, /api/sync and admin routes are
 * the trusted mediation layer; every call site is rate-limited or
 * session-validated before use.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
