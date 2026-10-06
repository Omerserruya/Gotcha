import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import { visibilityClause } from "../lib/conversation-visibility";
import { situationOf } from "../lib/situation";

const router = Router();

/** The signed-in viewer, in the shape the visibility rule takes. */
const viewerOfReq = (req: Request) => ({
  userId: (req as any).user?.userId as string,
  role: (req as any).user?.role as string | undefined,
  departmentId: (req as any).user?.departmentId as string | undefined,
});
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
 * Every row that belongs to ONE person, and the origin decision.
 *
 * Both reads below need the same three things: follow the soft-merge pointer,
 * gather sibling contacts and preserved aliases, and decide about origin. They
 * were written inline once; a second copy is how two endpoints start disagreeing
 * about who a customer is.
 *
 * ★ THE ORIGIN CLAUSE IS ALWAYS PRESENT, in both branches. `applyLiveByDefault`
 * injects `origin: "LIVE"` into bulk Conversation/Message reads unless the
 * caller mentions origin, so the live-only case must name it too - otherwise the
 * filter is the guard's rather than ours, and a test on the rows cannot tell.
 */
type PersonScope =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      effective: any;
      /** OR clauses matching every channel identity this person is known by. */
      orClauses: Array<{ channel: any; customerExternalId: string }>;
      /**
       * The person's handles, one per contact row the walk found.
       *
       * PROJECTED, never the raw rows. `findSiblingContacts` selects no columns,
       * so each sibling arrives carrying its whole `metadata` JSON - which holds
       * customer phone numbers among other things. Returning them as-is would
       * ship that blob once per channel instead of once.
       */
      channels: Array<{ contactId: string; channel: any; externalId: string; displayName: string | null }>;
      originClause: { origin: any };
    };

async function resolvePersonScope(
  tenantId: string,
  contactId: string,
  includeImported: boolean,
): Promise<PersonScope> {
  /**
   * Explicit columns, never the whole row.
   *
   * ★ This was a `findFirst` with NO `select`, so every timeline response
   * carried the contact's open `metadata` JSON - which holds phone numbers among
   * other things. The one consumer was picking `aliases` out of it by name and
   * asserting in its own test that a `phone` beside it did not survive the
   * parse: a guard that protected exactly one caller and nothing else.
   *
   * `aliases` is now served as part of `identityChannels`, so nothing needs the
   * blob. Named columns include the customer's own email and phone, which a
   * customer panel legitimately shows - the surplus was never those, it was
   * everything else that happens to be in an unbounded JSON column.
   */
  // Every named column on Contact. `findSiblingContacts` takes a whole `Contact`,
  // so the list is exhaustive by necessity rather than by preference - which is
  // fine, because the surplus was never the named columns. It was `metadata`: an
  // unbounded JSON column whose contents nobody downstream can enumerate.
  const CONTACT_FIELDS = {
    id: true, tenantId: true, channel: true, externalId: true,
    displayName: true, email: true, emailVerified: true,
    phone: true, phoneVerified: true, avatarUrl: true, tags: true,
    lastSeenAt: true, lastInteractionAt: true, source: true,
    optOutChannels: true, optedOutAt: true,
    personId: true, mergedIntoId: true, createdAt: true, updatedAt: true,
  } as const;

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    // `metadata` is read here and NOT returned: the alias walk needs it, the
    // response does not.
    select: { ...CONTACT_FIELDS, metadata: true },
  });
  if (!contact) return { ok: false, status: 404, error: "Contact not found" };

  // Follow soft-merge pointer if the entry point itself was merged away
  const effective = contact.mergedIntoId
    ? await prisma.contact.findFirst({
        where: { id: contact.mergedIntoId, tenantId },
        select: { ...CONTACT_FIELDS, metadata: true },
      })
    : contact;
  if (!effective) return { ok: false, status: 404, error: "Contact target not found" };

  // personId-first covers contacts auto-unified via /capture; the email/phone
  // fallback covers legacy contacts created before the personId column.
  const { findSiblingContacts } = await import("@chatcenter/shared");
  const siblings = await findSiblingContacts(tenantId, effective);

  // Aliases preserved from prior merges in target.metadata.aliases
  const meta = (effective.metadata as Record<string, unknown>) || {};
  // Validated, not just type-asserted. A `null` or a bare string in this array
  // threw on `a.channel` and took the whole timeline to a 500 - found by a test
  // that fed it four malformed shapes. The cast said the elements were objects;
  // nothing checked.
  const aliases = (Array.isArray((meta as any).aliases) ? ((meta as any).aliases as unknown[]) : [])
    .filter((a): a is { channel: string; externalId: string } =>
      !!a && typeof a === "object"
      && typeof (a as any).channel === "string"
      && typeof (a as any).externalId === "string");

  return {
    ok: true,
    effective,
    channels: siblings.map((c: any) => ({
      contactId: c.id,
      channel: c.channel,
      externalId: c.externalId,
      displayName: c.displayName ?? null,
    })),
    orClauses: [
      ...siblings.map((s: any) => ({ channel: s.channel, customerExternalId: s.externalId })),
      ...aliases.map((a) => ({ channel: a.channel as any, customerExternalId: a.externalId })),
    ],
    originClause: includeImported
      ? { origin: { in: ["LIVE", "HISTORICAL_IMPORT"] as any } }
      : { origin: "LIVE" as any },
  };
}

/** `?includeImported=` - imported history counts unless the caller opts out. */
function wantsImported(req: Request): boolean {
  return String(req.query.includeImported ?? "true") !== "false";
}

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

/**
 * What this timeline can contain, and what it deliberately cannot.
 *
 * 04b asks for one stream mixing conversations, orders, returns, AI actions and
 * notes. Three of those are not local:
 *
 *   orders / returns  There is NO Order or Return model in the schema. They live
 *                     in Shopify, so putting them here would mean a live
 *                     commerce call per render - which makes the whole history
 *                     fail when Shopify is slow. They get their own screen.
 *   notes             External, in the merchant's CRM.
 *
 * ★ REPORTED ON THE WIRE, not in a comment. A screen cannot tell "this customer
 * has no orders" from "this endpoint never had orders" by looking at an empty
 * list, and the difference decides whether it renders an empty state or a link.
 * Same shape as `topics: { available: false }` on /insights.
 */
const TIMELINE_COVERAGE = {
  message: { available: true },
  handover: { available: true },
  ai_action: {
    available: true,
    // Stated because the gap is invisible from the data: the stream looks
    // complete and simply omits a whole class of action.
    detail: "ToolExecution records catalog HTTP tools only. An action taken through an adapter, such as a Shopify refund, is not recorded here.",
  },
  order: { available: false, reason: "no_local_model", detail: "Orders live in the commerce platform and are served by their own screen." },
  return: { available: false, reason: "no_local_model", detail: "Returns live in the commerce platform and are served by their own screen." },
  note: { available: false, reason: "external_crm", detail: "Notes are written to the merchant's CRM and read back as recent_crm_notes." },
} as const;

const TIMELINE_EVENT_TYPES = ["message", "handover", "ai_action"] as const;
type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

/**
 * A cursor over a MERGED stream cannot be a row id.
 *
 * Prisma's `cursor` addresses one table. Three sources interleave here, so the
 * cursor is the sort key itself - timestamp plus id - and paging is "everything
 * strictly older than this point". That also survives the cursor row being
 * deleted between pages, which an id cursor does not.
 */
function encodeCursor(at: Date, id: string): string {
  return `${at.toISOString()}~${id}`;
}

/**
 * The keyset predicate for "strictly older than this point".
 *
 * ★ PUSHED INTO THE QUERY, not applied after. The first version fetched
 * `limit + 1` with `lte` and dropped the boundary row afterwards, which left
 * exactly `limit` rows and made `hasMore` false one page early - the walk
 * stopped at 100 of 120 and reported itself complete. Filtering after a LIMIT
 * always risks that: the row you discard was the evidence that more exist.
 */
function keysetOlderThan(field: string, c: { at: Date; id: string } | null): Record<string, unknown> {
  if (!c) return {};
  return {
    OR: [
      { [field]: { lt: c.at } },
      { AND: [{ [field]: c.at }, { id: { lt: c.id } }] },
    ],
  };
}

function decodeCursor(raw: string): { at: Date; id: string } | null {
  const sep = raw.indexOf("~");
  if (sep <= 0) return null;
  const at = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(at.getTime()) || !id) return null;
  return { at, id };
}

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
    const scope = await resolvePersonScope(tenantId, String(req.params.id), wantsImported(req));
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const { effective, orClauses, originClause, channels } = scope;
    // Everything the panel needs, minus the open JSON column. `aliases` from it
    // is already folded into identityChannels below.
    const { metadata: _contactMetadata, ...contact } = effective as Record<string, unknown>;

    /**
     * Every handle this person is known by, and where each came from.
     *
     * `metadata.aliases` covers only handles MERGED INTO this contact. Somebody
     * unified-but-never-merged - linked by `personId` - has handles that list
     * cannot see, so a panel built on aliases alone says "channels we joined up"
     * rather than "her channels". The walk that finds them already happens to
     * scope the query below; it was simply discarded on the way out.
     */
    const aliasHandles = ((effective.metadata as any)?.aliases ?? [])
      .filter((a: any) => a && typeof a.channel === "string" && typeof a.externalId === "string")
      .map((a: any) => ({ contactId: null as string | null, channel: a.channel, externalId: a.externalId, displayName: null, source: "merged" as const }));
    const seen = new Set(channels.map((c) => `${c.channel}:${c.externalId}`));
    const identityChannels = [
      ...channels.map((c) => ({ ...c, source: "linked" as const })),
      // A merged alias whose handle is already a live sibling would be the same
      // channel twice with two provenances; the live row wins.
      ...aliasHandles.filter((a: any) => !seen.has(`${a.channel}:${a.externalId}`)),
    ];

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, TIMELINE_MAX_LIMIT)
      : TIMELINE_DEFAULT_LIMIT;
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;

    // An empty OR matches nothing in Prisma, and an empty page is the honest
    // answer for a contact with no channel identity - not an error.
    if (orClauses.length === 0) {
      return res.json({
        contact,
        identityChannels,
        events: [],
        page: { limit, types: [...TIMELINE_EVENT_TYPES], nextCursor: null, hasMore: false },
        coverage: TIMELINE_COVERAGE,
        totals: { conversations: 0, messages: 0, handovers: 0, aiActions: 0, conversationScanTruncated: false },
      });
    }

    // The viewer's visibility, as in the inbox: a department-restricted agent
    // does not get another department's threads through a customer's history.
    // Unrestricted viewers keep the exact where they had.
    const viewerVisibility = visibilityClause(viewerOfReq(req));
    const convWhere = viewerVisibility
      ? { tenantId, AND: [{ OR: orClauses }, { OR: viewerVisibility }], ...originClause }
      : { tenantId, OR: orClauses, ...originClause };
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
        contact,
        identityChannels,
        events: [],
        page: { limit, types: [...TIMELINE_EVENT_TYPES], nextCursor: null, hasMore: false },
        coverage: TIMELINE_COVERAGE,
        totals: { conversations: 0, messages: 0, handovers: 0, aiActions: 0, conversationScanTruncated: false },
      });
    }

    const byConversation = new Map(convos.map((c) => [c.id, c]));
    const conversationIds = convos.map((c) => c.id);

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      // Refused by name rather than silently restarting from the top, which a
      // paging UI renders as a history that never ends.
      return res.status(400).json({ error: "invalid_cursor" });
    }

    const requested = typeof req.query.types === "string" && req.query.types.trim()
      ? req.query.types.split(",").map((t) => t.trim()).filter(Boolean)
      : [...TIMELINE_EVENT_TYPES];
    const unknown = requested.filter((t) => !TIMELINE_EVENT_TYPES.includes(t as TimelineEventType));
    if (unknown.length > 0) {
      // A typo must not silently return a stream missing what was asked for.
      return res.status(400).json({ error: "unknown_event_type", unknown, supported: TIMELINE_EVENT_TYPES });
    }
    const wanted = new Set(requested as TimelineEventType[]);

    const messageWhere = { tenantId, conversationId: { in: conversationIds }, ...originClause };
    const olderMessage = keysetOlderThan("createdAt", decoded);
    const olderHandover = keysetOlderThan("at", decoded);

    type Event = {
      type: TimelineEventType;
      id: string;
      createdAt: Date;
      conversationId: string;
      channel: any;
      origin: string | null;
      direction?: string;
      body?: string | null;
      handover?: { from: string | null; to: string; actorUserId: string | null; reason: string | null };
      action?: { tool: string; success: boolean; triggeredBy: string; durationMs: number | null; approvedBy: string | null };
    };

    const [messageCount, handoverCount, actionCount, messageRows, handoverRows, actionRows] = await Promise.all([
      wanted.has("message") ? prisma.message.count({ where: messageWhere }) : Promise.resolve(0),
      wanted.has("handover")
        ? (prisma as any).conversationHandover.count({ where: { tenantId, conversationId: { in: conversationIds } } })
        : Promise.resolve(0),
      wanted.has("ai_action")
        ? (prisma as any).toolExecution.count({ where: { tenantId, conversationId: { in: conversationIds } } })
        : Promise.resolve(0),
      wanted.has("message")
        ? prisma.message.findMany({
            where: { ...messageWhere, ...olderMessage },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
            select: { id: true, conversationId: true, direction: true, body: true, createdAt: true, origin: true },
          })
        : Promise.resolve([] as any[]),
      wanted.has("handover")
        ? (prisma as any).conversationHandover.findMany({
            where: { tenantId, conversationId: { in: conversationIds }, ...olderHandover },
            orderBy: [{ at: "desc" }, { id: "desc" }],
            take: limit + 1,
          })
        : Promise.resolve([] as any[]),
      wanted.has("ai_action")
        ? (prisma as any).toolExecution.findMany({
            where: { tenantId, conversationId: { in: conversationIds }, ...olderMessage },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
            select: { id: true, conversationId: true, toolName: true, success: true, triggeredBy: true, durationMs: true, approvedBy: true, createdAt: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const merged: Event[] = [
      ...(messageRows as any[]).map((m): Event => ({
        type: "message",
        id: m.id,
        createdAt: m.createdAt,
        conversationId: m.conversationId,
        channel: byConversation.get(m.conversationId)?.channel ?? null,
        // So a screen can mark an imported message instead of presenting it as
        // something it watched happen.
        origin: m.origin ?? byConversation.get(m.conversationId)?.origin ?? null,
        direction: m.direction,
        body: m.body,
      })),
      ...(handoverRows as any[]).map((h): Event => ({
        type: "handover",
        id: h.id,
        createdAt: h.at,
        conversationId: h.conversationId,
        channel: byConversation.get(h.conversationId)?.channel ?? null,
        origin: byConversation.get(h.conversationId)?.origin ?? null,
        body: null,
        handover: { from: h.fromHandler ?? null, to: h.toHandler, actorUserId: h.actorUserId ?? null, reason: h.reason ?? null },
      })),
      ...(actionRows as any[]).map((t): Event => ({
        type: "ai_action",
        id: t.id,
        createdAt: t.createdAt,
        conversationId: t.conversationId,
        channel: byConversation.get(t.conversationId)?.channel ?? null,
        origin: byConversation.get(t.conversationId)?.origin ?? null,
        body: null,
        action: { tool: t.toolName, success: t.success, triggeredBy: t.triggeredBy, durationMs: t.durationMs ?? null, approvedBy: t.approvedBy ?? null },
      })),
    ];

    merged.sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

    // Every source already excluded everything at or newer than the cursor
    // POINT, so nothing is dropped here and `limit + 1` still means "there is
    // at least one more". Addressing a point rather than a row also survives
    // the cursor row being deleted between pages.
    const hasMore = merged.length > limit;
    const pageRows = merged.slice(0, limit);
    const last = pageRows[pageRows.length - 1];

    return res.json({
      contact,
      identityChannels,
      events: pageRows,
      page: {
        limit,
        types: [...wanted],
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
      },
      coverage: TIMELINE_COVERAGE,
      totals: {
        conversations: conversationCount,
        messages: messageCount,
        handovers: handoverCount,
        aiActions: actionCount,
        // True when the person has more conversations than one scan covers, so
        // a caller knows the counts cover the scanned set and not all of them.
        conversationScanTruncated: conversationCount > convos.length,
      },
    });
  } catch (err) {
    console.error("identity.timeline error:", err);
    return res.status(500).json({ error: "Failed to load timeline" });
  }
});

/**
 * GET /:id/insights - what this person's conversations were MADE OF, and when.
 *
 * Two things 04c asks for that nothing served: what each conversation
 * contained and who handled it, and the customer's own behaviour - preferred
 * channel and responsive hours.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EVERY NUMBER HERE IS COUNTED, AND THE ONE THAT CANNOT BE IS DECLARED ABSENT
 *
 * `topics` reports `available: false`. There is no per-customer topic store:
 * `HistoricalImport.topTopics` is per IMPORT, and the customer brief's
 * `signals` are LLM prose. Prose resembling a distribution is not a
 * distribution, and substituting it would be the reassuring kind of defect -
 * a screen showing a confident breakdown nothing measured.
 *
 * ── The hour histogram is in the TENANT'S timezone, and says which ──
 *
 * "Responsive between 18:00 and 21:00" is a claim about the customer's day, so
 * bucketing in UTC would shift an Israeli customer's evening into the previous
 * afternoon. The tenant's business-hours timezone is used when set, and the
 * response names the zone it used so a screen never has to guess.
 *
 * ── Only INBOUND messages count toward responsiveness ──
 *
 * Outbound is us. A tenant that broadcasts at 09:00 would otherwise appear as
 * a customer who is active at 09:00 - measuring our own behaviour and calling
 * it theirs.
 * ════════════════════════════════════════════════════════════════════════════
 */
const INSIGHTS_CONVERSATION_CAP = 200;

/** GET /:id/conversations page bounds. */
const PERSON_CONVERSATIONS_DEFAULT_LIMIT = 20;
const PERSON_CONVERSATIONS_MAX_LIMIT = 50;

/**
 * GET /:id/conversations - one person's conversations across every channel,
 * newest first, each with a one-line summary. The inbox panel's "history
 * across channels".
 *
 * Same person walk as /timeline (`resolvePersonScope`: personId siblings plus
 * merged aliases), so the two cannot disagree about who this person is.
 *
 * ★ VISIBILITY. The list applies `visibilityClause` - the ONE rule the inbox
 * list and the socket room join use - so a department-restricted agent is not
 * shown other departments' conversations, or their summaries, through a
 * customer's history. /timeline and /insights apply it too.
 *
 * `summary` is ConversationIntelligence.summary through `situationOf`, the
 * cleaning the contact list already uses: the first meaningful line, markdown
 * stripped, null for a placeholder - never a raw "**Summary:** -".
 *
 * Query: `limit` (default 20, max 50), `current` (a conversation id to mark
 * isCurrent), `includeImported` (default true, as /timeline).
 */
router.get("/:id/conversations", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const scope = await resolvePersonScope(tenantId, String(req.params.id), wantsImported(req));
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const { orClauses, originClause } = scope;

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, PERSON_CONVERSATIONS_MAX_LIMIT)
      : PERSON_CONVERSATIONS_DEFAULT_LIMIT;
    const current = typeof req.query.current === "string" ? req.query.current : null;

    // An empty OR matches nothing in Prisma; a contact with no channel identity
    // simply has no conversations.
    if (orClauses.length === 0) return res.json({ data: [], total: 0, hasMore: false });

    const visibility = visibilityClause({
      userId: req.user!.userId,
      role: req.user!.role,
      departmentId: (req.user as any)?.departmentId,
    });
    const where = {
      tenantId,
      // AND, not a second OR key: the person's identities and the viewer's
      // visibility are two separate conditions that must BOTH hold.
      AND: [{ OR: orClauses }, ...(visibility ? [{ OR: visibility }] : [])],
      ...originClause,
    };

    const [total, convos] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: limit,
        select: { id: true, channel: true, status: true, createdAt: true, lastMessageAt: true },
      }),
    ]);
    if (convos.length === 0) return res.json({ data: [], total, hasMore: false });

    const ids = convos.map((c) => c.id);
    const [counts, intel] = await Promise.all([
      prisma.message.groupBy({
        by: ["conversationId"],
        where: { tenantId, conversationId: { in: ids }, messageType: { not: "system" } },
        _count: { _all: true },
      }),
      prisma.conversationIntelligence.findMany({
        where: { tenantId, conversationId: { in: ids } },
        select: { conversationId: true, summary: true },
      }),
    ]);
    const countBy = new Map(counts.map((c: any) => [c.conversationId, c._count._all as number]));
    const summaryBy = new Map(intel.map((i) => [i.conversationId, situationOf(i.summary)]));

    res.json({
      data: convos.map((c) => ({
        conversationId: c.id,
        channel: c.channel,
        status: c.status,
        startedAt: c.createdAt,
        lastMessageAt: c.lastMessageAt,
        messageCount: countBy.get(c.id) ?? 0,
        // null = no summary yet (or only a placeholder), not "nothing happened".
        summary: summaryBy.get(c.id) ?? null,
        isCurrent: current !== null && c.id === current,
      })),
      total,
      hasMore: total > convos.length,
    });
  } catch (err: any) {
    console.error("[identity] person conversations failed:", err?.message);
    res.status(500).json({ error: "conversations_failed" });
  }
});

router.get("/:id/insights", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const scope = await resolvePersonScope(tenantId, String(req.params.id), wantsImported(req));
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const { effective, orClauses, originClause } = scope;

    const empty = {
      contact: effective,
      timezone: "UTC",
      conversations: [],
      channels: [],
      preferredChannel: null,
      hours: [],
      topics: { available: false as const, reason: "no_topic_store" as const },
      totals: { conversations: 0, messages: 0, conversationScanTruncated: false },
    };
    if (orClauses.length === 0) return res.json(empty);

    // The viewer's visibility, as in the inbox: a department-restricted agent
    // does not get another department's threads through a customer's history.
    // Unrestricted viewers keep the exact where they had.
    const viewerVisibility = visibilityClause(viewerOfReq(req));
    const convWhere = viewerVisibility
      ? { tenantId, AND: [{ OR: orClauses }, { OR: viewerVisibility }], ...originClause }
      : { tenantId, OR: orClauses, ...originClause };
    const [conversationCount, convos] = await Promise.all([
      prisma.conversation.count({ where: convWhere }),
      prisma.conversation.findMany({
        where: convWhere,
        orderBy: { updatedAt: "desc" },
        take: INSIGHTS_CONVERSATION_CAP,
        select: {
          id: true, channel: true, origin: true, status: true,
          createdAt: true, updatedAt: true,
          assignedAgentId: true, assignedAiAgentId: true,
        },
      }),
    ]);
    if (convos.length === 0) return res.json(empty);

    const ids = convos.map((c) => c.id);
    const messages = await prisma.message.findMany({
      where: { tenantId, conversationId: { in: ids }, ...originClause },
      select: { conversationId: true, direction: true, messageType: true, createdAt: true, senderName: true },
    });

    // ── Timezone, named rather than assumed ──
    let timezone = "UTC";
    try {
      const { readDurableSetting } = await import("@chatcenter/shared");
      const raw = await readDurableSetting(tenantId, "businessHours");
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed.timezone === "string" && parsed.timezone.trim()) {
        // Reject a zone Intl cannot resolve rather than throwing per message.
        new Intl.DateTimeFormat("en-US", { timeZone: parsed.timezone });
        timezone = parsed.timezone;
      }
    } catch {
      timezone = "UTC";
    }
    const hourOf = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false });

    const perConversation = new Map(
      convos.map((c) => [c.id, {
        messages: 0,
        inbound: 0,
        outbound: 0,
        composition: {} as Record<string, number>,
        firstAt: null as Date | null,
        lastAt: null as Date | null,
        humanSenders: new Set<string>(),
      }]),
    );
    const perChannel = new Map<string, { conversations: number; messages: number; inbound: number; outbound: number; lastAt: Date | null }>();
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, inbound: 0 }));

    for (const c of convos) {
      const ch = String(c.channel);
      const row = perChannel.get(ch) ?? { conversations: 0, messages: 0, inbound: 0, outbound: 0, lastAt: null };
      row.conversations += 1;
      perChannel.set(ch, row);
    }

    for (const m of messages) {
      const conv = m.conversationId ? convos.find((c) => c.id === m.conversationId) : undefined;
      const agg = m.conversationId ? perConversation.get(m.conversationId) : undefined;
      if (agg) {
        agg.messages += 1;
        if (m.direction === "INBOUND") agg.inbound += 1; else agg.outbound += 1;
        const type = m.messageType || "text";
        agg.composition[type] = (agg.composition[type] ?? 0) + 1;
        if (!agg.firstAt || m.createdAt < agg.firstAt) agg.firstAt = m.createdAt;
        if (!agg.lastAt || m.createdAt > agg.lastAt) agg.lastAt = m.createdAt;
        // senderName is the ONLY author field we have, and live outbound is
        // almost entirely "AI Bot". Collecting the non-bot names is what lets a
        // card say a person answered without inventing an identity.
        if (m.direction === "OUTBOUND" && m.senderName && !/^(ai bot|system|broadcast)$/i.test(m.senderName)) {
          agg.humanSenders.add(m.senderName);
        }
      }
      if (conv) {
        const ch = String(conv.channel);
        const row = perChannel.get(ch)!;
        row.messages += 1;
        if (m.direction === "INBOUND") row.inbound += 1; else row.outbound += 1;
        if (!row.lastAt || m.createdAt > row.lastAt) row.lastAt = m.createdAt;
      }
      if (m.direction === "INBOUND") {
        const h = Number.parseInt(hourOf.format(m.createdAt), 10);
        if (Number.isFinite(h) && h >= 0 && h < 24) hours[h]!.inbound += 1;
      }
    }

    const conversations = convos.map((c) => {
      const agg = perConversation.get(c.id)!;
      const humans = [...agg.humanSenders];
      return {
        id: c.id,
        channel: c.channel,
        origin: c.origin,
        status: c.status,
        startedAt: agg.firstAt ?? c.createdAt,
        lastAt: agg.lastAt ?? c.updatedAt,
        messages: agg.messages,
        inbound: agg.inbound,
        outbound: agg.outbound,
        // What it was MADE OF: { text: 40, image: 3, audio: 1 }.
        composition: agg.composition,
        handler: {
          assignedAgentId: c.assignedAgentId,
          assignedAiAgentId: c.assignedAiAgentId,
          humanSenders: humans,
          // Derived from what actually happened, not from the assignment: a
          // conversation can be assigned to a human nobody ever replied as.
          handledBy: humans.length > 0
            ? (agg.outbound > humans.length ? "BOTH" : "HUMAN")
            : (agg.outbound > 0 ? "AI" : "UNANSWERED"),
        },
      };
    });

    const channels = [...perChannel.entries()]
      .map(([channel, v]) => ({ channel, ...v }))
      .sort((a, b) => b.inbound - a.inbound || b.messages - a.messages);

    const top = channels[0];
    const preferredChannel = top && top.inbound > 0
      ? {
          channel: top.channel,
          // Named so a screen states the basis instead of implying the customer
          // said so. It is where they write most, not a stated preference.
          basis: "most_inbound_messages" as const,
          inbound: top.inbound,
          share: Number((top.inbound / channels.reduce((n, c) => n + c.inbound, 0)).toFixed(4)),
        }
      : null;

    return res.json({
      contact: effective,
      timezone,
      conversations,
      channels,
      preferredChannel,
      hours,
      topics: { available: false as const, reason: "no_topic_store" as const },
      totals: {
        conversations: conversationCount,
        messages: messages.length,
        conversationScanTruncated: conversationCount > convos.length,
      },
    });
  } catch (err) {
    console.error("identity.insights error:", err);
    return res.status(500).json({ error: "Failed to load insights" });
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
