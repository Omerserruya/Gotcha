"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { Locale, Direction, localeConfig, getTranslation, t as translate } from "@/i18n";
import { useAuth } from "@/context/AuthContext";

interface I18nContextType {
  locale: Locale;
  dir: Direction;
  /** True while we're hydrating the effective locale from the server. */
  loading: boolean;
  /**
   * Persist the agent's per-user override on the server. Passing null
   * clears the override, reverting to the tenant default. The local
   * state updates optimistically; on failure it rolls back.
   */
  setLocale: (locale: Locale | null) => Promise<void>;
  /** Read-only echoes from the server resolver, for the Settings UI. */
  tenantDefault: Locale | null;
  userOverride: Locale | null;
  /** Admin-only: persist the org-wide default. */
  setTenantDefault: (locale: Locale) => Promise<void>;
  t: (key: string, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nContextType>({
  locale: "en",
  dir: "ltr",
  loading: true,
  setLocale: async () => {},
  tenantDefault: null,
  userOverride: null,
  setTenantDefault: async () => {},
  t: (key) => key,
});

const LOCALE_API = "/api/agents/me/locale";
const TENANT_LOCALE_API = "/api/agents/settings/locale";
// LocalStorage is now ONLY used as a render-warm hint so the page doesn't
// flash English while we wait for the server resolver. The server value
// is authoritative — when it disagrees, we adopt it and overwrite.
const LOCALE_CACHE_KEY = "locale";

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && value in localeConfig;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window === "undefined") return "en";
    const saved = window.localStorage.getItem(LOCALE_CACHE_KEY);
    return isLocale(saved) ? saved : "en";
  });
  const [translations, setTranslations] = useState(() => getTranslation(locale));
  const [tenantDefault, setTenantDefault] = useState<Locale | null>(null);
  const [userOverride, setUserOverride] = useState<Locale | null>(null);
  const [loading, setLoading] = useState(true);
  const hydratedRef = useRef(false);

  // Server hydration. Reads the effective locale from /api/agents/me/locale.
  // Runs once on auth ready; subsequent token changes (re-login as a
  // different agent) re-hydrate.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    fetch(LOCALE_API, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error("locale_fetch_failed");
        return r.json() as Promise<{
          data: {
            effective: Locale;
            tenantDefault: Locale;
            userOverride: Locale | null;
          };
        }>;
      })
      .then((res) => {
        if (cancelled) return;
        const eff = isLocale(res.data.effective) ? res.data.effective : "en";
        const td = isLocale(res.data.tenantDefault) ? res.data.tenantDefault : "en";
        const uo = isLocale(res.data.userOverride) ? res.data.userOverride : null;
        setLocaleState(eff);
        setTranslations(getTranslation(eff));
        setTenantDefault(td);
        setUserOverride(uo);
        try { window.localStorage.setItem(LOCALE_CACHE_KEY, eff); } catch { /* noop */ }
        hydratedRef.current = true;
      })
      .catch(() => { /* keep cached locale; non-fatal */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // Document-level RTL/LTR + lang attribute. Runs whenever the effective
  // locale shifts (either by hydration or by an explicit set).
  useEffect(() => {
    document.documentElement.dir = localeConfig[locale].dir;
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback(
    async (nextLocale: Locale | null) => {
      if (!token) throw new Error("not_authenticated");
      const prevEffective = locale;
      const prevOverride = userOverride;
      // Optimistic UI: assume server will accept.
      const optimisticEffective = nextLocale ?? tenantDefault ?? "en";
      setLocaleState(optimisticEffective);
      setTranslations(getTranslation(optimisticEffective));
      setUserOverride(nextLocale);
      try { window.localStorage.setItem(LOCALE_CACHE_KEY, optimisticEffective); } catch { /* noop */ }
      try {
        const res = await fetch(LOCALE_API, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ locale: nextLocale }),
        });
        if (!res.ok) throw new Error("locale_save_failed");
        const payload = await res.json() as { data: { effective: Locale; userOverride: Locale | null } };
        const eff = isLocale(payload.data.effective) ? payload.data.effective : optimisticEffective;
        setLocaleState(eff);
        setTranslations(getTranslation(eff));
        setUserOverride(isLocale(payload.data.userOverride) ? payload.data.userOverride : null);
        try { window.localStorage.setItem(LOCALE_CACHE_KEY, eff); } catch { /* noop */ }
      } catch (err) {
        // Roll back to the pre-call state on failure.
        setLocaleState(prevEffective);
        setTranslations(getTranslation(prevEffective));
        setUserOverride(prevOverride);
        try { window.localStorage.setItem(LOCALE_CACHE_KEY, prevEffective); } catch { /* noop */ }
        throw err;
      }
    },
    [token, locale, tenantDefault, userOverride],
  );

  const setTenantDefaultLocale = useCallback(
    async (nextLocale: Locale) => {
      if (!token) throw new Error("not_authenticated");
      const prev = tenantDefault;
      setTenantDefault(nextLocale);
      try {
        const res = await fetch(TENANT_LOCALE_API, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ locale: nextLocale }),
        });
        if (!res.ok) throw new Error("tenant_locale_save_failed");
        // When the current agent has no override, the tenant default
        // change immediately becomes their effective locale.
        if (userOverride == null) {
          setLocaleState(nextLocale);
          setTranslations(getTranslation(nextLocale));
          try { window.localStorage.setItem(LOCALE_CACHE_KEY, nextLocale); } catch { /* noop */ }
        }
      } catch (err) {
        setTenantDefault(prev);
        throw err;
      }
    },
    [token, tenantDefault, userOverride],
  );

  const t = useCallback(
    (key: string, vars?: Record<string, string>) => translate(translations, key, vars),
    [translations],
  );

  const dir = localeConfig[locale].dir;

  return (
    <I18nContext.Provider
      value={{
        locale,
        dir,
        loading,
        setLocale,
        tenantDefault,
        userOverride,
        setTenantDefault: setTenantDefaultLocale,
        t,
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
