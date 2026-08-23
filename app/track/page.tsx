"use client";

import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { PageShell, TierBadge, StatusBadge } from "@/lib/components/ui";
import { useI18n } from "@/lib/i18n";

interface TrackResult {
  tracking_code: string;
  status: string;
  priority_tier: string;
  created_at: string;
  summary: string;
  approx_location: { lat: number; lng: number };
}

export default function TrackPage() {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [result, setResult] = useState<TrackResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(async (c: string) => {
    setError(null);
    setResult(null);
    const res = await fetch(`/api/incidents?code=${encodeURIComponent(c)}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? t("common.error"));
      return;
    }
    setResult(data);
  }, [t]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("code");
    if (q) { setCode(q); void lookup(q); }
  }, [lookup]);

  return (
    <PageShell title={t("citizen.trackingPrompt")}>
      <div style={{ maxWidth: 520, margin: "1.5rem auto 0" }} className="col">
        <form
          className="row"
          onSubmit={(e) => { e.preventDefault(); void lookup(code.trim()); }}
          style={{ flexWrap: "nowrap" }}
        >
          <input
            className="mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("citizen.trackingCode")}
            minLength={22}
            maxLength={22}
            required
            aria-label={t("citizen.trackingCode")}
          />
          <button type="submit" className="btn-primary" style={{ flexShrink: 0 }}>
            <Search size={16} />
            {t("citizen.track")}
          </button>
        </form>

        {error && (
          <div className="card error-text" role="alert" style={{ borderColor: "rgba(255,100,120,0.4)" }}>
            {error}
          </div>
        )}

        {result && (
          <section className="card col" aria-live="polite">
            <p className="mono faint" style={{ letterSpacing: "0.12em", fontSize: "0.85rem" }}>
              {result.tracking_code}
            </p>
            <h2 style={{ fontSize: "1.05rem", margin: "0.2rem 0 0.4rem" }}>{result.summary}</h2>
            <div className="row">
              <StatusBadge status={result.status} />
              <TierBadge tier={result.priority_tier} />
            </div>
            <hr className="divider" />
            <dl className="col" style={{ gap: "0.45rem", margin: 0, fontSize: "0.9rem" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <dt className="muted">{t("citizen.reportedAt")}</dt>
                <dd className="mono">{new Date(result.created_at).toLocaleString()}</dd>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <dt className="muted">Approx. area</dt>
                <dd className="mono">{result.approx_location.lat}, {result.approx_location.lng}</dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </PageShell>
  );
}
