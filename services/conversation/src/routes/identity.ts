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

    // Exclude soft-merged rows from match candidates so /resolve never
    // hands back a ghost that's been merged into another contact.
    let contact = orClauses.length
      ? await prisma.contact.findFirst({
          where: { tenantId, mergedIntoId: null, OR: orClauses },
        })
      : null;

    // Heuristic match: metadata keys overlap
    if (!contact && metadata && typeof metadata === "object") {
      const candidates = await prisma.contact.findMany({
        where: { tenantId, mergedIntoId: null, metadata: { not: null as any } },
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
      // Race-safe create: the unique index (tenantId, channel, externalId)
      // gives us a concurrency guarantee. If two concurrent callers both
      // miss the initial findFirst, the second create throws P2002 and we
      // re-read the row the winner inserted. Returning { matched: true }
      // for the loser keeps the caller idempotent.
      try {
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
      } catch (e: any) {
        if (e?.code === "P2002") {
          contact = await prisma.contact.findFirst({
            where: { tenantId, channel, externalId },
          });
          if (contact) return res.json({ matched: true, raced: true, contact });
        }
        throw e;
      }
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
    if (source.mergedIntoId) {
      return res
        .status(409)
        .json({ error: "source contact is already merged", mergedIntoId: source.mergedIntoId });
    }
    if (target.mergedIntoId) {
      return res
        .status(409)
        .json({ error: "target contact is itself merged", mergedIntoId: target.mergedIntoId });
    }

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

    // SOFT MERGE: previously we hard-deleted the source row here. That
    // created "ghost contacts" — the next inbound message on the merged
    // channel would miss the direct (tenantId, channel, externalId)
    // lookup and create a brand-new row, silently defeating the merge.
    //
    // Now we keep the source row and set `mergedIntoId` on it. Callers
    // that use resolveContactByChannelId() transparently route to the
    // target. broadcastRecipients still move to the target so audience
    // lists stay accurate.
    //
    // If target has no personId, propagate to source; if target has
    // one, use it. Either way the two rows share a personId afterwards.
    const { randomUUID } = await import("crypto");
    const sharedPersonId = target.personId ?? source.personId ?? `person_${randomUUID()}`;

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
          personId: sharedPersonId,
          lastInteractionAt:
            target.lastInteractionAt && source.lastInteractionAt
              ? target.lastInteractionAt > source.lastInteractionAt
                ? target.lastInteractionAt
                : source.lastInteractionAt
              : target.lastInteractionAt ?? source.lastInteractionAt,
        },
      });
      await tx.contact.update({
        where: { id: sourceId },
        data: {
          mergedIntoId: targetId,
          personId: sharedPersonId,
        },
      });
      return updated;
    });

    return res.json({ merged: true, contact: result });
  } catch (err: any) {
    // P2025 = record not found (source already merged by a concurrent caller)
    if (err?.code === "P2025") {
      return res.status(409).json({ error: "merge conflict: source already removed" });
    }
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

// ─── POST /link ──────────────────────────────────────────────
// Progressive identity linker. Called by the AI tool executor when an
// email or phone is extracted from a customer message. NEVER merges —
// either attaches the identifier to the current contact (safe) or
// records a pending IdentityLinkSuggestion when the identifier already
// belongs to a DIFFERENT contact in the same tenant.
//
// Security rules:
//   - verified identifier on current contact → never overwrite
//   - new identifier for a contact that already has one (unverified) → keep
//     existing, still create a suggestion so an admin can decide
//   - rate-limited: max 3 new identifiers per contact per 24h
//   - idempotent per messageId + identifier
router.post("/link", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { contactId, type, value, confidence, messageId, reason } = req.body ?? {};

    if (!contactId || typeof contactId !== "string") {
      return res.status(400).json({ error: "contactId required" });
    }
    if (type !== "email" && type !== "phone") {
      return res.status(400).json({ error: "type must be 'email' or 'phone'" });
    }
    if (!value || typeof value !== "string") {
      return res.status(400).json({ error: "value required" });
    }

    // Validate format
    const normalized = value.trim();
    if (type === "email") {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(normalized)) {
        return res.status(400).json({ error: "invalid email format" });
      }
    } else {
      // Loose E.164 check — digits, optional +, 8–15 total digits
      const digits = normalized.replace(/[^\d]/g, "");
      if (digits.length < 8 || digits.length > 15) {
        return res.status(400).json({ error: "invalid phone format" });
      }
    }
    const normalizedValue = type === "email" ? normalized.toLowerCase() : normalized;
    const conf = typeof confidence === "number" ? Math.max(0, Math.min(1, confidence)) : 0.5;

    // Load current contact (tenant-scoped)
    const current = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!current) return res.status(404).json({ error: "contact not found" });

    // Idempotency: if a suggestion already exists with this (messageId, value)
    // for this contact, short-circuit. Attach-path idempotency is inherent —
    // writing the same value twice is a no-op.
    if (messageId) {
      const existingSuggestion = await prisma.identityLinkSuggestion.findFirst({
        where: {
          tenantId,
          messageId,
          identifierType: type === "email" ? "EMAIL" : "PHONE",
          identifierValue: normalizedValue,
        },
      });
      if (existingSuggestion) {
        return res.json({ outcome: "duplicate", suggestion: existingSuggestion });
      }
    }

    // Rate limit: max 3 identifier changes per contact per 24h (based on
    // recent suggestions + the contact's own updatedAt field, best-effort).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await prisma.identityLinkSuggestion.count({
      where: { tenantId, sourceContactId: contactId, createdAt: { gt: since } },
    });
    if (recent >= 3) {
      return res.status(429).json({ error: "identity update rate limit exceeded" });
    }

    // Resolve — is this identifier already attached to another contact?
    const field = type === "email" ? "email" : "phone";
    const otherContact = await prisma.contact.findFirst({
      where: { tenantId, [field]: normalizedValue, NOT: { id: contactId } },
    });

    // Current contact's existing value for this field
    const currentValue = type === "email" ? current.email : current.phone;
    const currentVerified = type === "email" ? current.emailVerified : current.phoneVerified;

    // Never overwrite a verified value on the current contact.
    if (currentValue && currentVerified && currentValue !== normalizedValue) {
      return res.json({
        outcome: "rejected",
        reason: "current contact already has a verified identifier of this type",
      });
    }

    // Branch B: matches another contact → suggestion (never auto-merge).
    if (otherContact) {
      const suggestion = await prisma.identityLinkSuggestion.create({
        data: {
          tenantId,
          sourceContactId: contactId,
          targetContactId: otherContact.id,
          identifierType: type === "email" ? "EMAIL" : "PHONE",
          identifierValue: normalizedValue,
          confidence: conf,
          messageId: messageId ?? null,
          reason: reason ?? null,
        },
      });
      return res.json({ outcome: "suggestion_created", suggestion });
    }

    // Branch A: no match anywhere → attach to current contact (unverified).
    // If the current contact already has an unverified value, we keep it
    // untouched and still surface a suggestion so an admin can decide.
    if (currentValue && currentValue !== normalizedValue) {
      const suggestion = await prisma.identityLinkSuggestion.create({
        data: {
          tenantId,
          sourceContactId: contactId,
          targetContactId: contactId,
          identifierType: type === "email" ? "EMAIL" : "PHONE",
          identifierValue: normalizedValue,
          confidence: conf,
          messageId: messageId ?? null,
          reason: reason ?? "conflicts with existing unverified value",
        },
      });
      return res.json({ outcome: "conflict_pending", suggestion });
    }

    const updated = await prisma.contact.update({
      where: { id: contactId },
      data: type === "email" ? { email: normalizedValue } : { phone: normalizedValue },
      select: { id: true, email: true, phone: true, emailVerified: true, phoneVerified: true },
    });
    return res.json({ outcome: "attached", contact: updated });
  } catch (err: any) {
    console.error("identity.link error:", err);
    return res.status(500).json({ error: err?.message || "Failed to link identity" });
  }
});

export default router;
