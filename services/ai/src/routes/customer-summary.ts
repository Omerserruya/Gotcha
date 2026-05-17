/**
 * AI-generated customer brief.
 *
 * Persistent, customer-level behavioral intelligence — not a per-conversation
 * summary. The brief is written by the post-chat subscriber + voice-postcall
 * worker at conversation close, and lives in `customer_briefs`. This route
 * just READS the persisted row (fast) and falls back to inline generation
 * only when the brief doesn't exist yet OR the caller forced a refresh.
 *
 * The on-demand LRU cache that used to live here is gone — the database row
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
    const tenantId = (body.tenantId as string) || req.tenantId || "";
    const conversationId = body.conversationId as string;
    const localeRaw = typeof body.locale === "string" ? body.locale.toLowerCase().slice(0, 8) : "";
    const locale = localeRaw || "en";
    const forceRefresh = !!body.refresh;
    if (!tenantId || !conversationId) {
      res.status(400).json({ error: "tenantId and conversationId required" });
      return;
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
    const contact = await (prisma as any).contact.findFirst({
      where: { tenantId, channel: conv.channel, externalId: conv.customerExternalId },
      select: { id: true, personId: true, metadata: true },
    });
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
        `— generating inline (one-time; subsequent panel opens will hit cache, worker events refresh it on close/hangup)`,
      );
    }

    // Miss / forced refresh: generate inline. Hooks already fire on close,
    // so this path mostly serves brand-new customers (first open before any
    // conversation has closed).
    const identityKey = deriveIdentityKey(hints);
    if (!identityKey) {
      // No identity anchor at all — we can't persist. Return a neutral
      // briefing so the panel still renders.
      const payload: CustomerSummaryPayload = {
        ok: true,
        summary: locale === "he"
          ? "לקוח חדש — אין אינטראקציות קודמות מתועדות."
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
          ? "לקוח חדש — אין אינטראקציות קודמות מתועדות."
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
