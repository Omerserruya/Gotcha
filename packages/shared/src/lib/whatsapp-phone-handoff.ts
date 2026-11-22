/**
 * "Continue on WhatsApp? Enter your phone" in the website widget (W2, 2026-11-22).
 *
 * The visitor types a number; the BUSINESS's own connected WhatsApp number sends one approved template
 * from its own WABA (billed to the business by Meta, never to us), carrying the handoff code in its
 * quick-reply button, so the reply joins the same thread (W1). Never GOTCHA's platform number.
 *
 * The widget offers it only when everything is in place; otherwise the existing wa.me link with the
 * code (the visitor writes first: no template, no charge). One state for the widget, computed on the
 * server: waHandoffMode "phone" | "code" | "off".
 *
 * Meta has no field that says a WABA's payment method works for business-initiated messages, so the
 * only signal is a send that fails with 131042 ("Business eligibility payment issue"): the number then
 * drops back to "code" for a day, logged, and tries "phone" again after it (or at once when a person
 * turns the option off and on).
 */
import { HANDOFF_REF_ALPHABET, HANDOFF_REF_LENGTH } from "./whatsapp-handoff";

/** The template's name under each business's WABA. */
export const PHONE_HANDOFF_TEMPLATE_NAME = "website_chat_handoff";
/** metadata.source of the template message row. */
export const PHONE_HANDOFF_SOURCE = "website_phone_handoff";

export type WaHandoffMode = "phone" | "code" | "off";

/** Pure. `codeAvailable`: the existing "Continue on WhatsApp" link can show at all. */
export function waHandoffMode(s: {
  codeAvailable: boolean;
  phoneHandoffOn: boolean;
  numberConnected: boolean;
  templateApproved: boolean;
  paymentBlocked: boolean;
}): WaHandoffMode {
  if (!s.codeAvailable) return "off";
  return s.phoneHandoffOn && s.numberConnected && s.templateApproved && !s.paymentBlocked ? "phone" : "code";
}

// ─── The code in the template's button ──────────────────────

const BUTTON_PREFIX = "wah_";
const REF_ONLY = new RegExp(`^[${HANDOFF_REF_ALPHABET}]{${HANDOFF_REF_LENGTH}}$`);

/** The quick-reply payload the template's button carries. */
export function handoffButtonPayload(ref: string): string {
  return `${BUTTON_PREFIX}${ref}`;
}

/** The code back from a tapped button, or null when the payload is not ours. */
export function handoffRefFromButton(payload: string | null | undefined): string | null {
  const p = String(payload ?? "");
  if (!p.startsWith(BUTTON_PREFIX)) return null;
  const ref = p.slice(BUTTON_PREFIX.length).toUpperCase();
  return REF_ONLY.test(ref) ? ref : null;
}

/**
 * The send waiting for the visitor's first WhatsApp message: per business number and visitor digits,
 * { ref, messageId }, kept as long as the code. A reply typed instead of the button still links.
 */
export const handoffPendingKey = (channelAccountId: string, digits: string) => `wahandoff:pending:${channelAccountId}:${digits}`;
export interface HandoffPending { ref: string; messageId: string; websiteConversationId: string }

// ─── Limits ──────────────────────────────────────────────────

export const PHONE_HANDOFF_LIMITS = {
  /** One template per visitor number per business number per day. */
  perNumberPerDay: 1,
  /** Two per website conversation per day (a typo, then the right number). */
  perConversationPerDay: 2,
  /** Five per visitor address per hour. */
  perIpPerHour: 5,
  /** Two hundred per business per day. */
  perBusinessPerDay: 200,
} as const;

export const phoneHandoffLimitKeys = (a: { channelAccountId: string; digits: string; websiteConversationId: string; ip: string; tenantId: string; day: string; hour: string }) => [
  { key: `wahandoff:rl:num:${a.channelAccountId}:${a.digits}`, max: PHONE_HANDOFF_LIMITS.perNumberPerDay, ttl: 24 * 3600 },
  { key: `wahandoff:rl:conv:${a.websiteConversationId}`, max: PHONE_HANDOFF_LIMITS.perConversationPerDay, ttl: 24 * 3600 },
  { key: `wahandoff:rl:ip:${a.ip}:${a.hour}`, max: PHONE_HANDOFF_LIMITS.perIpPerHour, ttl: 3600 },
  { key: `wahandoff:rl:biz:${a.tenantId}:${a.day}`, max: PHONE_HANDOFF_LIMITS.perBusinessPerDay, ttl: 26 * 3600 },
];

// ─── The payment signal ──────────────────────────────────────

/** Meta's "Business eligibility payment issue": the WABA cannot pay for a business-initiated message. */
export const PAYMENT_BLOCK_CODES: readonly number[] = [131042];
/** How long a number stays in "code" after a payment failure before "phone" is tried again. */
export const PAYMENT_BLOCK_LAPSE_MS = 24 * 3600 * 1000;
/** The durable setting that remembers it, per business number. */
export const paymentBlockKey = (channelAccountId: string) => `waPhoneHandoffPaymentBlock:${channelAccountId}`;

export function isPaymentBlockError(sendError: { code?: unknown } | null | undefined): boolean {
  const code = Number((sendError as any)?.code);
  return Number.isFinite(code) && PAYMENT_BLOCK_CODES.includes(code);
}

/** Pure: the stored value means blocked now. */
export function paymentBlockedAt(raw: string | null | undefined, now: Date): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw);
    const at = new Date(v?.at).getTime();
    return Number.isFinite(at) && now.getTime() - at < PAYMENT_BLOCK_LAPSE_MS;
  } catch {
    return false;
  }
}

type SettingIo = {
  read: (tenantId: string, key: string) => Promise<string | null>;
  write: (tenantId: string, key: string, value: string | null, by?: string) => Promise<void>;
};

async function io(): Promise<SettingIo> {
  const m = await import("./durable-settings");
  return { read: m.readDurableSetting, write: m.writeDurableSetting };
}

export async function isPaymentBlocked(tenantId: string, channelAccountId: string, now = new Date(), s?: SettingIo): Promise<boolean> {
  try {
    const { read } = s ?? (await io());
    return paymentBlockedAt(await read(tenantId, paymentBlockKey(channelAccountId)), now);
  } catch {
    return false;
  }
}

/** A send of the handoff template failed for payment: back to "code" for a day. Logged without the visitor's number. */
export async function recordPaymentBlock(tenantId: string, channelAccountId: string, code: number, phase: "send" | "delivery", now = new Date(), s?: SettingIo): Promise<void> {
  try {
    const { write } = s ?? (await io());
    await write(tenantId, paymentBlockKey(channelAccountId), JSON.stringify({ at: now.toISOString(), code, phase }), "system:wa-phone-handoff");
    console.warn(`[wa-phone-handoff] payment issue (Meta ${code}, ${phase}) tenant=${tenantId} number=${channelAccountId}: the widget offers the WhatsApp link instead for 24 hours`);
  } catch (err) {
    console.warn("[wa-phone-handoff] payment block not recorded:", (err as Error)?.message);
  }
}

export async function clearPaymentBlock(tenantId: string, channelAccountId: string, s?: SettingIo): Promise<void> {
  try {
    const { write } = s ?? (await io());
    await write(tenantId, paymentBlockKey(channelAccountId), null);
  } catch {
    /* nothing stored is the same as cleared */
  }
}

/**
 * A delivery status for one of our messages (the webhook): a FAILED handoff template with 131042 is the
 * WABA's payment failing after Meta accepted the send. Records the block; true when it did.
 */
export async function paymentBlockFromStatus(
  tenantId: string,
  message: { metadata?: unknown },
  status: { status?: string | null; mapped?: string | null; error?: { code?: unknown } | null },
  now = new Date(),
  s?: SettingIo,
): Promise<boolean> {
  const meta = message?.metadata && typeof message.metadata === "object" ? (message.metadata as Record<string, any>) : {};
  const failed = status.mapped === "FAILED" || status.status === "failed";
  const account = meta.handoff?.channelAccountId;
  if (!failed || meta.source !== PHONE_HANDOFF_SOURCE || !account || !isPaymentBlockError(status.error ?? null)) return false;
  await recordPaymentBlock(tenantId, String(account), Number((status.error as any).code), "delivery", now, s);
  return true;
}
