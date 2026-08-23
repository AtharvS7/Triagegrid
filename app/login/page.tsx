"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useSession, roleHome } from "@/lib/hooks/useSession";
import { useI18n } from "@/lib/i18n";
import { BrandMark, PageSkeleton } from "@/lib/components/ui";

export default function LoginPage() {
  const { t } = useI18n();
  const { personnel, loading, refresh } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = getSupabaseBrowser();
    const { error: err } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (err) {
      setError(t("login.invalid"));
      setBusy(false);
      return;
    }
    // Route straight to the caller's console (role resolved server-side via RLS).
    const { data: auth } = await supabase.auth.getUser();
    const { data: p } = await supabase
      .from("personnel")
      .select("role")
      .eq("id", auth!.user!.id)
      .single();
    setBusy(false);
    router.replace(roleHome((p?.role as never) ?? null));
  }

  if (loading) return <PageSkeleton />;
  if (personnel) router.replace(roleHome(personnel.role));

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "1rem" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.6rem" }}>
          <div style={{ transform: "scale(2.2)", marginBottom: "1rem" }}><BrandMark /></div>
        </div>
        <h1 style={{ textAlign: "center", fontSize: "1.35rem" }}>{t("login.title")}</h1>
        <p className="muted" style={{ textAlign: "center", marginTop: "0.3rem", fontSize: "0.9rem" }}>
          Dispatcher · Field · Hospital · Admin
        </p>

        <form onSubmit={submit} className="card col" style={{ marginTop: "1.4rem", padding: "1.4rem" }}>
          <label>
            {t("login.email")}
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@agency.gov"
            />
          </label>
          <label>
            {t("login.password")}
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </label>
          {error && (
            <p className="error-text" role="alert">
              {t("login.invalid")} — check your email and password.
            </p>
          )}
          <button type="submit" className="btn-primary" disabled={busy} style={{ marginTop: "0.2rem" }}>
            <LogIn size={16} />
            {busy ? t("common.loading") : t("login.submit")}
          </button>
        </form>

        <p className="faint mono" style={{ textAlign: "center", marginTop: "1.1rem", fontSize: "0.75rem" }}>
          Citizens never need an account — <a href="/citizen">report an incident</a>
        </p>
      </div>
    </main>
  );
}
