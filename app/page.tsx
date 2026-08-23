import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "@/lib/components/ui";

/**
 * Landing: asymmetric editorial hero + live terminal mock (the product is the
 * decoration), followed by a numbered how-it-works ledger. No gradients, no
 * icon-card grid.
 */

const FEED = [
  { spine: "--tier-critical", tier: "critical", code: "9oOOXUX1Oz6G", what: "Building collapse — entrapment ×4", unit: "M-1 · en route" },
  { spine: "--tier-high", tier: "high", code: "TtdBDZVpBlNS", what: "Multi-vehicle accident, I-10 W", unit: "R-7 · on scene" },
  { spine: "--tier-medium", tier: "medium", code: "ckWvO8FtKMRZ", what: "Chest pain, 3rd & Main", unit: "proposed → M-2" },
  { spine: "--tier-low", tier: "low", code: "LX73ian56uzX", what: "Walking wounded ×2", unit: "queued" },
];

const STEPS = [
  {
    n: "01", title: "Intake",
    body: "Citizens report from any phone — no account, geolocation required. Dispatchers create directly. Every report lands with a tracking code.",
  },
  {
    n: "02", title: "Triage",
    body: "A config-driven START-style algorithm scores severity instantly. Clinicians can override; computed values are never overwritten.",
  },
  {
    n: "03", title: "Match",
    body: "A weighted bipartite solver assigns units every minute — distance, capability, capacity, load. Concurrency-safe claiming makes double-dispatch impossible at the database level.",
  },
  {
    n: "04", title: "Route & audit",
    body: "Patients route only to hospitals with beds and no diversion flag in effect. A hash-chained log reconstructs every transition afterward.",
  },
];

export default function Home() {
  return (
    <main style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <header className="topbar">
        <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
          <BrandMark />
        </Link>
        <nav className="row" style={{ flexWrap: "nowrap" }}>
          <Link href="/track" className="btn-ghost btn-sm" style={{ display: "inline-flex" }}>
            Track a report
          </Link>
          <Link href="/login" className="btn-primary btn-sm" style={{ display: "inline-flex" }}>
            Staff sign-in
          </Link>
        </nav>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="hero">
        <div>
          <p className="eyebrow eyebrow-accent" style={{ marginBottom: "1.1rem" }}>
            Mass-casualty incident coordination
          </p>
          <h1>
            One grid.
            <br />
            Every responder.
            <br />
            Zero duplicate dispatch.
          </h1>
          <p className="hero-sub">
            TriageGrid replaces radio-and-paper coordination during disasters:
            realtime incidents, offline-tolerant field tools, and hospital
            routing that respects capacity — on infrastructure that survives
            bad connectivity by design.
          </p>
          <div className="row" style={{ marginTop: "2rem" }}>
            <Link href="/citizen" className="btn-primary" style={{ padding: "0.65rem 1.3rem" }}>
              Report an incident <ArrowRight size={16} />
            </Link>
            <Link href="/login" className="btn-ghost" style={{ padding: "0.65rem 1.3rem", color: "var(--text-hi)", borderColor: "var(--line-strong)" }}>
              Staff console
            </Link>
          </div>
        </div>

        {/* Live-feed mock */}
        <div className="terminal" role="img" aria-label="Preview of the dispatcher console showing a live incident feed">
          <div className="terminal-bar">
            <span>metro-ems · live queue</span>
            <span><span className="cursor-blink" aria-hidden /></span>
          </div>
          {FEED.map((f) => (
            <div key={f.code} className="terminal-row" style={{ ["--spine" as string]: `var(${f.spine})` }}>
              <span style={{ width: 58, color: `var(${f.spine})`, flexShrink: 0 }}>{f.tier}</span>
              <span className="muted" style={{ flexShrink: 0 }}>{f.code}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-hi)" }}>
                {f.what}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--text-low)", flexShrink: 0 }}>{f.unit}</span>
            </div>
          ))}
          <div className="terminal-row" style={{ borderLeftColor: "transparent", color: "var(--text-low)" }}>
            <span>escalation sweep · 00:00:07 · chain verified ✓</span>
          </div>
        </div>
      </section>

      {/* ── How it works — numbered ledger ────────────────────────────── */}
      <section style={{ maxWidth: 1140, margin: "0 auto", width: "100%", padding: "0 1.5rem 4rem" }}>
        <p className="eyebrow" style={{ marginBottom: "0.6rem" }}>How it works</p>
        <div className="numbered-list">
          {STEPS.map((s) => (
            <div key={s.n} className="numbered-row">
              <span className="idx">{s.n}</span>
              <h2 style={{ fontSize: "1.15rem", fontWeight: 600 }}>{s.title}</h2>
              <p className="muted" style={{ fontSize: "0.92rem", maxWidth: "62ch" }}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer
        className="row"
        style={{
          marginTop: "auto",
          justifyContent: "space-between",
          padding: "1.1rem 1.5rem",
          borderTop: "1px solid var(--line)",
          fontSize: "0.78rem",
          color: "var(--text-low)",
        }}
      >
        <span className="mono" style={{ letterSpacing: "0.14em", textTransform: "uppercase" }}>
          Triagegrid
        </span>
        <span>incident coordination infrastructure</span>
      </footer>
    </main>
  );
}
