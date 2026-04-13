import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

// POST /resolve - find existing contact by email/phone or heuristic metadata match
router.post("/resolve", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { email, phone, metadata, channel, externalId, displayName } = req.body ?? {};

    if (!email && !phone && !externalId && !(metadata && Object.keys(metadata).length)) {
      return res.status(400).json({ error: "At least one of email, phone, externalId, or metadata is required" });
    }

    // Strict match: email or phone
    const orClauses: any[] = [];
    if (email) orClauses.push({ email });
    if (phone) orClauses.push({ phone });
    if (externalId && channel) orClauses.push({ channel, externalId });

    let contact = orClauses.length
      ? await prisma.contact.findFirst({ where: { tenantId, OR: orClauses } })
      : null;

    // Heuristic match: metadata keys overlap
    if (!contact && metadata && typeof metadata === "object") {
      const candidates = await prisma.contact.findMany({
        where: { tenantId, metadata: { not: null as any } },
        take: 50,
        orderBy: { lastInteractionAt: "desc" },
      });
      contact =
        candidates.find((c) => {
          const m = (c.metadata as Record<string, unknown>) || {};
          return Object.entries(metadata as Record<string, unknown>).some(
            ([k, v]) => m[k] !== undefined && m[k] === v,
          );
        }) || null;
    }

    if (!contact) {
      if (!channel || !externalId) {
        return res.json({ matched: false, contact: null });
      }
      contact = await prisma.contact.create({
        data: {
          tenantId,
          channel,
          externalId,
          email: email ?? null,
          phone: phone ?? null,
          displayName: displayName ?? null,
          metadata: metadata ?? undefined,
        },
      });
      return res.json({ matched: false, created: true, contact });
    }

    return res.json({ matched: true, contact });
  } catch (err) {
    console.error("identity.resolve error:", err);
    return res.status(500).json({ error: "Failed to resolve identity" });
  }
});

// POST /merge - merge source contact into target contact
router.post("/merge", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { targetId, sourceId } = req.body ?? {};
    if (!targetId || !sourceId || targetId === sourceId) {
      return res.status(400).json({ error: "targetId and sourceId required and must differ" });
    }

    const [target, source] = await Promise.all([
      prisma.contact.findFirst({ where: { id: targetId, tenantId } }),
      prisma.contact.findFirst({ where: { id: sourceId, tenantId } }),
    ]);
    if (!target || !source) return res.status(404).json({ error: "Contact not found" });

    const targetMeta = (target.metadata as Record<string, unknown>) || {};
    const sourceMeta = (source.metadata as Record<string, unknown>) || {};
    // Preserve source (channel, externalId) so timeline can still find its
    // conversations after the source contact row is deleted.
    const existingAliases = Array.isArray((targetMeta as any).aliases)
      ? ((targetMeta as any).aliases as Array<{ channel: string; externalId: string }>)
      : [];
    const sourceAliases = Array.isArray((sourceMeta as any).aliases)
      ? ((sourceMeta as any).aliases as Array<{ channel: string; externalId: string }>)
      : [];
    const mergedAliases = [
      ...existingAliases,
      ...sourceAliases,
      { channel: source.channel as string, externalId: source.externalId },
    ].filter(
      (a, i, arr) =>
        arr.findIndex((x) => x.channel === a.channel && x.externalId === a.externalId) === i,
    );
    const mergedMetadata = {
      ...sourceMeta,
      ...targetMeta,
      aliases: mergedAliases,
    };
    const mergedTags = Array.from(
      new Set([
        ...((target.tags as string[]) || []),
        ...((source.tags as string[]) || []),
      ]),
    );

    const result = await prisma.$transaction(async (tx) => {
      await tx.broadcastRecipient.updateMany({
        where: { contactId: sourceId },
        data: { contactId: targetId },
      });
      const updated = await tx.contact.update({
        where: { id: targetId },
        data: {
          email: target.email ?? source.email,
          phone: target.phone ?? source.phone,
          displayName: target.displayName ?? source.displayName,
          avatarUrl: target.avatarUrl ?? source.avatarUrl,
          metadata: mergedMetadata as any,
          tags: mergedTags as any,
          lastInteractionAt:
            target.lastInteractionAt && source.lastInteractionAt
              ? target.lastInteractionAt > source.lastInteractionAt
                ? target.lastInteractionAt
                : source.lastInteractionAt
              : target.lastInteractionAt ?? source.lastInteractionAt,
        },
      });
      await tx.contact.delete({ where: { id: sourceId } });
      return updated;
    });

    return res.json({ merged: true, contact: result });
  } catch (err) {
    console.error("identity.merge error:", err);
    return res.status(500).json({ error: "Failed to merge identities" });
  }
});

// GET /:id/timeline - unified timeline of events across channels for the contact
router.get("/:id/timeline", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const contactId = String(req.params.id);
    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // Conversation is keyed on (tenantId, channel, customerExternalId).
    // Match by the contact's channel/externalId AND any other contacts
    // sharing the same email/phone (unified timeline across channels).
    const siblings = await prisma.contact.findMany({
      where: {
        tenantId,
        OR: [
          { id: contact.id },
          ...(contact.email ? [{ email: contact.email as string }] : []),
          ...(contact.phone ? [{ phone: contact.phone as string }] : []),
        ],
      },
    });

    // Include aliases preserved from prior merges in target.metadata.aliases
    const meta = (contact.metadata as Record<string, unknown>) || {};
    const aliases = Array.isArray((meta as any).aliases)
      ? ((meta as any).aliases as Array<{ channel: string; externalId: string }>)
      : [];
    const orClauses = [
      ...siblings.map((s) => ({ channel: s.channel, customerExternalId: s.externalId })),
      ...aliases.map((a) => ({ channel: a.channel as any, customerExternalId: a.externalId })),
    ];
    const convos = await prisma.conversation.findMany({
      where: { tenantId, OR: orClauses },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });

    const events = convos.flatMap((c) =>
      c.messages.map((m) => ({
        type: "message" as const,
        channel: c.channel,
        conversationId: c.id,
        direction: m.direction,
        body: m.body,
        createdAt: m.createdAt,
      })),
    );
    events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return res.json({ contact, events });
  } catch (err) {
    console.error("identity.timeline error:", err);
    return res.status(500).json({ error: "Failed to load timeline" });
  }
});

export default router;
