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
    // created "ghost contacts" - the next inbound message on the merged
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

/**
 * GET /:id/timeline - one person's events across every channel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IT USED TO BE A SAMPLE PRESENTED AS A HISTORY
 *
 * The old query was `take: 50` conversations x `take: 5` messages, so it
 * returned at most 250 events and - worse than the ceiling - it took the five
 * NEWEST messages of each conversation. A 300-message thread contributed five.
 * The events were then merged and sorted, which produced a plausible-looking
 * stream with holes in the middle that nothing in the response disclosed.
 *
 * A screen calling that "her whole history" claims a completeness the data does
 * not have, and no consumer could tell.
 *
 * ── So it paginates MESSAGES, not conversations ──
 *
 * The event is a message; paginating its container is what created the
 * distortion. One cursor over the person's messages removes it, and `totals`
 * lets a screen say "50 of 1,284" instead of implying it has everything.
 *
 * ★ AND IT NO LONGER HIDES THE IMPORTED HISTORY. `applyLiveByDefault` injects
 * `origin: "LIVE"` into bulk Conversation/Message reads, so for a customer
 * whose WhatsApp history was imported this endpoint excluded exactly the
 * history. Both origins are now named explicitly (naming origin suppresses the
 * injection) and every event carries its own, so a screen can label an imported
 * message rather than silently missing it. `includeImported=false` restores the
 * old scope for a caller that wants live only.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** Page size ceiling. A caller asking for more gets this many, not an error. */
const TIMELINE_MAX_LIMIT = 200;
const TIMELINE_DEFAULT_LIMIT = 50;

/**
 * How many of the person's conversations we resolve ids for.
 *
 * Bounded because the id list becomes an `IN` clause. When a person has more
 * than this, the response SAYS the scan was truncated rather than quietly
 * dropping their oldest threads - the defect this endpoint is being fixed for.
 */
const TIMELINE_CONVERSATION_SCAN_CAP = 500;

router.get("/:id/timeline", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const contactId = String(req.params.id);
    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // Follow soft-merge pointer if the entry point itself was merged away
    const effective = contact.mergedIntoId
      ? await prisma.contact.findFirst({ where: { id: contact.mergedIntoId, tenantId } })
      : contact;
    if (!effective) return res.status(404).json({ error: "Contact target not found" });

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, TIMELINE_MAX_LIMIT)
      : TIMELINE_DEFAULT_LIMIT;
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;
    const includeImported = String(req.query.includeImported ?? "true") !== "false";

    // Naming origin at all is what suppresses the live-by-default injection, so
    // this clause is load-bearing even in the live-only case.
    const originClause = includeImported
      ? { origin: { in: ["LIVE", "HISTORICAL_IMPORT"] as any } }
      : { origin: "LIVE" as any };

    // Pull all rows belonging to the same person - personId-first path
    // covers contacts auto-unified via /capture, fallback email/phone
    // covers legacy contacts created before the personId column.
    const { findSiblingContacts } = await import("@chatcenter/shared");
    const siblings = await findSiblingContacts(tenantId, effective);

    // Include aliases preserved from prior merges in target.metadata.aliases
    const meta = (effective.metadata as Record<string, unknown>) || {};
    const aliases = Array.isArray((meta as any).aliases)
      ? ((meta as any).aliases as Array<{ channel: string; externalId: string }>)
      : [];
    const orClauses = [
      ...siblings.map((s) => ({ channel: s.channel, customerExternalId: s.externalId })),
      ...aliases.map((a) => ({ channel: a.channel as any, customerExternalId: a.externalId })),
    ];

    // An empty OR matches nothing in Prisma, and an empty page is the honest
    // answer for a contact with no channel identity - not an error.
    if (orClauses.length === 0) {
      return res.json({
        contact: effective,
        events: [],
        page: { limit, nextCursor: null, hasMore: false },
        totals: { conversations: 0, messages: 0, conversationScanTruncated: false },
      });
    }

    const convWhere = { tenantId, OR: orClauses, ...originClause };
    const [conversationCount, convos] = await Promise.all([
      prisma.conversation.count({ where: convWhere }),
      prisma.conversation.findMany({
        where: convWhere,
        orderBy: { updatedAt: "desc" },
        take: TIMELINE_CONVERSATION_SCAN_CAP,
        select: { id: true, channel: true, origin: true },
      }),
    ]);

    if (convos.length === 0) {
      return res.json({
        contact: effective,
        events: [],
        page: { limit, nextCursor: null, hasMore: false },
        totals: { conversations: 0, messages: 0, conversationScanTruncated: false },
      });
    }

    const byConversation = new Map(convos.map((c) => [c.id, c]));
    const messageWhere = {
      tenantId,
      conversationId: { in: convos.map((c) => c.id) },
      ...originClause,
    };

    let rows: Array<{ id: string; conversationId: string; direction: string; body: string | null; createdAt: Date; origin: string | null }>;
    let messageCount: number;
    try {
      [messageCount, rows] = await Promise.all([
        prisma.message.count({ where: messageWhere }),
        prisma.message.findMany({
          where: messageWhere,
          // id breaks ties so two messages in the same millisecond cannot make
          // the cursor loop or skip.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, conversationId: true, direction: true, body: true, createdAt: true, origin: true },
        }) as any,
      ]);
    } catch (err: any) {
      // A cursor from a deleted or foreign message: refuse it by name rather
      // than silently restarting from the top, which would look like the end of
      // the list wrapping around to the beginning.
      if (cursor) return res.status(400).json({ error: "invalid_cursor" });
      throw err;
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const events = page.map((m) => {
      const conv = byConversation.get(m.conversationId);
      return {
        type: "message" as const,
        channel: conv?.channel ?? null,
        conversationId: m.conversationId,
        direction: m.direction,
        body: m.body,
        createdAt: m.createdAt,
        // So a screen can mark an imported message instead of presenting it as
        // something it watched happen.
        origin: m.origin ?? conv?.origin ?? null,
      };
    });

    return res.json({
      contact: effective,
      events,
      page: {
        limit,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
      },
      totals: {
        conversations: conversationCount,
        messages: messageCount,
        // True when the person has more conversations than one scan covers, so
        // a caller knows `messages` counts the scanned set and not all of them.
        conversationScanTruncated: conversationCount > convos.length,
      },
    });
  } catch (err) {
    console.error("identity.timeline error:", err);
    return res.status(500).json({ error: "Failed to load timeline" });
  }
});

// ─── POST /link ──────────────────────────────────────────────
// Progressive identity linker. Called by the AI tool executor when an
// email or phone is extracted from a customer message. NEVER merges -
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
      // Loose E.164 check - digits, optional +, 8–15 total digits
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
    // for this contact, short-circuit. Attach-path idempotency is inherent -
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

    // Resolve - is this identifier already attached to another contact?
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

// ─── POST /capture ───────────────────────────────────────────
// Strong-signal identity capture. Called when a bot/flow/agent
// EXPLICITLY asked the customer for their email or phone and the
// customer responded with an identifier. Distinct from /link, which
// handles weak-signal LLM extraction.
//
// Behavior:
//   1. Format-validate + normalize the identifier
//   2. Mark it verified=true on the current contact (they volunteered it)
//   3. Sibling check: does another contact in this tenant already have
//      this identifier?
//     - YES → assign the same personId to both. Auto-link across
//       channels. No merge, no data loss.
//     - NO  → set the identifier on the current contact. Seed planted
//       for a future collision on another channel.
//
// Rate limit: max 3 captures per contact per 24h (reuses the
// identity-link suggestion count as a proxy since both record
// identity-related activity).
router.post("/capture", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { contactId, type, value, source } = req.body ?? {};

    if (!contactId || typeof contactId !== "string") {
      return res.status(400).json({ error: "contactId required" });
    }
    if (type !== "email" && type !== "phone") {
      return res.status(400).json({ error: "type must be 'email' or 'phone'" });
    }
    if (!value || typeof value !== "string") {
      return res.status(400).json({ error: "value required" });
    }

    // Normalize
    const raw = value.trim();
    if (type === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        return res.status(400).json({ error: "invalid email format" });
      }
    } else {
      const digits = raw.replace(/[^\d]/g, "");
      if (digits.length < 8 || digits.length > 15) {
        return res.status(400).json({ error: "invalid phone format" });
      }
    }
    const normalized = type === "email" ? raw.toLowerCase() : raw;

    const current = await prisma.contact.findFirst({
      where: { id: contactId, tenantId, mergedIntoId: null },
    });
    if (!current) return res.status(404).json({ error: "contact not found" });

    // Rate limit (best-effort)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await prisma.identityLinkSuggestion.count({
      where: { tenantId, sourceContactId: contactId, createdAt: { gt: since } },
    });
    if (recent >= 3) {
      return res.status(429).json({ error: "identity capture rate limit exceeded" });
    }

    // Sibling lookup: is another contact already using this identifier?
    const field = type === "email" ? "email" : "phone";
    const sibling = await prisma.contact.findFirst({
      where: {
        tenantId,
        mergedIntoId: null,
        NOT: { id: contactId },
        [field]: normalized,
      } as any,
    });

    // Resolve target personId - adopt sibling's if present, otherwise mint
    const { randomUUID } = await import("crypto");
    const personId =
      sibling?.personId ?? current.personId ?? `person_${randomUUID()}`;

    const updates: any = { personId };
    if (type === "email") {
      updates.email = normalized;
      updates.emailVerified = true;
    } else {
      updates.phone = normalized;
      updates.phoneVerified = true;
    }

    const updated = await prisma.contact.update({
      where: { id: contactId },
      data: updates,
      select: {
        id: true,
        email: true,
        phone: true,
        emailVerified: true,
        phoneVerified: true,
        personId: true,
      },
    });

    // Backfill sibling's personId so the link is bidirectional
    if (sibling && !sibling.personId) {
      await prisma.contact.update({
        where: { id: sibling.id },
        data: { personId },
      });
    }

    return res.json({
      outcome: sibling ? "auto_linked" : "attached",
      contact: updated,
      linkedTo: sibling?.id ?? null,
      source: source ?? "unknown",
    });
  } catch (err: any) {
    console.error("identity.capture error:", err);
    return res.status(500).json({ error: err?.message || "Failed to capture identity" });
  }
});

export default router;
