"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FileClock, Link2Off, Link, Plus, ShieldCheck, Truck, Activity,
} from "lucide-react";
import {
  PageShell, UnitStatusBadge, DiversionBadge, CapacityMeter, SkeletonList,
} from "@/lib/components/ui";
import { useSession, roleHome } from "@/lib/hooks/useSession";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import type { Unit, Hospital, Personnel } from "@/lib/types";

interface AuditRow {
  id: number;
  occurred_at: string;
  actor_role: string | null;
  table_name: string;
  row_id: string;
  operation: string;
}

type Tab = "audit" | "roster" | "health";

export default function AdminPage() {
  const { t } = useI18n();
  const { personnel, loading } = useSession();
  const [tab, setTab] = useState<Tab>("audit");
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [chainStatus, setChainStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [staff, setStaff] = useState<Personnel[]>([]);
  const [runs, setRuns] = useState<Array<Record<string, unknown>>>([]);
  const [newUnitCallsign, setNewUnitCallsign] = useState("");
  const [newUnitCapacity, setNewUnitCapacity] = useState(2);
  const [verifying, setVerifying] = useState(false);

  const loadAudit = useCallback(async () => {
    if (!personnel) return;
    const supabase = getSupabaseBrowser();
    const { data } = await supabase
      .from("audit_log").select("*").order("id", { ascending: false }).limit(200);
    setAudit((data as AuditRow[]) ?? []);
    setChainStatus(null);
  }, [personnel]);

  const loadRoster = useCallback(async () => {
    if (!personnel) return;
    const supabase = getSupabaseBrowser();
    const [u, h, p] = await Promise.all([
      supabase.from("units").select("*").order("callsign"),
      supabase.from("hospitals").select("*").order("name"),
      supabase.from("personnel").select("*"),
    ]);
    setUnits((u.data as Unit[]) ?? []);
    setHospitals((h.data as Hospital[]) ?? []);
    setStaff((p.data as Personnel[]) ?? []);
  }, [personnel]);

  useEffect(() => {
    if (tab === "audit") void loadAudit();
    if (tab === "roster") void loadRoster();
    if (tab === "health") void (async () => {
      const supabase = getSupabaseBrowser();
      const { data } = await supabase
        .from("matching_batch_runs").select("*")
        .order("started_at", { ascending: false }).limit(15);
      setRuns(data ?? []);
    })();
  }, [tab, personnel, loadAudit, loadRoster]);

  async function verifyChain() {
    setVerifying(true);
    try {
      const supabase = getSupabaseBrowser();
      const { data } = await supabase.rpc("verify_audit_chain");
      const broken = (data as Array<{ broken_at: number; reason: string }>) ?? [];
      setChainStatus(
        broken.length === 0
          ? { ok: true, text: `Hash chain intact — ${audit?.length ?? 0} rows verified` }
          : { ok: false, text: `CHAIN BROKEN at row ${broken[0].broken_at}: ${broken[0].reason}` },
      );
    } finally {
      setVerifying(false);
    }
  }

  async function addUnit(e: React.FormEvent) {
    e.preventDefault();
    const token = (await getSupabaseBrowser().auth.getSession()).data.session?.access_token;
    await fetch("/api/admin/units", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        callsign: newUnitCallsign,
        capacity: newUnitCapacity,
        current_lat: 34.05,
        current_lng: -118.24,
      }),
    });
    setNewUnitCallsign("");
    void loadRoster();
  }

  if (loading) return <SkeletonList rows={5} />;
  if (!personnel || personnel.role !== "admin") {
    window.location.replace(roleHome(personnel?.role));
    return null;
  }

  const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: "audit", label: "Audit log", icon: <FileClock size={14} /> },
    { id: "roster", label: "Roster", icon: <Truck size={14} /> },
    { id: "health", label: "Matching health", icon: <Activity size={14} /> },
  ];

  return (
    <PageShell title={t("admin.title")} wide>
      {/* Tabs */}
      <nav className="row" role="tablist" aria-label="admin sections" style={{ marginBottom: "1.1rem" }}>
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={x.id === tab}
            className={x.id === tab ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setTab(x.id)}
            style={x.id === tab
              ? undefined
              : { background: "var(--bg-1)", color: "var(--text-mid)" }}
          >
            {x.icon} {x.label}
          </button>
        ))}
      </nav>

      {/* ── Audit ─────────────────────────────────────────────────────── */}
      {tab === "audit" && (
        <section className="col">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn-primary" disabled={verifying} onClick={() => void verifyChain()}>
              {chainStatus?.ok ? <ShieldCheck size={15} /> : <Link2Off size={15} />}
              {t("admin.verifyChain")}
            </button>
            {chainStatus && (
              <span
                className={`badge ${chainStatus.ok ? "st-available" : "tier-critical"}`}
                role="status"
                style={{ fontSize: "0.8rem" }}
              >
                {chainStatus.text}
              </span>
            )}
          </div>

          {!audit ? (
            <SkeletonList rows={6} />
          ) : (
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th><th>time</th><th>actor role</th><th>table</th><th>op</th><th>row</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((r) => (
                    <tr key={r.id}>
                      <td className="mono faint">{r.id}</td>
                      <td className="mono">{new Date(r.occurred_at).toLocaleTimeString()}</td>
                      <td>{r.actor_role ?? <span className="faint">system</span>}</td>
                      <td><span className="badge st-offline">{r.table_name}</span></td>
                      <td>{r.operation}</td>
                      <td className="mono faint">{r.row_id.slice(0, 8)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── Roster ────────────────────────────────────────────────────── */}
      {tab === "roster" && (
        <section className="col" style={{ gap: "1.1rem" }}>
          <form className="card row" onSubmit={addUnit} style={{ flexWrap: "nowrap" }}>
            <Plus size={16} color="var(--text-low)" aria-hidden />
            <input
              placeholder="New callsign (e.g. M-9)"
              required
              className="mono"
              style={{ maxWidth: 180 }}
              value={newUnitCallsign}
              onChange={(e) => setNewUnitCallsign(e.target.value)}
              aria-label="callsign"
            />
            <input
              type="number" min={1}
              style={{ maxWidth: 90 }}
              value={newUnitCapacity}
              onChange={(e) => setNewUnitCapacity(Number(e.target.value))}
              aria-label="capacity"
            />
            <button type="submit" className="btn-accent" disabled={!newUnitCallsign.trim()}>
              {t("admin.addUnit")}
            </button>
          </form>

          <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr", alignItems: "start" }}>
            <section className="card col">
              <div className="card-title"><Truck size={12} /> Units · {units.length}</div>
              {units.map((u) => (
                <div key={u.id} className="row" style={{ justifyContent: "space-between", padding: "0.3rem 0" }}>
                  <span className="row">
                    <strong className="mono">{u.callsign}</strong>
                    <span className="faint" style={{ fontSize: "0.78rem" }}>
                      {u.unit_type} · cap {u.capacity}
                    </span>
                  </span>
                  <UnitStatusBadge status={u.status} />
                </div>
              ))}
            </section>

            <section className="card col">
              <div className="card-title">Hospitals · {hospitals.length}</div>
              {hospitals.map((h) => (
                <div key={h.id} className="col" style={{ gap: "0.25rem", padding: "0.35rem 0" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong style={{ fontSize: "0.9rem" }}>{h.name}</strong>
                    {h.diversion && <DiversionBadge />}
                  </div>
                  <CapacityMeter available={h.beds_available} total={h.total_beds} />
                </div>
              ))}

              <hr className="divider" />
              <div className="card-title">Personnel · {staff.length}</div>
              {staff.map((p) => (
                <div key={p.id} className="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontSize: "0.88rem" }}>{p.full_name}</span>
                  <span className="badge st-offline">{p.role}</span>
                </div>
              ))}
            </section>
          </div>
        </section>
      )}

      {/* ── Matching health ───────────────────────────────────────────── */}
      {tab === "health" && (
        <section className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="data">
            <thead>
              <tr>
                <th>started</th><th>finished</th><th>status</th>
                <th>open</th><th>proposed</th><th>applied</th><th>error</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr><td colSpan={7} className="faint" style={{ textAlign: "center", padding: "1.4rem" }}>
                  No matcher runs recorded yet — the pipeline starts with pg_cron.
                </td></tr>
              )}
              {runs.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{new Date(String(r.started_at)).toLocaleTimeString()}</td>
                  <td className="mono">{r.finished_at ? new Date(String(r.finished_at)).toLocaleTimeString() : "—"}</td>
                  <td>
                    <span className={`badge ${String(r.status) === "success" ? "st-available" : String(r.status) === "running" ? "st-busy" : "tier-high"}`}>
                      <Link size={10} /> {String(r.status)}
                    </span>
                  </td>
                  <td>{String(r.incidents_open ?? "—")}</td>
                  <td>{String(r.pairs_proposed ?? "—")}</td>
                  <td>{String(r.pairs_applied ?? "—")}</td>
                  <td className="faint mono" style={{ fontSize: "0.76rem" }}>{String(r.error_detail ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </PageShell>
  );
}
