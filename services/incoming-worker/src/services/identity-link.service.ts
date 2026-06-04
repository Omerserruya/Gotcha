/**
 * Identifier extraction + identity-link helper for the incoming-worker.
 *
 * Used by:
 *   - `flow-executor.service.ts` — when a Collect Input captures a value
 *   - `incoming.worker.ts` — universal hook on every persisted INBOUND
 *     message so the same logic fires for chats handled by a human agent
 *     (co-pilot mode) where the bot/flow doesn't run
 *
 * Detection uses `libphonenumber-js` with the tenant's `defaultCountryCode`
 * so locals like "0525401686" (Israeli mobile, no `+`) normalize to E.164
 * and resolve to the existing CRM Contact / Lead.
 *
 * The link itself is a thin POST to `/api/identity/link` on the conversation
 * service — that endpoint owns idempotency (messageId + identifier), rate
 * limits, and the "suggest vs. attach" decision when the identifier
 * already belongs to another contact in the same tenant.
 */

import { prisma } from "@chatcenter/shared";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";

export function detectIdentifier(
  text: string,
  defaultCountry: string = "IL",
): { type: "email" | "phone"; value: string } | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const m = trimmed.match(emailRe);
  if (m) return { type: "email", value: m[0].toLowerCase() };
  const phoneCandidateRe = /(\+?\d[\d\s().-]{6,}\d)/g;
  for (const match of trimmed.matchAll(phoneCandidateRe)) {
    const raw = match[1];
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    if (digits.length < 8 && !raw.includes("+") && !raw.includes("-") && !raw.includes(" ") && !raw.includes("(")) continue;
    try {
      const parsed = parsePhoneNumberFromString(raw, (defaultCountry || "IL").toUpperCase() as CountryCode);
      if (parsed && parsed.isValid()) return { type: "phone", value: parsed.number };
    } catch { /* try next candidate */ }
  }
  return null;
}

async function callAutoLinkIdentifier(
  body: {
    tenantId: string;
    conversationId: string;
    identifier?: { type: "email" | "phone"; value: string } | null;
  },
): Promise<{ ok: boolean; status?: number; data?: any; error?: string }> {
  const url = `${AI_SERVICE_URL.replace(/\/$/, "")}/api/crm/auto-link-identifier`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: (data as any)?.error || `upstream ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "fetch failed" };
  }
}

/**
 * Universal entry. Given an inbound message text + conversation context,
 * detects any email/phone identifier and POSTs it to /api/identity/link.
 * Failures are swallowed (logged) so callers can `void` this.
 */
export async function tryLinkIdentifierFromInbound(args: {
  tenantId: string;
  conversationId: string;
  text: string;
  messageId?: string | null;
  reason?: string;
}): Promise<{
  linked: boolean;
  identifier?: { type: "email" | "phone"; value: string };
  outcome?: string;
  crmContactId?: string | null;
  crmObjectKind?: string | null;
  reason?: string;
}> {
  const log = (msg: string) => console.log(`[identity-link] conv=${args.conversationId} ${msg}`);
  try {
    if (!args.text || !args.text.trim()) { log("skip: empty body"); return { linked: false, reason: "empty" }; }
    const tenant = await prisma.tenant.findUnique({
      where: { id: args.tenantId },
      select: { defaultCountryCode: true },
    });
    const defaultCountry = tenant?.defaultCountryCode || "IL";
    const id = detectIdentifier(args.text, defaultCountry);

    // For phone-derived channels (WhatsApp / SMS / voice) the conversation's
    // customerExternalId IS the customer's phone. Trigger auto-link even
    // when the body has no identifier — `linkOrCreateCrmContact` has a
    // fall-through that uses the channel external_id as the phone hint.
    const conversation = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { channel: true },
    });
    const channelLower = (conversation?.channel || "").toLowerCase();
    const phoneDerivedChannel = channelLower === "whatsapp" || channelLower === "sms" || channelLower === "voice";

    if (!id && !phoneDerivedChannel) {
      log(`skip: no-identifier (body=${args.text.slice(0, 60)}, country=${defaultCountry})`);
      return { linked: false, reason: "no-identifier" };
    }
    if (id) {
      log(`detected ${id.type}=${id.value}; calling AI service auto-link`);
    } else {
      log(`phone-derived channel (${channelLower}); calling AI service auto-link with channel-id fall-through`);
    }

    const r = await callAutoLinkIdentifier({
      tenantId: args.tenantId,
      conversationId: args.conversationId,
      identifier: id,
    });
    if (!r.ok) {
      console.warn(`[identity-link] conv=${args.conversationId} auto-link request failed: ${r.error}`);
      return { linked: false, identifier: id ?? undefined, reason: r.error };
    }
    const out = r.data as {
      ok?: boolean;
      outcome?: string;
      crmContactId?: string | null;
      crmObjectKind?: string | null;
      vendor?: string;
      reason?: string;
      candidates?: Array<{ id: string; kind: string }>;
    };
    if (out?.ok && (out.outcome === "linked" || out.outcome === "merged" || out.outcome === "created")) {
      log(`OK ${id?.type}=${id?.value} → ${out.outcome} crmContactId=${out.crmContactId} kind=${out.crmObjectKind} vendor=${out.vendor}`);
      return {
        linked: true,
        identifier: id ?? undefined,
        outcome: out.outcome,
        crmContactId: out.crmContactId ?? null,
        crmObjectKind: out.crmObjectKind ?? null,
      };
    }
    log(`no-link outcome=${out?.outcome ?? "unknown"} reason=${out?.reason ?? ""}`);
    return { linked: false, identifier: id ?? undefined, outcome: out?.outcome, reason: out?.reason };
  } catch (err: any) {
    console.warn(`[identity-link] conv=${args.conversationId} threw:`, err?.message);
    return { linked: false, reason: err?.message };
  }
}
