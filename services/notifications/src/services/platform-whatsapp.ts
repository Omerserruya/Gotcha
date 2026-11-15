/**
 * GOTCHA's OWN WhatsApp number, and the templates it may send.
 *
 * Platform notifications - "an action needs your approval", "your AI credit is
 * nearly gone" - must not go out from the merchant's customer-facing number.
 * `whatsapp-approval.service.ts` does exactly that today: it picks the tenant's
 * own `ChannelAccount` and sends from it, which spends the merchant's messaging
 * allowance and puts GOTCHA's operational alerts in the thread their customers
 * write to.
 *
 * ── Why this is not a ChannelAccount row ──
 *
 * `ChannelAccount` is tenant-scoped. The platform number belongs to no tenant,
 * and giving it a row under some tenant id would put it in every query that
 * lists "your channels" - including the ones a merchant sees and the ones
 * billing counts. It is deployment configuration, so it lives in the
 * environment, and `getPlatformWhatsAppSender()` returns null when it is absent
 * rather than falling back to a tenant's number. There is no fallback on
 * purpose: sending a platform alert from a merchant's number is the failure this
 * module exists to prevent, so it must never be the degraded path.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY TEMPLATES ARE REQUIRED AND NOT AN OPTIMISATION
 *
 * WhatsApp only allows free-form text within 24 hours of the recipient's last
 * message. A platform notification is business-initiated to somebody who has no
 * reason to have messaged GOTCHA, so the 24-hour window is CLOSED in the normal
 * case and a free-form send is refused by Meta.
 *
 * The existing approval sender composes free-form text and hardcodes English
 * (`"*Approval needed*"`, `"Action:"`, `"Risk:"`). So it can only work for a
 * manager who happens to have messaged that number recently, and it cannot
 * speak Hebrew at all. That is the gap these templates close.
 *
 * ── The send mechanism already exists and is NOT rebuilt here ──
 *
 * `sendTemplateMessage` is on the WhatsApp adapter
 * (`packages/shared/src/channels/whatsapp.adapter.ts:762`) and the outgoing
 * worker already calls it. This module contributes the DEFINITIONS and the
 * component builder, nothing else.
 *
 * ── These strings must match what is registered with Meta, exactly ──
 *
 * A template is approved by Meta under a name and a language, and the body is
 * fixed at approval time. `body` here is the submitted text, kept in the
 * codebase so that what we ask Meta to approve and what we believe we are
 * sending are one artifact rather than two that drift. Changing a body string
 * without re-submitting it to Meta does not change the message: it makes the
 * comment wrong.
 * ════════════════════════════════════════════════════════════════════════════
 */
// The definitions live in @chatcenter/shared (platform-templates.ts) since
// 2026-11-15, so auth's console routes read the same ones; re-exported here so
// every existing import keeps working.
import {
  TEMPLATE_LOCALES,
  PLATFORM_TEMPLATES,
  APPROVAL_REVIEW_TEMPLATE,
  VERIFICATION_TEMPLATE_NAME,
  type TemplateLocale,
  type PlatformTemplate,
} from "@chatcenter/shared";
export { TEMPLATE_LOCALES, PLATFORM_TEMPLATES, APPROVAL_REVIEW_TEMPLATE, VERIFICATION_TEMPLATE_NAME };
export type { TemplateLocale, PlatformTemplate };

/** The opt-in code (AUTHENTICATION): the code as the body parameter and as the copy-code button's. */
export function verificationComponents(code: string): any[] {
  return [
    { type: "body", parameters: [{ type: "text", text: code }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
  ];
}

const CHANNEL_NAME: Record<TemplateLocale, Record<string, string>> = {
  en: { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", FACEBOOK: "Messenger", WEBCHAT: "the website chat", SHOPIFY_LIVE_CHAT: "the store chat", EMAIL: "email", SMS: "SMS", VOICE: "a phone call" },
  he: { WHATSAPP: "וואטסאפ", INSTAGRAM: "אינסטגרם", FACEBOOK: "מסנג'ר", WEBCHAT: "צ'אט האתר", SHOPIFY_LIVE_CHAT: "צ'אט החנות", EMAIL: "מייל", SMS: "SMS", VOICE: "שיחת טלפון" },
};
const channelName = (ch: unknown, locale: TemplateLocale) =>
  CHANNEL_NAME[locale][String(ch ?? "").toUpperCase()] ?? (locale === "he" ? "אחד הערוצים" : "a channel");
const clip = (v: unknown, n = 60) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The body parameters for an event, in the recipient's language. Never the
 * customer's personal data: a channel, a number, an action's name.
 */
export function templateParams(eventType: string, data: Record<string, unknown>, locale: TemplateLocale): string[] {
  switch (eventType) {
    case "tool.approval_required": return [clip(data.toolLabel ?? data.tool, 60) || (locale === "he" ? "פעולה" : "an action")];
    case "conversation.escalated": {
      const reason = clip(data.reason, 60);
      return [`${channelName(data.channel, locale)}${reason ? `, ${reason}` : ""}`];
    }
    case "tool.action_failed": return [clip(data.toolLabel ?? data.tool ?? data.action, 60) || (locale === "he" ? "פעולה" : "an action")];
    case "credit.threshold": return [String(Math.round(Number(data.percent ?? data.threshold ?? 80)))];
    case "credit.exhausted": return [];
    case "conversation.waiting": return [String(Math.max(1, Math.round(Number(data.minutes) || 1))), channelName(data.channel, locale)];
    default: return [];
  }
}

export interface PlatformSender {
  /** The phone number id Meta sends from. */
  externalId: string;
  accessToken: string;
}

/**
 * GOTCHA's own sending number, or null when the deployment has none.
 *
 * Null is a real answer and must not be worked around. A caller that cannot get
 * a platform sender must skip WhatsApp and say so - never borrow the tenant's
 * channel, which is the failure this module exists to prevent.
 */
export function getPlatformWhatsAppSender(): PlatformSender | null {
  const externalId = (process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const accessToken = (process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN ?? "").trim();
  if (!externalId || !accessToken) return null;
  return { externalId, accessToken };
}

/** The template for an event, or null when that event has none. */
export function templateFor(eventType: string): PlatformTemplate | null {
  return PLATFORM_TEMPLATES[eventType] ?? null;
}

/**
 * Whether an event can be delivered on WhatsApp at all.
 *
 * Both halves are required: a template AND a configured platform number.
 * Reported as a reason rather than a boolean, because "we have no number yet"
 * and "this event has no template" need different sentences and neither should
 * surface as a silently missing notification.
 */
export type WhatsAppReadiness =
  | { ready: true; template: PlatformTemplate; sender: PlatformSender }
  | { ready: false; reason: "no_platform_number" | "no_template_for_event" };

export function whatsAppReadiness(eventType: string): WhatsAppReadiness {
  const template = templateFor(eventType);
  if (!template) return { ready: false, reason: "no_template_for_event" };
  const sender = getPlatformWhatsAppSender();
  if (!sender) return { ready: false, reason: "no_platform_number" };
  return { ready: true, template, sender };
}

/**
 * Build the Meta `components` array for a template's body parameters.
 *
 * Throws on the wrong number of parameters rather than sending. Meta answers a
 * parameter mismatch with a generic failure, so a caller would learn only that
 * "WhatsApp failed" - and the count is knowable here, before the request.
 */
export function buildComponents(
  template: PlatformTemplate,
  params: string[],
  buttons: { urlSuffix?: string; quickReplyPayloads?: string[] } = {},
): any[] {
  if (params.length !== template.parameterCount) {
    throw new Error(
      `template ${template.name} takes ${template.parameterCount} parameter(s), received ${params.length}`,
    );
  }
  const out: any[] = template.parameterCount === 0 ? [] : [
    {
      type: "body",
      parameters: params.map((text) => ({ type: "text", text })),
    },
  ];
  if (template.urlButton) {
    if (!buttons.urlSuffix) throw new Error(`template ${template.name} needs its URL button's suffix`);
    out.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: buttons.urlSuffix }] });
  }
  if (template.quickReplies) {
    const payloads = buttons.quickReplyPayloads ?? [];
    if (payloads.length !== template.quickReplies) throw new Error(`template ${template.name} takes ${template.quickReplies} quick-reply payload(s)`);
    payloads.forEach((payload, i) => out.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload }] }));
  }
  return out;
}

/**
 * Which language to send a person's notification in.
 *
 * Delegates to the platform's ONE system-language resolver rather than reading
 * either column: a notification is addressed to a PERSON, so their own override
 * wins over the tenant default. `coerceLocale` collapses anything outside
 * `en`/`he`, so the returned value is always a language a template exists in.
 */
export async function localeForRecipient(tenantId: string, userId: string | null): Promise<TemplateLocale> {
  try {
    const { resolveEffectiveLocale } = await import("@chatcenter/shared");
    const resolved = await resolveEffectiveLocale({ tenantId, userId: userId ?? undefined });
    return resolved.effective === "he" ? "he" : "en";
  } catch (err: any) {
    // A locale lookup failure must not stop a notification. English is the
    // platform fallback the resolver itself uses.
    console.warn(`[platform-whatsapp] locale lookup failed for ${tenantId}: ${err?.message}`);
    return "en";
  }
}
