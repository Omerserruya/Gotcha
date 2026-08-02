/** The two languages every published legal document exists in. */
export type LegalLocale = "en" | "he";

export const LEGAL_LOCALES: LegalLocale[] = ["en", "he"];

export function isLegalLocale(v: unknown): v is LegalLocale {
  return v === "en" || v === "he";
}
