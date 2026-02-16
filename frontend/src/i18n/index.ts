import en from "./en.json";
import he from "./he.json";

export type Locale = "en" | "he";
export type Direction = "ltr" | "rtl";

const translations: Record<Locale, typeof en> = { en, he };

export const localeConfig: Record<Locale, { label: string; dir: Direction }> = {
  en: { label: "English", dir: "ltr" },
  he: { label: "עברית", dir: "rtl" },
};

export function getTranslation(locale: Locale): typeof en {
  return translations[locale] || translations.en;
}

/** Nested key accessor: t("auth.login") */
export function t(translations: any, key: string): string {
  return key.split(".").reduce((obj, k) => obj?.[k], translations) || key;
}

export { en, he };
