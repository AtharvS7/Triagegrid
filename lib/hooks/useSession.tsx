"use client";

import { useEffect, useState, createContext, useContext } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import type { Personnel, PersonnelRole } from "@/lib/types";

interface SessionCtx {
  personnel: Personnel | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({
  personnel: null,
  loading: true,
  refresh: async () => undefined,
});

/**
 * Session + personnel/role context.
 * Subscribes to onAuthStateChange so SIGNED_OUT (or a dead session) clears
 * personnel immediately — previously a stale personnel object survived
 * signOut() and the login page bounced the user straight back to their
 * console, making sign-out appear broken everywhere.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [personnel, setPersonnel] = useState<Personnel | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const supabase = getSupabaseBrowser();
    const { data: auth, error } = await supabase.auth.getUser();
    if (error || !auth?.user) {
      setPersonnel(null);
      setLoading(false);
      return;
    }
    const { data, error: pErr } = await supabase
      .from("personnel")
      .select("*")
      .eq("id", auth.user.id)
      .single();
    setPersonnel(pErr ? null : ((data as Personnel) ?? null));
    setLoading(false);
  };

  useEffect(() => {
    const supabase = getSupabaseBrowser();

    void refresh();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setPersonnel(null);
        setLoading(false);
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        void refresh();
      }
    });

    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Ctx.Provider value={{ personnel, loading, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession() {
  return useContext(Ctx);
}

export function roleHome(role: PersonnelRole | null | undefined): string {
  switch (role) {
    case "dispatcher":
      return "/dispatcher";
    case "field":
      return "/field";
    case "hospital_admin":
      return "/hospital";
    case "admin":
      return "/admin";
    default:
      return "/login";
  }
}
