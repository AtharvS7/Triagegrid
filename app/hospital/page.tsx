"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine, Building2, TriangleAlert, Users, X,
} from "lucide-react";
import {
  PageShell, DiversionBadge, CapacityMeter, SkeletonList, StatusBadge,
  TierBadge,
} from "@/lib/components/ui";
import { useSession, roleHome } from "@/lib/hooks/useSession";
import { useRealtime } from "@/lib/hooks/useRealtime";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import type { Hospital, Incident, ResourceClaim } from "@/lib/types";

/**
 * Hospital console (FR-10): capacity editing and diversion toggle with
 * immediate realtime effect on routing; inbound patient visibility.
 */
export default function HospitalPage() {
  const { t } = useI18n();
  const { personnel, loading } = useSession();
  const [hospital, setHospital] = useState<Hospital | null>(null);
  const [inbound, setInbound] = useState<Array<{ claim: ResourceClaim; incident: Incident }>>([]);
  const [beds, setBeds] = useState(0);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!personnel?.hospital_id) return;
    const supabase = getSupabaseBrowser();
    const { data: h } = await supabase
      .from("hospitals").select("*").eq("id", personnel.hospital_id).single();
    if (h === null) {
      setQueryError("Could not load your hospital record — try signing out and back in.");
      return;
    }
    setQueryError(null);
    setHospital(h as Hospital);
    setBeds((h as Hospital).beds_available);

    const { data: claims } = await supabase
      .from("resource_claims")
      .select("*")
      .eq("destination_hospital_id", personnel.hospital_id)
      .in("status", ["finalized", "active"]);
    const list: Array<{ claim: ResourceClaim; incident: Incident }> = [];
    for (const c of (claims as ResourceClaim[]) ?? []) {
      const { data: inc } = await supabase
        .from("incidents").select("*").eq("id", c.incident_id).maybeSingle();
      if (inc) list.push({ claim: c, incident: inc as Incident });
    }
    setInbound(list);
  }, [personnel]);

  useEffect(() => { void load(); }, [load]);
  useRealtime(["hospitals", "resource_claims", "incidents"], () => void load());

  async function saveCapacity() {
    setError(null); setSaved(false);
    const { error: err } = await getSupabaseBrowser().rpc("update_capacity", {
      p_hospital_id: hospital!.id,
      p_beds_available: beds,
      p_total_beds: hospital!.total_beds,
    });
    if (err) setError(err.message);
    else { setSaved(true); setTimeout(() => setSaved(false), 2500); }
    void load();
  }

  async function toggleDiversion(on: boolean) {
    setError(null);
    const { error: err } = await getSupabaseBrowser().rpc("toggle_diversion", {
      p_hospital_id: hospital!.id,
      p_on: on,
      p_reason: on ? reason : null,
    });
    if (err) setError(err.message);
    void load();
  }

  if (loading) return <SkeletonList rows={5} />;
  if (!personnel || personnel.role !== "hospital_admin") {
    window.location.replace(roleHome(personnel?.role));
    return null;
  }

  return (
    <PageShell title={t("hospital.title")}>
      {queryError && (
        <p className="error-text card" role="alert" style={{ marginBottom: "1rem", borderColor: "rgba(229,72,77,0.4)" }}>
          {queryError}
        </p>
      )}
      <div style={{ maxWidth: 640, margin: "0 auto" }} className="col">
        {!hospital ? (
          <div className="card muted">No hospital linked to this account.</div>
        ) : (
          <>
            {/* Facility header */}
            <div className="card col">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ fontSize: "1.15rem" }}>{hospital.name}</h2>
                {hospital.diversion && <DiversionBadge />}
              </div>
              <CapacityMeter available={hospital.beds_available} total={hospital.total_beds} />
              <p className="faint mono" style={{ fontSize: "0.76rem" }}>
                {t("hospital.lastUpdate")}: {new Date(hospital.last_capacity_update_at).toLocaleString()}
              </p>
            </div>

            {/* Capacity editor */}
            <section className="card col">
              <div className="card-title"><Users size={12} /> {t("hospital.capacity")}</div>
              <label className="row" style={{ gap: "0.9rem", flexWrap: "nowrap" }}>
                <span style={{ whiteSpace: "nowrap" }}>{t("hospital.bedsAvailable")}</span>
                <input
                  className="mono"
                  type="number"
                  min={0}
                  max={hospital.total_beds}
                  value={beds}
                  onChange={(e) => setBeds(Number(e.target.value))}
                  aria-label={t("hospital.bedsAvailable")}
                />
              </label>
              <p className="faint" style={{ fontSize: "0.8rem" }}>
                {t("hospital.totalBeds")}: <span className="mono">{hospital.total_beds}</span>
              </p>
              <button onClick={saveCapacity} disabled={beds === hospital.beds_available} style={{ alignSelf: "flex-start" }}>
                <ArrowDownToLine size={15} /> {t("common.save")}
              </button>
              {saved && (
                <p className="ok-text row" role="status" style={{ fontSize: "0.85rem" }}>
                  Saved.
                </p>
              )}
            </section>

            {/* Diversion control */}
            <section className="card col">
              <div className="card-title"><TriangleAlert size={12} /> {t("hospital.diversion")}</div>
              {hospital.diversion ? (
                <div className="col">
                  <p className="muted" style={{ fontSize: "0.9rem" }}>
                    New patients are being routed away. In-transit crews have been notified.
                    {hospital.diversion_reason && (
                      <> Reason: <em>â€œ{hospital.diversion_reason}â€</em></>
                    )}
                  </p>
                  <button className="btn-primary" style={{ alignSelf: "flex-start" }}
                    onClick={() => toggleDiversion(false)}>
                    {t("hospital.liftDiversion")}
                  </button>
                </div>
              ) : (
                <div className="col">
                  <label>
                    {t("hospital.reason")}
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. flooding in ER wing"
                    />
                  </label>
                  <button
                    className="btn-danger"
                    style={{ alignSelf: "flex-start" }}
                    disabled={!reason.trim()}
                    onClick={() => toggleDiversion(true)}
                  >
                    <TriangleAlert size={15} /> {t("hospital.setDiversion")}
                  </button>
                </div>
              )}
              {error && (
                <p className="error-text" role="alert"><X size={14} /> {error}</p>
              )}
            </section>

            {/* Inbound patients */}
            <section className="card col">
              <div className="card-title"><Building2 size={12} /> {t("hospital.inbound")} Â· {inbound.length}</div>
              {inbound.length === 0 ? (
                <p className="faint" style={{ padding: "1rem", textAlign: "center" }}>
                  {t("hospital.noneInbound")}
                </p>
              ) : (
                inbound.map(({ claim, incident }) => (
                  <div
                    key={claim.id}
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      padding: "0.6rem 0.75rem",
                      borderRadius: "var(--r-md)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    <div className="col" style={{ gap: "0.1rem" }}>
                      <span className="row">
                        <strong className="mono">{incident.tracking_code}</strong>
                        <TierBadge tier={incident.priority_tier} />
                        <StatusBadge status={incident.status} />
                      </span>
                      <span className="muted" style={{ fontSize: "0.84rem" }}>
                        {incident.description.slice(0, 80)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </div>
    </PageShell>
  );
}
