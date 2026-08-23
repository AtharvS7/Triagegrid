"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight, CheckCircle2, CircleAlert, Crosshair, HeartPulse,
  RefreshCcw, WifiOff, Wifi,
} from "lucide-react";
import {
  PageShell, TierBadge, StatusBadge, DiversionBadge, CapacityMeter,
  SkeletonList,
} from "@/lib/components/ui";
import { useSession, roleHome } from "@/lib/hooks/useSession";
import { useRealtime } from "@/lib/hooks/useRealtime";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import {
  enqueue, listQueue, listConflicts, resolveConflict,
  cacheIncident,
  type ConflictRecord,
} from "@/lib/offline/db";
import { flushQueue, installConnectivityHandlers } from "@/lib/offline/sync";
import type {
  Incident, ResourceClaim, Unit, Hospital, TriageScore, IncidentStatus,
} from "@/lib/types";

/**
 * Field Responder PWA (FR-8): fully usable offline for status updates and
 * triage submission. Mutations queue in IndexedDB with idempotency keys and
 * flush on reconnect; triage conflicts surface manually per FR-8.
 */

const FIELD_NEXT: Partial<Record<IncidentStatus, IncidentStatus[]>> = {
  dispatched: ["en_route"],
  en_route: ["on_scene"],
};

const VITAL_KEYS = [
  { key: "respiratory_distress", en: "Breathing trouble", es: "Dificultad respiratoria" },
  { key: "unresponsive", en: "Unresponsive", es: "Inconsciente" },
  { key: "severe_bleeding", en: "Severe bleeding", es: "Sangrado severo" },
  { key: "chest_pain", en: "Chest pain", es: "Dolor de pecho" },
  { key: "entrapment", en: "Entrapped", es: "Atrapado" },
];

export default function FieldPage() {
  const { t, locale } = useI18n();
  const { personnel, loading } = useSession();

  const [incident, setIncident] = useState<Incident | null>(null);
  const [claim, setClaim] = useState<ResourceClaim | null>(null);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [latestScore, setLatestScore] = useState<TriageScore | null>(null);
  const [online, setOnline] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [vitals, setVitals] = useState<Record<string, boolean>>({});
  const [overrideScore, setOverrideScore] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refreshQueueState = useCallback(async () => {
    setQueuedCount((await listQueue()).length);
    setConflicts(await listConflicts());
    setOnline(navigator.onLine);
  }, []);

  const loadAssignment = useCallback(async () => {
    if (!personnel) return;
    const supabase = getSupabaseBrowser();
    const { data: myUnit } = await supabase
      .from("units").select("*").eq("assigned_to", personnel.id).maybeSingle();
    if (!myUnit) return;
    setUnit(myUnit as Unit);

    const { data: claims } = await supabase
      .from("resource_claims")
      .select("*")
      .eq("unit_id", (myUnit as Unit).id)
      .in("status", ["finalized", "active"])
      .order("created_at", { ascending: false })
      .limit(1);
    const c = (claims as ResourceClaim[])[0];
    if (!c) { setClaim(null); setIncident(null); return; }
    setClaim(c);

    const [{ data: inc }, { data: hs }, { data: scores }] = await Promise.all([
      supabase.from("incidents").select("*").eq("id", c.incident_id).single(),
      supabase.from("hospitals").select("*").order("name"),
      supabase.from("triage_scores").select("*")
        .eq("incident_id", c.incident_id).order("created_at", { ascending: false }).limit(1),
    ]);
    setIncident(inc as Incident);
    setHospitals((hs as Hospital[]) ?? []);
    setLatestScore(((scores as TriageScore[]) ?? [])[0] ?? null);

    await cacheIncident({
      incident_id: c.incident_id, snapshot: inc, cached_at: new Date().toISOString(),
    });
  }, [personnel]);

  useEffect(() => {
    void (async () => {
      await loadAssignment();
      await refreshQueueState();
      setReady(true);
    })();
    const stop = installConnectivityHandlers(async () => {
      await flushQueue();
      await refreshQueueState();
      void loadAssignment();
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAssignment]);

  useRealtime(["incidents"], () => void loadAssignment());

  async function queueMutation(
    kind: Parameters<typeof enqueue>[0]["kind"],
    payload: Record<string, unknown>,
  ) {
    await enqueue({ id: crypto.randomUUID(), kind, payload, client_ts: new Date().toISOString() });
    setNotice(locale === "es" ? "Guardado sin conexión" : online ? "Applied" : "Queued");
    await refreshQueueState();
    if (navigator.onLine) {
      await flushQueue();
      await refreshQueueState();
    }
  }

  async function advanceStatus(next: IncidentStatus) {
    if (!incident || !claim) return;
    await queueMutation("incident_status", {
      incident_id: incident.id,
      new_status: next,
      destination_hospital_id: claim.destination_hospital_id ?? null,
    });
    void loadAssignment();
  }

  async function submitTriage(e: React.FormEvent) {
    e.preventDefault();
    if (!incident) return;
    await queueMutation("triage_submit", {
      incident_id: incident.id,
      vitals,
      override_score: overrideScore ? Number(overrideScore) : null,
      base_created_at: latestScore?.created_at ?? null,
    });
    setVitals({});
    setOverrideScore("");
  }

  async function chooseDestination(hospitalId: string) {
    if (!claim || !incident) return;
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.rpc("update_incident_status", {
      p_incident_id: incident.id,
      p_new_status: "transporting",
      p_destination_hospital_id: hospitalId,
    });
    if (error && navigator.onLine) { setNotice(error.message); return; }
    if (error && !navigator.onLine) {
      await queueMutation("incident_status", {
        incident_id: incident.id,
        new_status: "transporting",
        destination_hospital_id: hospitalId,
      });
    }
    void loadAssignment();
  }

  async function pushPosition() {
    if (!unit) return;
    navigator.geolocation?.getCurrentPosition(async (pos) => {
      await queueMutation("unit_position", {
        unit_id: unit.id, lat: pos.coords.latitude, lng: pos.coords.longitude,
      });
      setNotice(t("field.positionUpdated"));
    });
  }

  async function adjudicate(conflict: ConflictRecord, keepMine: boolean) {
    if (!keepMine) {
      await resolveConflict(conflict.id);
    } else {
      await queueMutation("triage_submit", {
        incident_id: String(conflict.detail.incident_id),
        vitals: conflict.detail.client_vitals as Record<string, unknown>,
        override_score: conflict.detail.client_override as number | null,
        base_created_at: null,
      });
      await resolveConflict(conflict.id);
    }
    await refreshQueueState();
  }

  const etaFor = useMemo(() => {
    if (!unit?.current_lat) return () => 0;
    return (h: Hospital) =>
      Math.round((haversineKm(unit.current_lat!, unit.current_lng!, h.current_lat, h.current_lng) / 45) * 60);
  }, [unit]);

  if (loading || !ready) return <SkeletonList rows={5} />;
  if (!personnel || personnel.role !== "field") {
    window.location.replace(roleHome(personnel?.role));
    return null;
  }

  const showTransportChoice =
    ["on_scene"].includes(incident?.status ?? "") && hospitals.length > 0;

  return (
    <PageShell title={t("field.title")}>
      {/* Sync status strip */}
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          padding: "0.5rem 0.75rem",
          background: online ? "var(--ok-soft)" : "var(--warn-soft)",
          border: `1px solid ${online ? "rgba(52,211,153,0.3)" : "rgba(255,197,61,0.35)"}`,
          borderRadius: "var(--r-md)",
          marginBottom: "1rem",
          fontSize: "0.85rem",
        }}
        role="status"
      >
        <span className="row" style={{ color: online ? "var(--ok)" : "var(--warn)" }}>
          {online ? <Wifi size={15} /> : <WifiOff size={15} />}
          {online ? t("common.online") : t("common.offline")}
        </span>
        <span className="row" style={{ flexWrap: "nowrap" }}>
          {queuedCount > 0 && (
            <span className="badge st-busy">{t("common.queued", { count: queuedCount })}</span>
          )}
          {conflicts.length > 0 && (
            <span className="badge tier-critical">{t("common.conflicts", { count: conflicts.length })}</span>
          )}
          <button onClick={pushPosition} className="btn-ghost btn-sm">
            <Crosshair size={13} /> GPS
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={async () => { await flushQueue(); await refreshQueueState(); }}
          >
            <RefreshCcw size={13} /> {t("field.syncNow")}
          </button>
        </span>
      </div>

      {notice && (
        <p className="muted" role="status" style={{ fontSize: "0.85rem", marginBottom: "0.8rem" }}>
          {notice}
        </p>
      )}

      {!incident || !claim || !unit ? (
        <div className="card muted row" style={{ justifyContent: "center", padding: "3rem 1rem" }}>
          {t("field.noAssignment")}
        </div>
      ) : (
        <>
          {/* Assignment card */}
          <section className="card col" style={{ marginBottom: "1rem" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row">
                <TierBadge tier={incident.priority_tier} />
                <StatusBadge status={incident.status} />
              </div>
              <span className="mono faint">{incident.tracking_code}</span>
            </div>
            <p style={{ fontSize: "0.98rem" }}>{incident.description}</p>

            {/* Lifecycle action buttons — large touch targets */}
            <div className="row">
              {(FIELD_NEXT[incident.status] ?? []).map((next) => (
                <button key={next} className="btn-primary" disabled={busyAction !== null}
                  onClick={() => void advanceStatus(next)}>
                  {t(`status.${next}`)} <ArrowRight size={16} />
                </button>
              ))}
              {incident.status === "transporting" && (
                <button className="btn-primary" disabled={busyAction !== null}
                  onClick={() => void advanceStatus("resolved")}>
                  <CheckCircle2 size={16} /> {t("status.resolved")}
                </button>
              )}
            </div>
          </section>

          {/* Destination picker */}
          {showTransportChoice && (
            <section className="card col" style={{ marginBottom: "1rem" }}>
              <div className="card-title"><HeartPulse size={12} /> {t("field.destination")}</div>
              {[...hospitals]
                .sort((a, b) => etaFor(a) - etaFor(b))
                .map((h) => {
                  const excluded = h.diversion || h.beds_available <= 0;
                  return (
                    <div
                      key={h.id}
                      className="row"
                      style={{
                        justifyContent: "space-between",
                        padding: "0.55rem 0.7rem",
                        borderRadius: "var(--r-md)",
                        border: `1px solid ${excluded ? "var(--line)" : "var(--line-strong)"}`,
                        opacity: excluded ? 0.6 : 1,
                      }}
                    >
                      <div className="col" style={{ gap: "0.15rem" }}>
                        <strong style={{ fontSize: "0.92rem" }}>{h.name}</strong>
                        <span className="row muted" style={{ flexWrap: "nowrap", fontSize: "0.78rem" }}>
                          <CapacityMeter available={h.beds_available} total={h.total_beds} />
                          <span className="mono num">~{etaFor(h)} min</span>
                          {h.diversion && <DiversionBadge />}
                        </span>
                      </div>
                      <button
                        className={excluded ? "btn-ghost" : "btn-accent"}
                        disabled={excluded || busyAction !== null}
                        aria-label={`Select ${h.name}`}
                        onClick={() => void chooseDestination(h.id)}
                      >
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  );
                })}
            </section>
          )}

          {/* Triage submission */}
          <form className="card col" onSubmit={submitTriage}>
            <div className="card-title"><HeartPulse size={12} /> {t("field.triage")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "0.4rem" }}>
              {VITAL_KEYS.map((k) => {
                const on = !!vitals[k.key];
                return (
                  <label
                    key={k.key}
                    className="row"
                    style={{
                      gap: "0.5rem", cursor: "pointer",
                      padding: "0.45rem 0.6rem", borderRadius: "var(--r-md)",
                      border: `1px solid ${on ? "rgba(255,100,120,0.45)" : "var(--line)"}`,
                      background: on ? "rgba(255,100,120,0.07)" : "transparent",
                      transition: "all var(--t-fast)",
                    }}
                  >
                    <input
                      type="checkbox"
                      style={{ width: 17, height: 17, minHeight: 0, accentColor: "var(--danger)" }}
                      checked={on}
                      onChange={(e) => setVitals((s) => ({ ...s, [k.key]: e.target.checked }))}
                    />
                    <span style={{ fontWeight: 400, color: "var(--text-hi)", fontSize: "0.88rem" }}>
                      {locale === "es" ? k.es : k.en}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input
                type="number"
                placeholder={t("field.overrideScore")}
                value={overrideScore}
                onChange={(e) => setOverrideScore(e.target.value)}
                aria-label={t("field.overrideScore")}
              />
              <button type="submit" className="btn-primary" disabled={busyAction !== null}>
                <HeartPulse size={16} /> Submit
              </button>
            </div>
          </form>
        </>
      )}

      {/* Manual-surface conflict adjudication (FR-8) */}
      {conflicts.map((cf) => (
        <div
          key={cf.id}
          className="card col"
          role="alertdialog"
          aria-label={t("field.conflictTitle")}
          style={{
            margin: "1rem auto", maxWidth: 620, width: "100%",
            borderColor: "rgba(255,92,114,0.5)", borderWidth: 2,
          }}
        >
          <div className="card-title" style={{ color: "var(--danger)" }}>
            <CircleAlert size={14} /> {t("field.conflictTitle")}
          </div>
          <p className="muted" style={{ fontSize: "0.9rem" }}>{t("field.conflictBody")}</p>

          <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr", gap: "0.8rem" }}>
            <div style={{ background: "var(--bg-inset)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "0.7rem" }}>
              <p className="card-title" style={{ color: "var(--accent)" }}>Server</p>
              <pre className="mono faint" style={{ whiteSpace: "pre-wrap", fontSize: "0.74rem", margin: 0 }}>
                {JSON.stringify(cf.detail.server_rows ?? cf.detail, null, 1)}
              </pre>
            </div>
            <div style={{ background: "var(--bg-inset)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "0.7rem" }}>
              <p className="card-title" style={{ color: "var(--primary)" }}>Yours</p>
              <pre className="mono faint" style={{ whiteSpace: "pre-wrap", fontSize: "0.74rem", margin: 0 }}>
                {JSON.stringify(cf.detail.client_vitals, null, 1)}
              </pre>
            </div>
          </div>

          <div className="row">
            <button className="btn-primary" onClick={() => void adjudicate(cf, true)}>
              {t("field.keepMine")}
            </button>
            <button className="btn-ghost" onClick={() => void adjudicate(cf, false)}>
              {t("field.keepTheirs")}
            </button>
          </div>
        </div>
      ))}
    </PageShell>
  );

}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
