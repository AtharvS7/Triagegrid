"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import en from "./en.json";
import es from "./es.json";

export type Locale = "en" | "es";

const DICTS: Record<Locale, unknown> = { en, es };

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFunc;
}

const Ctx = createContext<I18nCtx>({
  locale: "en",
  setLocale: () => undefined,
  t: (k) => k,
});

function lookup(dict: unknown, path: string): string | undefined {
  let cur: unknown = dict;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
}

const makeT =
  (locale: Locale): TFunc =>
  (key, vars) => {
    const raw = lookup(DICTS[locale], key) ?? lookup(DICTS.en, key) ?? key;
    if (!vars) return raw;
    return Object.entries(vars).reduce(
      (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
      raw,
    );
  };

/**
 * FR-13 i18n provider. Locale persists to localStorage immediately and is
 * mirrored to personnel.locale (server-side persistence) by callers that hold
 * a session.
 */
export function I18nProvider({
  children,
  initialLocale = "en",
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const stored = window.localStorage.getItem("tg.locale") as Locale | null;
    if (stored && stored !== locale) setLocaleState(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    window.localStorage.setItem("tg.locale", l);
    document.documentElement.lang = l;
  }, []);

  const value = useMemo(
    () => ({ locale, setLocale, t: makeT(locale) }),
    [locale, setLocale],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}
