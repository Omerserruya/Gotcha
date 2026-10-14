/**
 * "Continue on WhatsApp" from the website widget (docs/product/website-widget.md,
 * stage B). The widget opens wa.me with a pre-filled message carrying a short
 * reference code; when that message arrives on the workspace's WhatsApp
 * number, the inbound side finds the code and links the two conversations
 * (same customer, the website chat's history as context, the website chat
 * closed as "continued on WhatsApp").
 *
 * One definition for both sides: services/ai writes the code, the
 * incoming worker reads it.
 */

/** No 0/O, 1/I/L: the customer may retype it. */
export const HANDOFF_REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const HANDOFF_REF_LENGTH = 6;
/** A handoff the customer did not complete within a week is forgotten. */
export const HANDOFF_TTL_SECONDS = 7 * 24 * 60 * 60;

export const handoffRefKey = (ref: string) => `wahandoff:ref:${ref}`;
export const handoffConversationKey = (conversationId: string) => `wahandoff:conv:${conversationId}`;

/**
 * Where the visitor was when they started on WhatsApp (the WhatsApp kind of
 * widget, which has no website conversation to carry). A lookup key, never a
 * fact: the handle is re-resolved against the store before anything quotes it.
 */
export interface HandoffPageContext {
  pageType: string | null;
  productHandle: string | null;
  /** WooCommerce's numeric product id, when the page named it (preferred for the lookup). */
  productId?: string | null;
  path: string | null;
}

export interface HandoffRecord {
  tenantId: string;
  /**
   * The website conversation the customer is continuing; null when the
   * widget is the WhatsApp kind and the conversation starts on WhatsApp.
   */
  conversationId: string | null;
  /** The page they started from, for a WhatsApp-kind start. */
  context?: HandoffPageContext | null;
  /** The WhatsApp number (channel account) it continues on. */
  whatsappChannelAccountId: string;
  createdAt: string;
}

export function newHandoffRef(random: (n: number) => Uint8Array): string {
  const bytes = random(HANDOFF_REF_LENGTH);
  let out = "";
  for (let i = 0; i < HANDOFF_REF_LENGTH; i++) out += HANDOFF_REF_ALPHABET[bytes[i]! % HANDOFF_REF_ALPHABET.length];
  return out;
}

/** The pre-filled WhatsApp message (supervisor's default wording, 2026-10-07). */
export function handoffMessage(ref: string, locale: "he" | "en"): string {
  return locale === "he"
    ? `היי, ממשיכים את השיחה מהאתר (${ref})`
    : `Hi, continuing our chat from the website (${ref})`;
}

/** The widget's button label. */
export function handoffButtonLabel(locale: "he" | "en"): string {
  return locale === "he" ? "המשך בוואטסאפ" : "Continue on WhatsApp";
}

const REF_IN_TEXT = new RegExp(`\\(([${HANDOFF_REF_ALPHABET}]{${HANDOFF_REF_LENGTH}})\\)`);

/** The code in an inbound WhatsApp message, if the customer kept it. Case-insensitive. */
export function findHandoffRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = REF_IN_TEXT.exec(text.toUpperCase());
  return m ? m[1]! : null;
}

/** wa.me wants digits only (no +, spaces or dashes). Null when it is not a phone number. */
export function waMeDigits(displayPhone: string | null | undefined): string | null {
  const d = String(displayPhone ?? "").replace(/\D+/g, "");
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export function waMeUrl(digits: string, text: string): string {
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
