"use client";

import Link from "next/link";
import { Globe, LogOut } from "lucide-react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useSession } from "@/lib/hooks/useSession";
import { useI18n, type Locale } from "@/lib/i18n";

/* ── Brand: red square + tracked mono wordmark ─────────────────────────── */
export function BrandMark() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden />
      <span className="brand-word">Triagegrid</span>
    </span>
  );
}

/* ── Status tags — dot + text, unboxed ─────────────────────────────────── */
export function TierBadge({ tier }: { tier: string }) {
  return (
    <span className={`badge tier-${tier}`}>
      <span className="dot" style={{ background: `var(--tier-${tier})` }} />
      {tier}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="badge st-busy">{status.replaceAll("_", " ")}</span>
  );
}

export function UnitStatusBadge({ status }: { status: string }) {
  const color =
    status === "available" ? "var(--ok)"
    : status === "offline" || status === "out_of_service" ? "var(--text-low)"
    : "var(--warn)";
  const label = status === "available" ? "ready"
    : status === "out_of_service" ? "oos" : status;
  return (
    <span className="badge" style={{ color }}>
      <span className="dot" style={{ background: color }} />
      {label}
    </span>
  );
}

export function DiversionBadge({ boxed = false }: { boxed?: boolean }) {
  return (
    <span className={`badge diversion ${boxed ? "tag-boxed" : ""}`}>
      <span className="dot" style={{ background: "var(--danger)" }} />
      diversion
    </span>
  );
}

/* ── Capacity meter ────────────────────────────────────────────────────── */
export function CapacityMeter({
  available, total,
}: { available: number; total: number }) {
  const pct = total > 0 ? Math.round((available / total) * 100) : 0;
  const color =
    pct > 40 ? "var(--ok)"
    : pct > 15 ? "var(--warn)"
    : pct > 0 ? "var(--danger)"
    : "var(--text-low)";
  return (
    <span className="row mono" style={{ gap: "0.5rem", flexWrap: "nowrap", fontSize: "0.8rem" }}>
      <span
        className="meter"
        role="img"
        aria-label={`${available} of ${total} beds available`}
        style={{ ["--meter-color" as string]: color }}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="num muted">{available}/{total}</span>
    </span>
  );
}

/* ── Ticker cell (replaces KPI tiles) ──────────────────────────────────── */
export function TickerCell({
  value, label, color,
}: { value: number | string; label: string; color?: string }) {
  return (
    <div className="ticker-cell">
      <div className="v" style={color ? { color } : undefined}>{value}</div>
      <div className="k">{label}</div>
    </div>
  );
}

/* ── Skeletons ─────────────────────────────────────────────────────────── */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden style={{ display: "grid", gap: "0.5rem" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 52, opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div style={{ maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }} aria-hidden>
      <div className="skeleton" style={{ height: 28, width: 180, marginBottom: 20 }} />
      <div className="card"><SkeletonList rows={3} /></div>
    </div>
  );
}

/* ── Top bar ───────────────────────────────────────────────────────────── */
export function Topbar({ title }: { title: string }) {
  const { t, locale, setLocale } = useI18n();
  const { personnel } = useSession();
  async function logout() {
    await getSupabaseBrowser().auth.signOut();
    // Full navigation clears any stale client state (IndexedDB caches stay).
    window.location.assign("/login");
  }

  return (
    <header className="topbar">
      <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
        <BrandMark />
      </Link>

      <div className="row" style={{ flexWrap: "nowrap", gap: "1rem" }}>
        <span className="eyebrow">{title}</span>

        <label className="row" style={{ gap: "0.35rem" }}>
          <select
            style={{ width: "auto", minHeight: 32, padding: "0.15rem 0.4rem", fontSize: "0.8rem" }}
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            aria-label={t("common.language")}
          >
            <option value="en">EN</option>
            <option value="es">ES</option>
          </select>
        </label>

        {personnel ? (
          <>
            <span className="badge st-available">{personnel.role}</span>
            <button onClick={logout} className="btn-ghost btn-sm" style={{ minHeight: 32 }}>
              <LogOut size={13} />
              {t("common.logout")}
            </button>
          </>
        ) : (
          <Link href="/login" className="btn-primary btn-sm" style={{ display: "inline-flex" }}>
            Staff sign-in
          </Link>
        )}
      </div>
    </header>
  );
}

export function PageShell({
  title, children, wide,
}: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <>
      <Topbar title={title} />
      <main
        style={{
          maxWidth: wide ? 1160 : undefined,
          margin: wide ? undefined : "0 auto",
          padding: "1.1rem 1.25rem 3rem",
        }}
      >
        {children}
      </main>
    </>
  );
}

export { Globe };
