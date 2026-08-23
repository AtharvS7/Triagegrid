"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2, Crosshair, ImagePlus, MapPin, Send, TriangleAlert,
} from "lucide-react";
import { PageShell } from "@/lib/components/ui";
import { useI18n } from "@/lib/i18n";

/**
 * Citizen Reporter surface (FR-1): unauthenticated, geolocation REQUIRED,
 * severity indicators feed the server-side triage scoring, optional photo via
 * signed upload URL. Response carries the tracking code for read-back.
 */

const INDICATORS: Array<{ key: string; labelEn: string; labelEs: string }> = [
  { key: "walking_wounded", labelEn: "Walking wounded", labelEs: "Herido ambulante" },
  { key: "respiratory_distress", labelEn: "Trouble breathing", labelEs: "Dificultad respiratoria" },
  { key: "unresponsive", labelEn: "Unresponsive person", labelEs: "Persona inconsciente" },
  { key: "severe_bleeding", labelEn: "Severe bleeding", labelEs: "Sangrado severo" },
  { key: "chest_pain", labelEn: "Chest pain", labelEs: "Dolor de pecho" },
  { key: "traumatic_amputation", labelEn: "Amputation", labelEs: "Amputación traumática" },
  { key: "burn_majority_body", labelEn: "Major burns", labelEs: "Quemaduras graves" },
  { key: "pediatric_involved", labelEn: "Children involved", labelEs: "Niños involucrados" },
];

export default function CitizenPage() {
  const { t, locale } = useI18n();
  const [description, setDescription] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [indicators, setIndicators] = useState<Record<string, boolean>>({});
  const [multipleVictims, setMultipleVictims] = useState(0);
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tracking_code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Persisted idempotency key survives reloads on flaky connections (dedupe).
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  useEffect(() => {
    const existing = window.localStorage.getItem("tg.citizen.idem");
    if (existing) setIdempotencyKey(existing);
    else {
      const k = crypto.randomUUID();
      window.localStorage.setItem("tg.citizen.idem", k);
      setIdempotencyKey(k);
    }
  }, []);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setGeoError(locale === "es"
        ? "Geolocalización no disponible — toque el mapa para colocar un pin."
        : "Geolocation unavailable — tap the map to place a pin.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLat(pos.coords.latitude); setLng(pos.coords.longitude); setGeoError(null); },
      () => setGeoError(locale === "es"
        ? "No se pudo obtener la ubicación — toque el mapa para colocar un pin."
        : "Could not get location — tap the map to place a pin."),
    );
  }

  function mapClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setLng(((e.clientX - rect.left) / rect.width) * 360 - 180);
    setLat(90 - ((e.clientY - rect.top) / rect.height) * 180);
    setGeoError(null);
  }

  async function uploadPhoto(file: File) {
    setPhotoBusy(true);
    try {
      const signRes = await fetch("/api/photos/sign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!signRes.ok) return;
      const sign = await signRes.json();
      await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/sign/incident-photos/${sign.path}`,
        { method: "PUT", headers: { "x-upsert": "true", authorization: `Bearer ${sign.token}` }, body: file },
      );
      setPhotoPath(sign.path);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (lat === null || lng === null) {
      setError(t("citizen.pinHint"));
      return;
    }
    setBusy(true);
    try {
      const payload = { ...indicators };
      if (multipleVictims > 1) payload.multiple_victims = multipleVictims as never;
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description, lat, lng,
          indicators: payload,
          photo_path: photoPath,
          idempotency_key: idempotencyKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? t("common.error")); return; }
      setResult(data.incident ?? data);
      window.localStorage.removeItem("tg.citizen.idem");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "1rem" }}>
        <div className="card col" style={{ maxWidth: 440, width: "100%", textAlign: "center", padding: "2rem" }}>
          <CheckCircle2 size={44} color="var(--ok)" style={{ margin: "0 auto" }} aria-hidden />
          <h1 style={{ fontSize: "1.2rem", marginTop: "0.8rem" }}>{t("citizen.submitted")}</h1>
          <p
            className="mono"
            aria-label={`Tracking code ${result.tracking_code}`}
            style={{
              fontSize: "1.7rem",
              fontWeight: 600,
              letterSpacing: "0.12em",
              padding: "0.7rem 1rem",
              background: "var(--bg-inset)",
              border: "1px dashed var(--line-strong)",
              borderRadius: "var(--r-md)",
              marginTop: "0.6rem",
            }}
          >
            {result.tracking_code}
          </p>
          <a href={`/track?code=${result.tracking_code}`} className="btn-primary" style={{ display: "inline-flex" }}>
            {t("citizen.trackingPrompt")}
          </a>
          <p className="faint" style={{ fontSize: "0.8rem" }}>
            Write this code down — it is the only way to follow this report.
          </p>
        </div>
      </main>
    );
  }

  const selectedCount =
    Object.values(indicators).filter(Boolean).length + (multipleVictims > 1 ? 1 : 0);

  return (
    <PageShell title={t("citizen.title")}>
      <form className="col" onSubmit={submit} style={{ maxWidth: 600, margin: "0 auto" }}>
        {/* Step 1 — what */}
        <section className="card">
          <div className="card-title">1 · {t("citizen.description")}</div>
          <textarea
            required
            minLength={3}
            maxLength={4000}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("citizen.descriptionPlaceholder")}
          />
        </section>

        {/* Step 2 — where */}
        <section className="card">
          <div className="card-title">2 · {t("citizen.location")}</div>
          <button type="button" onClick={useMyLocation} className="btn-accent" style={{ alignSelf: "flex-start" }}>
            <Crosshair size={16} />
            {t("citizen.getLocation")}
          </button>
          <div
            role="button"
            tabIndex={0}
            aria-label={t("citizen.pinHint")}
            onClick={mapClick}
            onKeyDown={(e) => e.key === "Enter" && mapClick(e as unknown as React.MouseEvent<HTMLDivElement>)}
            className="pin-picker"
            style={{ marginTop: "0.8rem" }}
          >
            {lat !== null && lng !== null && (
              <span className="pin-marker" style={{ left: `${((lng + 180) / 360) * 100}%`, top: `${((90 - lat) / 180) * 100}%` }}>
                <MapPin size={26} fill="var(--danger)" strokeWidth={1} />
              </span>
            )}
          </div>
          <p className="row muted" style={{ justifyContent: "space-between", fontSize: "0.82rem", marginTop: "0.5rem" }}>
            <span>{lat !== null ? <span className="mono">{lat.toFixed(4)}, {lng!.toFixed(4)}</span> : t("citizen.pinHint")}</span>
            {lat !== null && (
              <span className="badge st-available"><CheckCircle2 size={11} /> location set</span>
            )}
          </p>
          {geoError && (
            <p className="error-text" role="alert" style={{ marginTop: "0.4rem" }}>
              <TriangleAlert size={14} /> {geoError}
            </p>
          )}
        </section>

        {/* Step 3 — severity */}
        <section className="card">
          <div className="card-title">
            3 · {t("citizen.indicators")}
            {selectedCount > 0 && <span className="badge tier-high">{selectedCount}</span>}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: "0.4rem",
            }}
          >
            {INDICATORS.map((ind) => {
              const on = !!indicators[ind.key];
              return (
                <label
                  key={ind.key}
                  className="row"
                  style={{
                    gap: "0.5rem",
                    cursor: "pointer",
                    padding: "0.45rem 0.6rem",
                    borderRadius: "var(--r-md)",
                    border: `1px solid ${on ? "rgba(255,144,64,0.45)" : "var(--line)"}`,
                    background: on ? "rgba(255,144,64,0.08)" : "transparent",
                    transition: "all var(--t-fast)",
                  }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 17, height: 17, minHeight: 0, accentColor: "var(--tier-high)" }}
                    checked={on}
                    onChange={(e) => setIndicators((s) => ({ ...s, [ind.key]: e.target.checked }))}
                  />
                  <span style={{ fontWeight: 400, color: "var(--text-hi)", fontSize: "0.88rem" }}>
                    {locale === "es" ? ind.labelEs : ind.labelEn}
                  </span>
                </label>
              );
            })}
          </div>
          <label className="row" style={{ marginTop: "0.7rem", gap: "0.8rem" }}>
            <span style={{ whiteSpace: "nowrap" }}>
              {locale === "es" ? "Número de víctimas:" : "Number of victims:"}
            </span>
            <input
              type="number" min={0} max={999}
              style={{ width: 100 }}
              value={multipleVictims}
              onChange={(e) => setMultipleVictims(Number(e.target.value))}
            />
          </label>
        </section>

        {/* Step 4 — photo */}
        <section className="card">
          <div className="card-title">4 · {t("citizen.photo")}</div>
          <label className="btn-ghost row" style={{ cursor: "pointer", alignSelf: "flex-start" }}>
            <ImagePlus size={16} />
            {photoBusy ? t("common.loading") : photoPath ? "Photo attached ✓" : "Attach a photo"}
            <input
              type="file"
              accept="image/jpeg,image/png"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && void uploadPhoto(e.target.files[0])}
            />
          </label>
        </section>

        {error && (
          <p className="error-text card" role="alert" style={{ borderColor: "rgba(255,100,120,0.4)" }}>
            <TriangleAlert size={15} /> {error}
          </p>
        )}

        <button type="submit" className="btn-primary" disabled={busy} style={{ padding: "0.85rem", fontSize: "1rem" }}>
          <Send size={17} />
          {busy ? t("common.loading") : t("citizen.submit")}
        </button>
      </form>
    </PageShell>
  );
}
