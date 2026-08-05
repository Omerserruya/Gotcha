/**
 * Per-message text direction.
 *
 * The problem this exists to solve: a widget that picks ONE direction at
 * boot and applies it to every bubble is wrong the moment a conversation
 * is real. A Hebrew shopper asks about "Cloud Pro Runner", the assistant
 * answers in Hebrew and quotes a URL, an agent joins and types English.
 * One direction cannot be right for all three, and getting it wrong does
 * not merely look untidy - a right-aligned English sentence with its
 * full stop on the left reads as broken software.
 *
 * So direction is resolved PER MESSAGE, in this order:
 *
 *   1. explicit language metadata on the message/content
 *   2. dominant script of that individual message
 *   3. conversation locale
 *   4. store / widget locale
 *   5. LTR
 *
 * Two deliberate design choices:
 *
 *   • Detection counts STRONG characters only, after URLs, emails, money
 *     and part codes have been lifted out. Otherwise a one-line Hebrew
 *     message carrying a 60-character Shopify URL counts as English.
 *
 *   • The threshold is a SHARE, not a majority. "אני מחפש משהו כמו Nike
 *     Air Max 90" is a Hebrew sentence even though Latin letters
 *     outnumber Hebrew ones; "The שלום hoodie is nice" is an English one.
 *     See RTL_SHARE_THRESHOLD.
 *
 * This module is pure and dependency-free on purpose: the storefront
 * widget ships without a bundler and restates these rules in ES5, and the
 * parity test (frontend/src/components/shopify/__tests__/widget-rtl-parity.test.ts)
 * fails the moment the two disagree.
 */

export type TextDirection = "ltr" | "rtl";

/** Merchant-facing override. "auto" means "resolve it per message". */
export type DirectionSetting = TextDirection | "auto";

/**
 * Languages written right-to-left that GOTCHA commits to rendering
 * correctly. Hebrew, Arabic, Persian and Urdu are the required set; the
 * rest are here because they share the same scripts and excluding them
 * would mean rendering an Arabic-script language left-to-right for no
 * reason.
 *
 * `iw` and `in` are the deprecated ISO codes some Shopify storefronts and
 * older browsers still emit for Hebrew.
 */
export const RTL_LANGUAGES: ReadonlyArray<string> = [
  "he", "iw",          // Hebrew
  "ar",                // Arabic
  "fa", "prs",         // Persian / Dari
  "ur",                // Urdu
  "ps",                // Pashto
  "sd",                // Sindhi
  "ug",                // Uyghur
  "ckb", "ku",         // Central Kurdish
  "yi", "ji",          // Yiddish
  "dv",                // Dhivehi
  "arc",               // Aramaic
  "syr",               // Syriac
  "he-il", "ar-sa", "ar-ae", "ar-eg", "fa-ir", "ur-pk",
];

const RTL_LANGUAGE_SET = new Set(RTL_LANGUAGES);

/**
 * Strong right-to-left characters: Hebrew, Arabic (incl. the Persian and
 * Urdu extensions), Syriac, Thaana, and the presentation-form blocks a
 * copy-paste from a PDF or an older system can still produce.
 */
export const STRONG_RTL_RE =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u07C0-\u07FF\u0800-\u083F\u0840-\u085F\u0860-\u086F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Strong left-to-right characters. Latin (with its accented ranges),
 * Greek, Cyrillic, and the CJK/Hangul/Kana blocks - a Japanese product
 * name is as much "not RTL" as an English one.
 */
export const STRONG_LTR_RE =
  /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF\u2C60-\u2C7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

const STRONG_RTL_GLOBAL = new RegExp(STRONG_RTL_RE.source, "g");
const STRONG_LTR_GLOBAL = new RegExp(STRONG_LTR_RE.source, "g");

/**
 * Share of strong characters that must be RTL for a message to be
 * rendered RTL.
 *
 * 0.3 is not arbitrary. Below it sit the messages an English speaker
 * writes with one borrowed word ("The שלום hoodie is nice" - 5 of 22, or
 * 0.23). Above it sit the Hebrew sentences that name Latin-script
 * products, which is most of commerce ("אני מחפש משהו כמו Nike Air Max
 * 90" - 13 of 24, or 0.54, and even the terse "רוצה את Cloud Pro Runner"
 * at 9 of 24, or 0.375). A pure majority rule gets the second group
 * wrong, which is the group that actually matters here.
 */
export const RTL_SHARE_THRESHOLD = 0.3;

// ─── Neutral atoms ───────────────────────────────────────────

/**
 * Runs that carry no linguistic direction of their own and must never
 * vote. A URL is Latin characters, but a Hebrew sentence does not become
 * English by containing one.
 *
 * Order matters: URLs before emails before part codes, so the longest
 * match wins and a URL is not chopped up by the SKU pattern.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** Money written either way round: "$120.00", "120.00 USD", "₪49". */
const MONEY_RE =
  /(?:[$₪€£¥₹]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|ILS|EUR|GBP|JPY|AED|SAR|INR|NIS)\b|\b(?:USD|ILS|EUR|GBP|JPY|AED|SAR|INR|NIS)\s?\d[\d.,]*)/gi;
/** Part / SKU / model codes: "SKU-4471", "AIR-MAX-90", "GTX1080". */
const SKU_RE = /\b[A-Z0-9]{2,}(?:[-_/][A-Z0-9]+)+\b/g;
/** International phone numbers. */
const PHONE_RE = /\+\d[\d\s\-().]{6,}\d/g;

const NEUTRAL_ATOM_PATTERNS: RegExp[] = [URL_RE, EMAIL_RE, MONEY_RE, SKU_RE, PHONE_RE];

/**
 * Remove the atoms above so only real prose votes on direction.
 * Replaced with a space rather than deleted, so two words never fuse.
 */
export function stripNeutralAtoms(text: string): string {
  let out = text;
  for (const pattern of NEUTRAL_ATOM_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), " ");
  }
  return out;
}

export interface ScriptCounts {
  rtl: number;
  ltr: number;
  /** Share of strong characters that are RTL; 0 when there are none. */
  rtlShare: number;
}

/** Count strong characters, after neutral atoms have been lifted out. */
export function countStrongCharacters(text: string | null | undefined): ScriptCounts {
  const clean = stripNeutralAtoms(String(text ?? ""));
  const rtl = (clean.match(STRONG_RTL_GLOBAL) ?? []).length;
  const ltr = (clean.match(STRONG_LTR_GLOBAL) ?? []).length;
  const total = rtl + ltr;
  return { rtl, ltr, rtlShare: total === 0 ? 0 : rtl / total };
}

/**
 * Direction of one piece of text by its dominant script, or null when the
 * text has no strong characters at all ("👍", "42", "!!!").
 *
 * Returning null rather than guessing LTR is the point: the caller then
 * falls through to the conversation locale, so a Hebrew shopper's "👍"
 * still renders in the direction the rest of their conversation uses.
 */
export function detectScriptDirection(text: string | null | undefined): TextDirection | null {
  const { rtl, ltr, rtlShare } = countStrongCharacters(text);
  if (rtl === 0 && ltr === 0) return null;
  if (rtl === 0) return "ltr";
  if (ltr === 0) return "rtl";
  return rtlShare >= RTL_SHARE_THRESHOLD ? "rtl" : "ltr";
}

// ─── Locale → direction ──────────────────────────────────────

/** Is this BCP-47 tag (or bare language code) written right to left? */
export function isRtlLocale(locale: string | null | undefined): boolean {
  if (typeof locale !== "string") return false;
  const tag = locale.trim().toLowerCase().replace(/_/g, "-");
  if (!tag) return false;
  if (RTL_LANGUAGE_SET.has(tag)) return true;
  const primary = tag.split("-")[0];
  return RTL_LANGUAGE_SET.has(primary);
}

/** Direction implied by a locale, or null when the locale is unusable. */
export function directionForLocale(locale: string | null | undefined): TextDirection | null {
  if (typeof locale !== "string" || !locale.trim()) return null;
  return isRtlLocale(locale) ? "rtl" : "ltr";
}

// ─── The resolution chain ────────────────────────────────────

export interface MessageDirectionInput {
  /**
   * 1. Explicit language metadata on this message. Highest priority
   *    because it is the only signal that is a statement rather than a
   *    guess - a translated message knows its own language.
   */
  contentLocale?: string | null;
  /** 2. The message text itself. */
  text?: string | null;
  /** 3. Conversation-level detected locale (Conversation.detectedLocale). */
  conversationLocale?: string | null;
  /** 4. Store / widget locale. */
  widgetLocale?: string | null;
  /**
   * Merchant override from channel config. "rtl"/"ltr" short-circuits the
   * whole chain; "auto" (the default) runs it.
   */
  override?: DirectionSetting | null;
}

export interface ResolvedMessageDirection {
  direction: TextDirection;
  /** Which rung of the chain answered. Surfaced for tests and debugging. */
  source: "override" | "content_locale" | "script" | "conversation_locale" | "widget_locale" | "default";
}

/**
 * Resolve one message's direction. Pure; safe to call per render.
 */
export function resolveMessageDirection(
  input: MessageDirectionInput,
): ResolvedMessageDirection {
  if (input.override === "rtl" || input.override === "ltr") {
    return { direction: input.override, source: "override" };
  }

  const fromContent = directionForLocale(input.contentLocale);
  if (fromContent) return { direction: fromContent, source: "content_locale" };

  const fromScript = detectScriptDirection(input.text);
  if (fromScript) return { direction: fromScript, source: "script" };

  const fromConversation = directionForLocale(input.conversationLocale);
  if (fromConversation) return { direction: fromConversation, source: "conversation_locale" };

  const fromWidget = directionForLocale(input.widgetLocale);
  if (fromWidget) return { direction: fromWidget, source: "widget_locale" };

  return { direction: "ltr", source: "default" };
}

/** Convenience: just the direction. */
export function messageDirection(input: MessageDirectionInput): TextDirection {
  return resolveMessageDirection(input).direction;
}

// ─── Bidi-safe segmentation ──────────────────────────────────

export interface BidiSegment {
  text: string;
  /**
   * "isolate" segments must be rendered inside a `<bdi>` (or an element
   * with `unicode-bidi: isolate`). They are the atoms that come out
   * reversed or with their punctuation displaced when the Unicode
   * bidirectional algorithm is left to resolve them against surrounding
   * RTL prose: URLs, emails, prices, part codes, phone numbers.
   */
  kind: "text" | "isolate";
}

/**
 * Split text into prose and isolate-me atoms.
 *
 * This is what stops "בקר בכתובת https://shop.com/products/x." rendering
 * with the full stop at the wrong end of the URL, and what stops
 * "המחיר $120.00" showing the dollar sign on the right of the number.
 *
 * Deliberately conservative: bare digit runs are NOT isolated. "3 מוצרים"
 * is handled correctly by the bidi algorithm already, and isolating every
 * number would break number-plus-Hebrew-word phrasing.
 */
export function segmentBidiText(text: string | null | undefined): BidiSegment[] {
  const src = String(text ?? "");
  if (!src) return [];

  // One combined pass so the longest atom wins at each position.
  const combined = new RegExp(
    NEUTRAL_ATOM_PATTERNS.map((p) => `(?:${p.source})`).join("|"),
    "gi",
  );

  const segments: BidiSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = combined.exec(src)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: src.slice(cursor, match.index), kind: "text" });
    }
    segments.push({ text: match[0], kind: "isolate" });
    cursor = match.index + match[0].length;
    // A zero-length match would spin forever; regexes above cannot
    // produce one, but the guard costs nothing next to a hung storefront.
    if (match[0].length === 0) combined.lastIndex++;
  }
  if (cursor < src.length) {
    segments.push({ text: src.slice(cursor), kind: "text" });
  }
  return segments;
}

/**
 * Does this text need bidi isolation at all? Cheap pre-check so the
 * common case (plain prose, no URLs) skips segmentation entirely.
 */
export function needsBidiIsolation(text: string | null | undefined): boolean {
  return segmentBidiText(text).some((s) => s.kind === "isolate");
}

/** CSS `text-align` value for a direction. */
export function textAlignFor(direction: TextDirection): "left" | "right" {
  return direction === "rtl" ? "right" : "left";
}

/** The physical side an inline-start edge sits on. */
export function inlineStartSide(direction: TextDirection): "left" | "right" {
  return direction === "rtl" ? "right" : "left";
}

/** The physical side an inline-end edge sits on. */
export function inlineEndSide(direction: TextDirection): "left" | "right" {
  return direction === "rtl" ? "left" : "right";
}
