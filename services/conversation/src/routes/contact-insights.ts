/**
 * Customers list (04) - what the list shows beside a name, and bulk tagging.
 *
 *   GET  /api/contacts/insights?ids=a,b,c   (<=100)
 *        -> { data: { [contactId]: { situation, messageCount, inboundCount,
 *                                    mood, conversationId } | null } }
 *   POST /api/contacts/tags  { contactIds, add?, remove? }
 *        -> { data: { [contactId]: string[] } }   the tags after the change
 *
 * Mounted BEFORE the contacts router so its "/:id" route cannot shadow
 * "/insights".
 *
 * situation: the AI's summary of the customer's latest open conversation
 *   (ConversationIntelligence.summary), first sentence, capped. Null when that
 *   conversation was never analysed - the list must not invent a story.
 * mood: closed list, from the SAME definitions the queue ranker uses
 *   (isFrustrated / normalizeConversationIntent): "frustrated" | "about_to_buy"
 *   | null.
 * Tags: the exact-match semantics the audience filter matches on (48d96396):
 *   trimmed, inner whitespace collapsed, case kept, 1-40 characters, at most
 *   50 per contact. "vip" and "VIP" are two tags, as decided.
 */
import { Router, Request, Response } from "express";
import {
  prisma,
  emitTagsAdded,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
  isFrustrated,
  normalizeConversationIntent,
} from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

const MAX_IDS = 100;
const MAX_TAG_LENGTH = 40;
const MAX_TAGS_PER_CONTACT = 50;

export type Mood = "frustrated" | "about_to_buy" | null;

export function moodOf(intel: { detectedIntent?: string | null; sentiment?: string | null; sentimentScore?: number | null; customerEffort?: number | null } | null): Mood {
  if (!intel) return null;
  const signals = { sentiment: intel.sentiment, sentimentScore: intel.sentimentScore, customerEffort: intel.customerEffort };
  if (isFrustrated(intel.detectedIntent, signals)) return "frustrated";
  return normalizeConversationIntent(intel.detectedIntent, signals) === "HIGH_INTENT" ? "about_to_buy" : null;
}

import { situationOf } from "../lib/situation";
// Re-exported: existing callers and tests import it from here.
export { situationOf };

export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length >= 1 && t.length <= MAX_TAG_LENGTH ? t : null;
}

const idsFrom = (raw: unknown) => [...new Set(String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];

router.get("/insights", requirePermissionOrRole("crm:contacts:read", "ADMIN"), async (req: Request, res: Response) => {
  const ids = idsFrom(req.query.ids);
  if (ids.length === 0) { res.status(400).json({ error: "ids_required" }); return; }
  if (ids.length > MAX_IDS) { res.status(400).json({ error: "too_many_ids", max: MAX_IDS }); return; }
  const tenantId = req.tenantId!;
  try {
    const contacts = await prisma.contact.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, externalId: true, channel: true },
    });
    const data: Record<string, unknown> = {};
    for (const c of contacts) {
      // The customer's latest conversation that is still going.
      const conv = await prisma.conversation.findFirst({
        where: { tenantId, channel: c.channel as any, customerExternalId: c.externalId, status: { not: "CLOSED" } },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true },
      });
      if (!conv) { data[c.id] = null; continue; }
      const [intel, messageCount, inboundCount] = await Promise.all([
        prisma.conversationIntelligence.findFirst({
          where: { tenantId, conversationId: conv.id },
          select: { summary: true, detectedIntent: true, sentiment: true, sentimentScore: true, customerEffort: true },
        }),
        prisma.message.count({ where: { tenantId, conversationId: conv.id, messageType: { not: "system" } } }),
        prisma.message.count({ where: { tenantId, conversationId: conv.id, direction: "INBOUND", messageType: { not: "system" } } }),
      ]);
      data[c.id] = {
        conversationId: conv.id,
        situation: situationOf(intel?.summary),
        messageCount,
        inboundCount,
        mood: moodOf(intel),
      };
    }
    res.json({ data });
  } catch (err: any) {
    console.error("[contact-insights] insights failed:", err?.message);
    res.status(500).json({ error: "insights_failed" });
  }
});

router.post("/tags", requirePermissionOrRole("crm:contacts:update", "ADMIN"), async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const ids: string[] = Array.isArray(body.contactIds) ? [...new Set<string>(body.contactIds.map(String))] : [];
  if (ids.length === 0) { res.status(400).json({ error: "contactIds_required" }); return; }
  if (ids.length > MAX_IDS) { res.status(400).json({ error: "too_many_ids", max: MAX_IDS }); return; }
  const rawAdd = Array.isArray(body.add) ? body.add : [];
  const rawRemove = Array.isArray(body.remove) ? body.remove : [];
  if (rawAdd.length === 0 && rawRemove.length === 0) { res.status(400).json({ error: "nothing_to_change" }); return; }
  const add = rawAdd.map(normalizeTag);
  const remove = rawRemove.map(normalizeTag);
  if ([...add, ...remove].some((t) => t === null)) {
    res.status(400).json({ error: "invalid_tag", message: `A tag is 1-${MAX_TAG_LENGTH} characters of text.` });
    return;
  }
  const tenantId = req.tenantId!;
  try {
    const contacts = await prisma.contact.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, tags: true } });
    if (contacts.length !== ids.length) { res.status(404).json({ error: "contact_not_found" }); return; }
    const next = new Map<string, string[]>();
    const before = new Map(contacts.map((c) => [c.id, c.tags]));
    for (const c of contacts) {
      const current = Array.isArray(c.tags) ? (c.tags as unknown[]).map(String) : [];
      const after = [...new Set([...current.filter((t) => !remove.includes(t)), ...(add as string[])])];
      if (after.length > MAX_TAGS_PER_CONTACT) {
        res.status(400).json({ error: "too_many_tags", max: MAX_TAGS_PER_CONTACT, contactId: c.id });
        return;
      }
      next.set(c.id, after);
    }
    // All or nothing: a bulk tag that half-applied would leave the selection
    // in a state nobody chose.
    await prisma.$transaction(
      [...next].map(([id, tags]) => prisma.contact.updateMany({ where: { id, tenantId }, data: { tags } })),
    );
    // Tag-added automations, once the write is in.
    for (const [id, tags] of next) await emitTagsAdded(tenantId, id, before.get(id), tags);
    res.json({ data: Object.fromEntries(next) });
  } catch (err: any) {
    console.error("[contact-insights] tags failed:", err?.message);
    res.status(500).json({ error: "tags_failed" });
  }
});

export default router;
