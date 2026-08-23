"use client";

import { useEffect } from "react";

/** Registers the field PWA service worker (offline shell). */
export default function FieldLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);
  return <>{children}</>;
}
