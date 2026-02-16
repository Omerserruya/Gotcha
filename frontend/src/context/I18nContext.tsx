"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { Locale, Direction, localeConfig, getTranslation, t as translate } from "@/i18n";

interface I18nContextType {
  locale: Locale;
  dir: Direction;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType>({
  locale: "en",
  dir: "ltr",
  setLocale: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [translations, setTranslations] = useState(getTranslation("en"));

  useEffect(() => {
    const saved = localStorage.getItem("locale") as Locale | null;
    if (saved && localeConfig[saved]) {
      setLocaleState(saved);
      setTranslations(getTranslation(saved));
    }
  }, []);

  useEffect(() => {
    document.documentElement.dir = localeConfig[locale].dir;
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    localStorage.setItem("locale", newLocale);
    setLocaleState(newLocale);
    setTranslations(getTranslation(newLocale));
  }, []);

  const t = useCallback(
    (key: string) => translate(translations, key),
    [translations]
  );

  const dir = localeConfig[locale].dir;

  return (
    <I18nContext.Provider value={{ locale, dir, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
