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

/** Nested key accessor with optional interpolation: t("auth.login") or t("msg", { name: "John" }) */
export function t(translations: any, key: string, vars?: Record<string, string>): string {
  let value: string = key.split(".").reduce((obj, k) => obj?.[k], translations) || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return value;
}

export { en, he };
