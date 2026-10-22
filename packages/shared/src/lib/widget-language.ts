/**
 * The widget follows the customer's language (W10, 2026-10-14).
 *
 * The widget's own strings come in Hebrew and English (the bundle's tables);
 * it starts in the page's language and, after the customer's first message,
 * switches to the language they wrote in. The merchant's own texts (welcome,
 * suggested questions, launcher label, teaser, offline message) are translated
 * into that language by services/ai, cached per text and language, so each
 * distinct text costs one translation once, not one per conversation.
 */
import type { ShopifyChatUx } from "./shopify-chat-ux";

export type WidgetLocale = "he" | "en";

export function isWidgetLocale(v: unknown): v is WidgetLocale {
  return v === "he" || v === "en";
}

const HEBREW = /[\u0590-\u05FF]/;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/**
 * The language a customer's message is in, or null when it is too short to
 * tell (an emoji, "ok", a number): the widget then stays as it is.
 */
export function visitorLocaleOf(text: string | null | undefined): WidgetLocale | null {
  const s = String(text ?? "");
  if (HEBREW.test(s)) return "he";
  return (s.match(LATIN_WORD) ?? []).length >= 2 ? "en" : null;
}

/**
 * The language a merchant text is written in, by its letters; null when it
 * has too few to tell (it is then shown as written).
 */
export function textLocaleOf(text: string): WidgetLocale | "other" | null {
  const s = String(text ?? "");
  const he = (s.match(/[\u0590-\u05FF]/g) ?? []).length;
  const en = (s.match(/[A-Za-z]/g) ?? []).length;
  const other = (s.match(/[\u0600-\u06FF\u0400-\u04FF]/g) ?? []).length;
  const best = Math.max(he, en, other);
  if (best < 3) return null;
  return best === he ? "he" : best === en ? "en" : "other";
}

/** The merchant's texts the widget shows, by a stable key. Names are not translated. */
export function widgetTextsOf(ux: ShopifyChatUx, offlineMessage: string): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => { if (typeof v === "string" && v.trim()) out[k] = v; };
  put("welcome.title", ux.welcome.title);
  put("welcome.subtitle", ux.welcome.subtitle);
  ux.welcome.suggestedQuestions.forEach((q, i) => put(`welcome.suggestedQuestions.${i}`, q));
  put("launcher.label", ux.launcher.label);
  // The teaser's texts only when it shows: no translation is paid for a text no one sees.
  if (ux.proactive.enabled) {
    put("proactive.title", ux.proactive.title);
    put("proactive.message", ux.proactive.message);
    put("proactive.actionLabel", ux.proactive.actionLabel);
  }
  put("offline.message", offlineMessage);
  return out;
}

/** The texts that need translating into `target` (written in another language). */
export function textsToTranslate(texts: Record<string, string>, target: WidgetLocale): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(texts)) {
    const lang = textLocaleOf(v);
    if (lang && lang !== target) out[k] = v;
  }
  return out;
}
