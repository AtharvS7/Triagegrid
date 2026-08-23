"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight, Ban, Building2, Check, CheckCheck, Gauge, RadioTower,
  SlidersHorizontal, Truck, X,
} from "lucide-react";
import {
  PageShell, TierBadge, StatusBadge, UnitStatusBadge, DiversionBadge,
  CapacityMeter, TickerCell, SkeletonList, PageSkeleton,
} from "@/lib/components/ui";
import { useSession, roleHome } from "@/lib/hooks/useSession";
import { useRealtime } from "@/lib/hooks/useRealtime";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import type {
  Incident, TriageScore, ResourceClaim, Unit, Hospital,
} from "@/lib/types";

/**
 * Dispatcher console (FR-4, FR-5, FR-12): realtime incident queue, match
 * review (accept/reject proposals), manual dispatch via concurrency-safe
 * claim RPC, triage override, lifecycle advancement.
 */

const OPEN_STATUSES = ["reported", "triaged", "dispatched", "en_route", "on_scene", "transporting"];
const NEXT_STATUS: Record<string, string[]> = {
  triaged: ["dispatched"],
  dispatched: ["en_route"],
  en_route: ["on_scene"],
  on_scene: ["transporting"],
  transporting: ["resolved"],
  resolved: ["closed"],
};
const SPINE: Record<string, string> = {
  low: "spine-low", medium: "spine-medium",
  high: "spine-high", critical: "spine-critical",
};

export default function DispatcherPage() {
  const { t } = useI18n();
  const { personnel, loading } = useSession();

  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scores, setScores] = useState<TriageScore[]>([]);
  const [claims, setClaims] = useState<ResourceClaim[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [overrideInput, setOverrideInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const reloadAll = useCallback(async () => {
    if (!personnel) return;
    const supabase = getSupabaseBrowser();
    const [inc, u, h] = await Promise.all([
      supabase.from("incidents").select("*")
        .in("status", OPEN_STATUSES)
        .order("priority_tier").order("created_at"),
      supabase.from("units").select("*").order("callsign"),
      supabase.from("hospitals").select("*").order("name"),
    ]);
    const errs = [inc.error, u.error, h.error].filter(Boolean) as { message: string }[];
    setQueryError(errs.length ? errs.map((e) => e.message).join(" | ") : null);
    setIncidents((inc.data as Incident[]) ?? []);
    setUnits((u.data as Unit[]) ?? []);
    setHospitals((h.data as Hospital[]) ?? []);

    if (selectedId) {
      const [s, c] = await Promise.all([
        supabase.from("triage_scores").select("*")
          .eq("incident_id", selectedId).order("created_at"),
        supabase.from("resource_claims").select("*")
          .eq("incident_id", selectedId).order("created_at"),
      ]);
      setScores((s.data as TriageScore[]) ?? []);
      setClaims((c.data as ResourceClaim[]) ?? []);
    } else {
      setScores([]);
      setClaims([]);
    }
  }, [personnel, selectedId]);

  useEffect(() => { if (personnel) void reloadAll(); }, [personnel, selectedId, reloadAll]);
  useRealtime(
    ["incidents", "units", "hospitals", "resource_claims", "triage_scores"],
    () => void reloadAll(),
  );

  const selected = incidents?.find((i) => i.id === selectedId) ?? null;
  const liveClaim = claims.find(
    (c) => c.is_primary && ["proposed", "finalized", "active"].includes(c.status),
  );
  const availableUnits = useMemo(() => units.filter((u) => u.status === "available"), [units]);

  const stats = useMemo(() => ({
    open: incidents?.length ?? 0,
    critical: incidents?.filter((i) => i.priority_tier === "critical").length ?? 0,
    waiting: incidents?.filter((i) => i.status === "triaged" || i.status === "reported").length ?? 0,
    available: availableUnits.length,
  }), [incidents, availableUnits]);

  async function withBusy(key: string, fn: () => PromiseLike<unknown>) {
    setError(null); setBusyAction(key);
    try { await fn(); } finally { setBusyAction(null); void reloadAll(); }
  }

  if (loading || !personnel) return <PageSkeleton />;
  if (personnel.role !== "dispatcher") { window.location.replace(roleHome(personnel.role)); return null; }

  return (
    <PageShell title={t("dispatcher.title")} wide>
      {/* â”€â”€ Situation bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {queryError && (
        <p className="error-text card" role="alert" style={{ marginBottom: "1rem", borderColor: "rgba(229,72,77,0.4)" }}>
          Data failed to load — try signing out and back in. ({queryError})
        </p>
      )}
      <div className="ticker" role="status" aria-label="situation summary">
        <TickerCell value={stats.open} label="open incidents" />
        <TickerCell value={stats.critical} label="critical" color="var(--tier-critical)" />
        <TickerCell value={stats.waiting} label="awaiting unit" color="var(--warn)" />
        <TickerCell value={stats.available} label="units ready" color="var(--ok)" />
      </div>

      <div className="grid-2">
        {/* â”€â”€ Queue + fleet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <section aria-label={t("dispatcher.queue")}>
          <h3 className="card-title" style={{ marginBottom: "0.6rem" }}>
            <RadioTower size={13} /> {t("dispatcher.queue")} Â· {incidents?.length ?? 0}
          </h3>
          {!incidents ? (
            <SkeletonList rows={4} />
          ) : incidents.length === 0 ? (
            <div className="card muted" style={{ textAlign: "center", padding: "1.6rem" }}>
              <CheckCheck size={22} color="var(--ok)" style={{ margin: "0 auto 0.5rem" }} />
              {t("dispatcher.noIncidents")}
            </div>
          ) : (
            incidents.map((i) => (
              <button
                key={i.id}
                className={`queue-item ${SPINE[i.priority_tier]} ${i.id === selectedId ? "selected" : ""}`}
                onClick={() => setSelectedId(i.id)}
              >
                <span className="row" style={{ justifyContent: "space-between" }}>
                  <span className="row">
                    <TierBadge tier={i.priority_tier} />
                    <StatusBadge status={i.status} />
                  </span>
                  <span className="mono faint" style={{ fontSize: "0.74rem" }}>
                    {i.tracking_code}
                  </span>
                </span>
                <span
                  className="muted"
                  style={{
                    display: "block", marginTop: "0.3rem", fontSize: "0.86rem",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                >
                  {i.description}
                </span>
              </button>
            ))
          )}

          <h3 className="card-title" style={{ margin: "1.1rem 0 0.6rem" }}>
            <Truck size={13} /> {t("dispatcher.units")}
          </h3>
          <div className="col" style={{ gap: "0.4rem" }}>
            {units.map((u) => (
              <div key={u.id} className="row card" style={{ padding: "0.55rem 0.85rem", justifyContent: "space-between" }}>
                <span className="row">
                  <strong className="mono">{u.callsign}</strong>
                  <span className="faint" style={{ fontSize: "0.78rem" }}>{u.unit_type}</span>
                </span>
                <UnitStatusBadge status={u.status} />
              </div>
            ))}
          </div>
        </section>

        {/* â”€â”€ Detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <section className="col" aria-label="detail" style={{ gap: "1rem" }}>
          {!selected ? (
            <div className="card muted row" style={{ justifyContent: "center", padding: "3rem 1rem", minHeight: 300 }}>
              â† Select an incident from the queue
            </div>
          ) : (
            <>
              {/* Incident header */}
              <div className="card col">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="row">
                    <TierBadge tier={selected.priority_tier} />
                    <StatusBadge status={selected.status} />
                    {selected.escalation_count > 0 && (
                      <span className="badge tier-high">escalated Ã—{selected.escalation_count}</span>
                    )}
                  </div>
                  <span className="mono faint">{selected.tracking_code}</span>
                </div>
                <p style={{ fontSize: "1rem", lineHeight: 1.5 }}>{selected.description}</p>
                <p className="mono faint" style={{ fontSize: "0.76rem" }}>
                  reported {new Date(selected.created_at).toLocaleString()} Â·{" "}
                  source: {selected.source}
                </p>

                {/* Lifecycle stepper */}
                <Stepper status={selected.status} />

                {NEXT_STATUS[selected.status]?.length > 0 && (
                  <div className="row">
                    {NEXT_STATUS[selected.status].map((s) => (
                      <button
                        key={s}
                        className={s === "closed" || s === undefined ? "btn-ghost" : "btn-primary"}
                        disabled={busyAction !== null}
                        onClick={() =>
                          s === "dispatched"
                            ? undefined // dispatch happens via claim panel below
                            : withBusy(s, async () => {
                                const isTransport = s === "transporting" && hospitals.length > 0;
                                const dest = liveClaim?.destination_hospital_id ?? null;
                                const open = hospitals.find((h) => !h.diversion && h.beds_available > 0);
                                await getSupabaseBrowser().rpc("update_incident_status", {
                                  p_incident_id: selectedId,
                                  p_new_status: s,
                                  ...(isTransport && !dest
                                    ? { p_destination_hospital_id: open?.id ?? null }
                                    : {}),
                                });
                              })
                        }
                      >
                        {s === "resolved" || s === "closed" ? (
                          <>
                            <Check size={15} /> {t(`status.${s}`)}
                          </>
                        ) : (
                          <>
                            {t(`status.${s}`)} <ArrowRight size={14} />
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {error && (
                  <p className="error-text" role="alert">
                    <X size={14} /> {error}
                  </p>
                )}
              </div>

              {/* Triage panel */}
              <div className="card col">
                <div className="card-title"><SlidersHorizontal size={12} /> Triage</div>
                {scores.map((s) => (
                  <div key={s.id} className="row" style={{ justifyContent: "space-between", fontSize: "0.88rem" }}>
                    <span className="badge st-offline">{s.source}</span>
                    <span className="muted">
                      computed <strong className="num" style={{ color: "var(--text-hi)" }}>
                        {Number(s.computed_score)}
                      </strong>{" "}
                      ({s.computed_tier})
                    </span>
                    {s.override_score !== null && (
                      <span className="muted">
                        override{" "}
                        <strong className="num" style={{ color: "var(--accent)" }}>
                          {Number(s.override_score)}
                        </strong>{" "}
                        ({s.override_tier})
                      </span>
                    )}
                  </div>
                ))}
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input
                    type="number"
                    placeholder={`${t("dispatcher.override")} â€” e.g. 70`}
                    value={overrideInput}
                    onChange={(e) => setOverrideInput(e.target.value)}
                    aria-label={t("dispatcher.override")}
                  />
                  <button
                    disabled={!overrideInput || busyAction === "override"}
                    onClick={() => withBusy("override", () =>
                      getSupabaseBrowser().rpc("override_triage", {
                        p_incident_id: selectedId,
                        p_override_score: Number(overrideInput),
                      }))}
                  >
                    Override
                  </button>
                </div>
              </div>

              {/* Dispatch / match review */}
              <div className="card col">
                <div className="card-title"><Truck size={12} /> {t("dispatcher.claimUnit")}</div>
                {liveClaim ? (
                  <div className="col">
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="row">
                        <strong className="mono">
                          {units.find((u) => u.id === liveClaim.unit_id)?.callsign}
                        </strong>
                        <span className="badge st-busy">{liveClaim.status}</span>
                      </span>
                      <span className="faint mono" style={{ fontSize: "0.76rem" }}>
                        via {liveClaim.proposed_by.replaceAll("_", " ")}
                      </span>
                    </div>
                    {liveClaim.status === "proposed" && (
                      <div className="row">
                        <button className="btn-primary" disabled={busyAction !== null}
                          onClick={() => withBusy("accept", () =>
                            getSupabaseBrowser().rpc("accept_claim", { p_claim_id: liveClaim.id }))}>
                          <Check size={15} /> {t("dispatcher.acceptMatch")}
                        </button>
                        <button className="btn-danger" disabled={busyAction !== null}
                          onClick={() => withBusy("reject", () =>
                            getSupabaseBrowser().rpc("reject_claim", { p_claim_id: liveClaim.id }))}>
                          <X size={15} /> {t("dispatcher.rejectMatch")}
                        </button>
                      </div>
                    )}
                  </div>
                ) : selected.status === "triaged" ? (
                  <div className="row">
                    {availableUnits.length === 0 && (
                      <span className="faint">No units available â€” escalation will re-run matching.</span>
                    )}
                    {availableUnits.map((u) => (
                      <button key={u.id} className="btn-accent" disabled={busyAction !== null}
                        onClick={() => withBusy(u.id, () =>
                          getSupabaseBrowser().rpc("claim_unit", {
                            p_incident_id: selectedId, p_unit_id: u.id,
                          }))}>
                        <Truck size={15} /> Dispatch {u.callsign}
                      </button>
                    ))}
                  </div>
                ) : null}

                {(selected.status === "triaged" || selected.status === "reported") && (
                  <button
                    className="btn-danger btn-sm"
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => withBusy("cancel", () =>
                      getSupabaseBrowser().rpc("update_incident_status", {
                        p_incident_id: selectedId, p_new_status: "cancelled",
                      }))}
                  >
                    <Ban size={14} /> {t("dispatcher.cancelIncident")}
                  </button>
                )}
              </div>

              {/* Hospitals */}
              <div className="card col">
                <div className="card-title"><Building2 size={12} /> {t("dispatcher.hospitals")}</div>
                {hospitals.map((h) => (
                  <div key={h.id} className="row" style={{ justifyContent: "space-between" }}>
                    <strong style={{ fontSize: "0.92rem" }}>{h.name}</strong>
                    <span className="row" style={{ flexWrap: "nowrap" }}>
                      {h.diversion && <DiversionBadge />}
                      <CapacityMeter available={h.beds_available} total={h.total_beds} />
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </PageShell>
  );
}

/* Lifecycle visual: reported â†’ â€¦ â†’ closed */
const CHAIN = ["reported", "triaged", "dispatched", "en_route", "on_scene", "transporting", "resolved"];
function Stepper({ status }: { status: string }) {
  const idx = CHAIN.indexOf(status);
  if (idx < 0) return null; // cancelled/closed terminal states
  return (
    <div className="stepper" role="list" aria-label="lifecycle progress">
      {CHAIN.map((s, i) => (
        <span key={s} style={{ display: "contents" }}>
          <span role="listitem" className={`step ${i < idx ? "done" : ""} ${i === idx ? "current" : ""}`}>
            {i < idx ? <Check size={11} strokeWidth={3} /> : <span className="dot" style={{
              width: 6, height: 6, borderRadius: "50%",
              background: i === idx ? "var(--primary)" : "var(--line-strong)",
            }} />}
            {s.replaceAll("_", " ")}
          </span>
          {i < CHAIN.length - 1 && (
            <span className={`step-line ${i < idx ? "done" : ""}`} aria-hidden />
          )}
        </span>
      ))}
    </div>
  );
}

