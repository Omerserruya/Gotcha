/**
 * Internal endpoint: auto-link an inbound message's extracted identifier to
 * an existing CRM Lead/Contact.
 *
 * Triggered by the incoming-worker every time a customer's text/IG/WA
 * message includes a phone or email. The flow is:
 *
 *   1. Load the conversation (channel + customerExternalId — the platform
 *      identity, e.g. an Instagram PSID).
 *   2. Build IdentityHints combining the platform identity (as a channel
 *      hint) with the extracted phone/email.
 *   3. Call `linkOrCreateCrmContact` in `search_only` mode — finds an
 *      existing Lead/Contact in the tenant's CRM matching the phone/email
 *      or any of the gotcha_psid_* custom fields. Never creates a new
 *      record automatically; new-lead creation stays a human decision.
 *   4. On `linked` outcome, persist `crmContactId` + `crmObjectKind` on
 *      the local Contact pointer (upserts if missing) so downstream
 *      features (co-pilot context, post-conversation summarizer, etc.)
 *      see the bridge.
 *
 * Auth: X-Internal-Key shared secret (same as /api/ai-bot/*).
 */

import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@chatcenter/shared";
import { getCrmAdapter } from "../services/connectors/crm-adapter-resolver";
import {
  linkOrCreateCrmContact,
  type IdentityHints,
  type StrongChannel,
} from "../services/connectors/crm-identity.service";

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  const key = req.headers["x-internal-key"];
  if (!key || key !== (process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
});

function channelToStrong(channel: string | null | undefined): StrongChannel | null {
  const c = (channel || "").toLowerCase();
  switch (c) {
    case "whatsapp":  return "whatsapp";
    case "instagram": return "instagram";
    case "facebook":
    case "messenger": return "messenger";
    case "webchat":   return "webchat";
    case "voice":
    case "phone":     return "voice";
    case "sms":       return "sms";
    case "email":     return "email";
    default: return null;
  }
}

// POST /api/crm/resolve-identifiers
//   body: { tenantId, conversationId }
//   returns: { ok, phone?, email?, channelExternalIds: Record<channel, string>,
//              crmContactId?, crmObjectKind?, vendor? }
//
// Used by the conversation service's cross-platform History walk: the CRM is
// the source of truth for every identifier a person carries (phone, email,
// gotcha_psid_*, etc.). Returning them all lets the walk find conversations
// across every channel without depending on the sparse local Contact table.
router.post("/resolve-identifiers", async (req: Request, res: Response) => {
  try {
    const { tenantId, conversationId } = req.body ?? {};
    if (!tenantId || !conversationId) {
      res.status(400).json({ error: "tenantId, conversationId required" });
      return;
    }

    // Find the linked CRM record via the local Contact pointer.
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { channel: true, customerExternalId: true },
    });
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    const localContact = await prisma.contact.findFirst({
      where: { tenantId, channel: conversation.channel, externalId: conversation.customerExternalId },
      select: { metadata: true, phone: true, email: true },
    });
    const meta = (localContact?.metadata as Record<string, unknown> | null) ?? {};
    const crmContactId = typeof meta.crmContactId === "string" ? meta.crmContactId : null;
    const crmObjectKind = meta.crmObjectKind === "lead" || meta.crmObjectKind === "contact"
      ? meta.crmObjectKind
      : null;
    if (!crmContactId || !crmObjectKind) {
      // No CRM link — still surface local phone/email so the History walk
      // can do best-effort identifier matching off the platform contact.
      res.json({
        ok: false,
        reason: "no-crm-link",
        phone: localContact?.phone ?? null,
        email: localContact?.email ?? null,
        channelExternalIds: {},
      });
      return;
    }

    const adapter = await getCrmAdapter(tenantId);
    if (adapter.capabilities.is_stub) {
      res.json({ ok: false, reason: "no-crm-adapter", phone: null, email: null, channelExternalIds: {} });
      return;
    }
    const ctx = await adapter.getCustomerContext({ contact_id: crmContactId, kind: crmObjectKind });
    if (!ctx.ok || !ctx.context) {
      res.json({
        ok: false,
        reason: ctx.reason ?? "crm-context-failed",
        crmContactId,
        crmObjectKind,
        vendor: adapter.vendor,
        phone: null,
        email: null,
        channelExternalIds: {},
      });
      return;
    }
    const contact = ctx.context.contact;
    // Map well-known channel custom fields back to canonical channel names.
    const cf = (contact.custom_fields ?? {}) as Record<string, unknown>;
    const channelExternalIds: Record<string, string> = {};
    const channelPlan: Array<[string, string]> = [
      ["instagram", "gotcha_psid_instagram"],
      ["messenger", "gotcha_psid_facebook"],
      ["whatsapp",  "gotcha_wa_id"],
      ["webchat",   "gotcha_webchat_id"],
      ["sms",       "gotcha_sms_id"],
      ["voice",     "gotcha_voice_id"],
      ["email",     "gotcha_email_id"],
    ];
    for (const [channel, key] of channelPlan) {
      const v = cf[key];
      if (typeof v === "string" && v.trim()) channelExternalIds[channel] = v.trim();
    }

    res.json({
      ok: true,
      crmContactId,
      crmObjectKind,
      vendor: adapter.vendor,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      channelExternalIds,
    });
  } catch (err: any) {
    console.error("[crm-resolve-identifiers] error:", err?.message);
    res.status(500).json({ error: err?.message ?? "internal error" });
  }
});

// POST /api/crm/auto-link-identifier
//   body: { tenantId, conversationId, identifier: { type: "email"|"phone", value: string } }
//   returns: { ok, outcome: "linked"|"created"|"needs_approval"|"not_found"|"error",
//              crmContactId?, crmObjectKind?, candidates?, reason? }
router.post("/auto-link-identifier", async (req: Request, res: Response) => {
  try {
    const { tenantId, conversationId, identifier } = req.body ?? {};
    if (!tenantId || !conversationId) {
      res.status(400).json({ error: "tenantId, conversationId required" });
      return;
    }
    // identifier is OPTIONAL — for phone-derived channels (WA/SMS/voice) the
    // conversation's customerExternalId IS the phone, and
    // linkOrCreateCrmContact's channels[] fall-through picks it up.
    if (identifier && identifier.type !== "email" && identifier.type !== "phone") {
      res.status(400).json({ error: "identifier.type must be 'email' or 'phone'" });
      return;
    }
    if (identifier && (!identifier.value || typeof identifier.value !== "string")) {
      res.status(400).json({ error: "identifier.value required" });
      return;
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { channel: true, customerExternalId: true, customerName: true },
    });
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultCountryCode: true },
    });

    const strongChannel = channelToStrong(conversation.channel);
    const hints: IdentityHints = {
      email: identifier?.type === "email" ? identifier.value : null,
      phone: identifier?.type === "phone" ? identifier.value : null,
      display_name: conversation.customerName || null,
      default_region: tenant?.defaultCountryCode || "IL",
      channels: strongChannel
        ? [{
            channel: strongChannel,
            external_id: conversation.customerExternalId,
            display_name: conversation.customerName || null,
          }]
        : [],
    };
    // Hint guard — if neither identifier NOR a strong channel external_id is
    // available, linkOrCreateCrmContact would refuse with "no_identifiers".
    // Bail early with a clear reason so the caller can see why we skipped.
    if (!hints.email && !hints.phone && hints.channels.length === 0) {
      res.json({ ok: false, outcome: "no_identifiers", reason: "nothing-to-search-by" });
      return;
    }

    const adapter = await getCrmAdapter(tenantId);
    if (adapter.capabilities.is_stub) {
      res.json({ ok: false, outcome: "not_configured", reason: "no CRM adapter configured" });
      return;
    }

    const outcome = await linkOrCreateCrmContact({ adapter, hints, mode: "search_only" });

    // Persist the bridge on the local Contact pointer when we matched a CRM
    // record. The local row is upsert-by-(tenant, channel, externalId) so
    // each conversation channel gets exactly one pointer row.
    if (outcome.status === "linked" || outcome.status === "merged" || outcome.status === "created") {
      const crmContactId = outcome.contact.id;
      const crmObjectKind = outcome.contact.kind;
      const existing = await prisma.contact.findFirst({
        where: {
          tenantId,
          channel: conversation.channel,
          externalId: conversation.customerExternalId,
        },
        select: { id: true, metadata: true, phone: true, email: true, displayName: true },
      });
      const mergedMeta = {
        ...((existing?.metadata as any) ?? {}),
        crmContactId,
        crmObjectKind,
      };
      // Pull phone/email/display_name from the CRM record onto the local
      // pointer. This is what lets cross-channel history join work: the
      // History walk OR's on phone= / email= across all local Contacts,
      // so an IG-linked record now shares phone with the WA-linked one.
      // Only WRITES when the local field is empty — never overwrites a
      // value the user/tenant set manually.
      const crmPhone = outcome.contact.phone ?? null;
      const crmEmail = outcome.contact.email ?? null;
      const crmName = outcome.contact.display_name ?? null;
      const dataPatch: Record<string, unknown> = { metadata: mergedMeta };
      if (!existing?.phone && crmPhone) dataPatch.phone = crmPhone;
      if (!existing?.email && crmEmail) dataPatch.email = crmEmail;
      if (!existing?.displayName && crmName) dataPatch.displayName = crmName;
      if (existing) {
        await prisma.contact.update({
          where: { id: existing.id },
          data: dataPatch as any,
        });
      } else {
        await prisma.contact.create({
          data: {
            tenantId,
            channel: conversation.channel,
            externalId: conversation.customerExternalId,
            displayName: conversation.customerName ?? crmName,
            phone: crmPhone,
            email: crmEmail,
            metadata: mergedMeta as any,
          } as any,
        });
      }
      res.json({
        ok: true,
        outcome: outcome.status,
        crmContactId,
        crmObjectKind,
        vendor: adapter.vendor,
        wrote: { phone: !!crmPhone, email: !!crmEmail },
      });
      return;
    }

    if (outcome.status === "needs_approval") {
      res.json({
        ok: false,
        outcome: outcome.status,
        candidates: outcome.candidates.map((c) => ({ id: c.id, kind: c.kind })),
        reason: outcome.reason,
      });
      return;
    }
    if (outcome.status === "not_found" || outcome.status === "error") {
      res.json({ ok: false, outcome: outcome.status, reason: outcome.reason });
      return;
    }
    res.json({ ok: false, outcome: (outcome as any).status });
  } catch (err: any) {
    console.error("[crm-auto-link] error:", err?.message);
    res.status(500).json({ error: err?.message ?? "internal error" });
  }
});

export default router;
