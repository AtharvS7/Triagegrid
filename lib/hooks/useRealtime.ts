"use client";

import { useEffect } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

/**
 * FR-12 realtime wiring. Subscribes to postgres_changes on the shared
 * publication (incidents/units/hospitals/resource_claims/notifications).
 * Supabase Realtime enforces RLS per subscriber, so each client only ever
 * receives rows it is authorized to read — no agency filter needed here.
 */
export function useRealtime(
  tables: string[],
  onChange: (table: string) => void,
) {
  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const channel = supabase.channel("triagegrid-realtime");

    for (const table of tables) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => onChange(table),
      );
    }

    void channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(",")]);
}
