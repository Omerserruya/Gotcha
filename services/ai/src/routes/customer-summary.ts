/**
 * AI-generated customer brief.
 *
 * Persistent, customer-level behavioral intelligence - not a per-conversation
 * summary. The brief is written by the post-chat subscriber + voice-postcall
 * worker at conversation close, and lives in `customer_briefs`. This route
 * just READS the persisted row (fast) and falls back to inline generation
 * only when the brief doesn't exist yet OR the caller forced a refresh.
 *
 * The on-demand LRU cache that used to live here is gone - the database row
 * is the cache. Conversation close events keep it fresh.
 */

import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant, prisma } from "@chatcenter/shared";
import {
  getCustomerBrief,
  refreshCustomerBriefFromConversation,
  deriveIdentityKey,
} from "../services/customer-brief.service";

const router = Router();

/**
 * The person's most recent conversation, for a caller holding a Contact id.
 *
 * Returns "not_found" for an unknown contact, null for a real contact who has
 * simply never had a conversation, and an id otherwise - three outcomes the
 * caller must tell apart, because two of them are normal and one is a mistake.
 *
 * ★ NAMES ORIGIN. `applyLiveByDefault` injects `origin: "LIVE"` into bulk
 * Conversation reads, so a customer whose history was imported and who has no
 * live conversation yet would resolve to null - reported as "no prior
 * interactions" about someone with years of them.
 */
async function conversationForContact(tenantId: string, contactId: string): Promise<string | null | "not_found"> {
  const contact = await (prisma as any).contact.findFirst({ where: { id: contactId, tenantId } });
  if (!contact) return "not_found";

  // Follow the soft-merge pointer: a merged-away contact is still a valid
  // entry point and must resolve to the surviving person's history.
  const effective = contact.mergedIntoId
    ? await (prisma as any).contact.findFirst({ where: { id: contact.mergedIntoId, tenantId } })
    : contact;
  if (!effective) return "not_found";

  const { findSiblingContacts } = await import("@chatcenter/shared");
  const siblings = await findSiblingContacts(tenantId, effective);
  const meta = (effective.metadata as Record<string, unknown>) || {};
  const aliases = Array.isArray((meta as any).aliases)
    ? ((meta as any).aliases as Array<{ channel: string; externalId: string }>)
    : [];
  const orClauses = [
    ...siblings.map((s: any) => ({ channel: s.channel, customerExternalId: s.externalId })),
    ...aliases.map((a) => ({ channel: a.channel as any, customerExternalId: a.externalId })),
  ];
  if (orClauses.length === 0) return null;

  const conv = await prisma.conversation.findFirst({
    where: { tenantId, OR: orClauses, origin: { in: ["LIVE", "HISTORICAL_IMPORT"] } as any },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return conv?.id ?? null;
}

interface CustomerSummaryPayload {
  ok: boolean;
  summary: string;
  signals: string[];
  generated_at: string;
  cached: boolean;
  meta: Record<string, unknown>;
}

router.post("/", authenticate, resolveTenant, requireActiveTenant(), async (req: Request & { tenantId?: string }, res: Response) => {
  try {
    const body = req.body ?? {};
    // Tenant is ALWAYS the authenticated JWT tenant (resolveTenant), never a
    // client-supplied body field. Trusting body.tenantId here would let a user
    // in tenant A read tenant B's customer brief by naming B's conversation id.
    const tenantId = req.tenantId || "";
    const localeRaw = typeof body.locale === "string" ? body.locale.toLowerCase().slice(0, 8) : "";
    const locale = localeRaw || "en";
    const forceRefresh = !!body.refresh;

    // ── Entering by CONTACT as well as by conversation ──
    //
    // The brief already summarises everything: `refreshCustomerBriefFromConversation`
    // loads the cross-channel bundle, so `refresh: true` has always been the
    // "summarise all of it" button. It was only reachable from a conversation
    // id, and a customer screen holds a Contact id - so the capability existed
    // in an id space its caller could not get to.
    //
    // This resolves a contact to the person's most recent conversation and
    // delegates. It does NOT add a second summariser: one brief, one writer.
    let conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const contactId = typeof body.contactId === "string" ? body.contactId : "";
    if (!tenantId || (!conversationId && !contactId)) {
      res.status(400).json({ error: "conversationId or contactId required" });
      return;
    }

    if (!conversationId && contactId) {
      const resolved = await conversationForContact(tenantId, contactId);
      if (resolved === "not_found") {
        res.status(404).json({ error: "contact_not_found" });
        return;
      }
      if (!resolved) {
        // A contact with no conversations is a real, ordinary state - not an
        // error and not an empty brief pretending to be one.
        res.json({
          ok: true,
          summary: locale === "he"
            ? "לקוח חדש - אין אינטראקציות קודמות מתועדות."
            : "New customer with no recorded prior interactions.",
          signals: [],
          generated_at: new Date().toISOString(),
          cached: false,
          meta: { conversation_count: 0, crm_linked: false, person_linked: false, reason: "no_conversations" },
        });
        return;
      }
      conversationId = resolved;
    }

    // Resolve identity hints from the conversation so we can look up the
    // persisted brief without rebuilding the cross-channel bundle on every
    // panel open.
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channel: true, customerExternalId: true, tenantId: true },
    });
    if (!conv || conv.tenantId !== tenantId) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }
    // Try the exact (channel, externalId) tuple first - the fast path that
    // works when the contact was first ingested on the same channel as this
    // conversation. For voice calls that miss (the contact was usually
    // created earlier on WhatsApp / SMS / etc.), fall back to a phone-column
    // lookup so the brief resolves the same human across channels.
    let contact = await (prisma as any).contact.findFirst({
      where: { tenantId, channel: conv.channel, externalId: conv.customerExternalId },
      select: { id: true, personId: true, metadata: true },
    });
    if (!contact && conv.customerExternalId) {
      const normalized = conv.customerExternalId.replace(/[\s-]/g, "");
      if (/^\+?\d{6,}$/.test(normalized)) {
        const candidates = Array.from(new Set([
          conv.customerExternalId,
          normalized,
          normalized.startsWith("+") ? normalized.slice(1) : `+${normalized}`,
        ]));
        contact = await (prisma as any).contact.findFirst({
          where: { tenantId, mergedIntoId: null, phone: { in: candidates } },
          select: { id: true, personId: true, metadata: true },
        });
      }
    }
    const meta = (contact?.metadata ?? {}) as Record<string, any>;
    const hints = {
      personId: contact?.personId ?? null,
      crmContactId: (meta?.crmContactId as string | undefined) ?? null,
      crmVendor: (meta?.crmVendor as string | undefined) ?? null,
      contactId: contact?.id ?? null,
    };

    // Fast path: persisted brief exists and caller didn't force refresh.
    if (!forceRefresh) {
      const existing = await getCustomerBrief({ tenantId, hints, locale });
      if (existing) {
        console.log(
          `[customer-summary] cache HIT conv=${conversationId} identity=${existing.identityKey} locale=${locale} ` +
          `generatedAt=${existing.generatedAt} convCount=${existing.conversationCount}`,
        );
        const payload: CustomerSummaryPayload = {
          ok: true,
          summary: existing.brief,
          signals: existing.signals,
          generated_at: existing.generatedAt,
          cached: true,
          meta: {
            conversation_count: existing.conversationCount,
            channels: existing.channels,
            tone: existing.tone,
            mood: existing.mood,
            recommended_behaviors: existing.recommendedBehaviors,
            last_source_channel: existing.lastSourceChannel,
            last_source_conv_id: existing.lastSourceConvId,
            crm_linked: existing.meta.crm_linked,
            person_linked: existing.meta.person_linked,
            identity_key: existing.identityKey,
          },
        };
        res.json(payload);
        return;
      }
      console.log(
        `[customer-summary] cache MISS conv=${conversationId} locale=${locale} ` +
        `personId=${hints.personId ?? "-"} crm=${hints.crmContactId ?? "-"} contactId=${hints.contactId ?? "-"} ` +
        `- generating inline (one-time; subsequent panel opens will hit cache, worker events refresh it on close/hangup)`,
      );
    }

    // Miss / forced refresh: generate inline. Hooks already fire on close,
    // so this path mostly serves brand-new customers (first open before any
    // conversation has closed).
    const identityKey = deriveIdentityKey(hints);
    if (!identityKey) {
      // No identity anchor at all - we can't persist. Return a neutral
      // briefing so the panel still renders.
      const payload: CustomerSummaryPayload = {
        ok: true,
        summary: locale === "he"
          ? "לקוח חדש - אין אינטראקציות קודמות מתועדות."
          : "New customer with no recorded prior interactions.",
        signals: [],
        generated_at: new Date().toISOString(),
        cached: false,
        meta: { conversation_count: 0, crm_linked: false, person_linked: false },
      };
      res.json(payload);
      return;
    }

    const rec = await refreshCustomerBriefFromConversation({
      tenantId,
      conversationId,
      locale,
      sourceEvent: "panel.fetch",
    });

    if (!rec) {
      const payload: CustomerSummaryPayload = {
        ok: true,
        summary: locale === "he"
          ? "לקוח חדש - אין אינטראקציות קודמות מתועדות."
          : "New customer with no recorded prior interactions.",
        signals: [],
        generated_at: new Date().toISOString(),
        cached: false,
        meta: { conversation_count: 0, crm_linked: false, person_linked: false },
      };
      res.json(payload);
      return;
    }

    const payload: CustomerSummaryPayload = {
      ok: true,
      summary: rec.brief,
      signals: rec.signals,
      generated_at: rec.generatedAt,
      cached: false,
      meta: {
        conversation_count: rec.conversationCount,
        channels: rec.channels,
        tone: rec.tone,
        mood: rec.mood,
        recommended_behaviors: rec.recommendedBehaviors,
        last_source_channel: rec.lastSourceChannel,
        last_source_conv_id: rec.lastSourceConvId,
        crm_linked: rec.meta.crm_linked,
        person_linked: rec.meta.person_linked,
        identity_key: rec.identityKey,
      },
    };
    res.json(payload);
  } catch (err: any) {
    console.error("[customer-summary] error:", err?.message);
    res.status(500).json({ error: err?.message ?? "internal error" });
  }
});

export default router;
