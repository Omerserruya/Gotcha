/**
 * /api/audit-logs - the record of what happened, including what GOTCHA did.
 *
 * WHY THIS EXISTS AT ALL
 * `AuditLog` carries six indexes and 5,000+ rows on a single dev tenant, and
 * until now had no tenant-facing reader. Its only consumers were internal -
 * the action planner reading the AI's own history, commerce dedup, customer
 * state. Everything was written carefully and shown to nobody.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   `metadata` is NOT returned. It holds `args`, and args hold customer data:
 *   `{"args": {"phone": "+972545680665"}, "tool": "shopify.get_customer_by_phone"}`
 *   is a real row on the dev tenant. The screen's subject is what happened, not
 *   who it happened to, and shipping the whole blob would put customer phone
 *   numbers into a new surface in bulk, exportable, for every lookup the AI
 *   ever made. `succeeded` is lifted out of it instead, because that one field
 *   is about the event rather than the customer.
 *
 *   No money filter. `action` names the tool, so `action IN (<money actions>)`
 *   would be index-served and is therefore possible - but the list is
 *   provider-specific and every money tool added later falls silently outside
 *   it. On a security screen a filter that quietly gets less true as the
 *   product grows is worse than one that never existed.
 *
 *   No category taxonomy. The honest fix is a `significance` column written at
 *   emit time by the code that knows whether it acted or looked something up.
 *   That is a migration plus every emitter. Until then `/actions` serves the
 *   real vocabulary and lets the reader narrow it themselves, which invents
 *   nothing and cannot drift.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requirePermissionOrRole,
  assertTenantId,
  findSiblingContacts,
} from "@chatcenter/shared";

const router = Router();

// Matches the Security screen's siblings (`/api/tenant-security`) rather than
// introducing a new permission key for one read.
const CAN_READ = requirePermissionOrRole("settings:workspace:update", "ADMIN");

router.use("/audit-logs", authenticate, resolveTenant);

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const FACET_CAP = 50;

/** Shared filter builder so the list and its facet can never disagree. */
function buildWhere(req: Request, tenantId: string, opts: { includeAction: boolean }) {
  const where: Record<string, unknown> = { tenantId };
  const actorType = typeof req.query.actorType === "string" ? req.query.actorType.trim() : "";
  if (actorType) where.actorType = actorType;
  if (opts.includeAction) {
    const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
    if (action) where.action = action;
  }
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    where.createdAt = {
      ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
    };
  }
  return where;
}

function badDates(req: Request): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = [];
  for (const field of ["from", "to"] as const) {
    const raw = req.query[field];
    if (typeof raw === "string" && raw && Number.isNaN(new Date(raw).getTime())) {
      out.push({ field, message: `${field} must be an ISO-8601 date` });
    }
  }
  return out;
}

// ─── Facet · the real vocabulary, with counts ─────────────────
//
// Mounted ABOVE nothing that could shadow it today, but kept first as a habit:
// a later `/audit-logs/:id` would capture "actions" as an id and 404 a path
// that exists.
//
// Scoped by the SAME filters as the list except `action` itself. Counts that
// disagree with the rows in front of the reader are worse than no counts,
// because the number is trusted over the list - and leaving `action` out is
// what lets the facet still show what you could switch TO.
router.get("/audit-logs/actions", CAN_READ, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const bad = badDates(req);
  if (bad.length > 0) {
    res.status(422).json({ error: "Invalid audit filter", details: bad });
    return;
  }
  try {
    const grouped = await prisma.auditLog.groupBy({
      by: ["action"],
      where: buildWhere(req, tenantId, { includeAction: false }) as never,
      _count: { _all: true },
      orderBy: { _count: { action: "desc" } },
      // One more than the cap, so `truncated` is a fact rather than a guess:
      // asking for 51 and receiving 51 proves a 52nd may exist.
      take: FACET_CAP + 1,
    });
    const truncated = grouped.length > FACET_CAP;
    res.json({
      data: grouped.slice(0, FACET_CAP).map((g) => ({ action: g.action, count: g._count._all })),
      truncated,
    });
  } catch (err) {
    console.error("audit facet error:", err);
    res.status(500).json({ error: "Failed to summarise the audit log" });
  }
});

// ─── One customer · what was done in their name ───────────────
//
// Screen 04e. "Actions on her account" - which action, by an AI employee or a
// person, and whether it worked.
//
// ════════════════════════════════════════════════════════════════════════════
// IT IS A NEW READ, NOT A WHERE-CLAUSE ON THE LIST ABOVE
//
// `buildWhere` takes actorType, action, from and to. There is no `targetId`
// parameter and adding one would not be enough, because the customer is not a
// column on `AuditLog` - it has to be reached through the conversations that
// belong to the person, and `conversations` has NO `contact_id`. The join is on
// an EXTERNAL identifier, which is the risk this endpoint exists to contain:
//
// ★ A CONTACT WHOSE external_id DISAGREES WITH ITS CONVERSATIONS GETS A
// SILENTLY SHORT LOG, and an incomplete audit log looks exactly like a quiet
// customer. So the person is resolved through the sibling walk and preserved
// aliases - a merged contact keeps its history rather than reading as new.
//
// ── Two of the three target types are NOT attributable, and that is stated ──
//
//   targetType "conversation"  reachable. the rich set: ai.responded,
//                              adapter.ok/err.shopify.*, crm.link.linked
//   targetType "customer"      targetId is a SHOPIFY customer id
//                              (`commerce-actions.service.ts:192` writes
//                              `resolveVerifiedShopifyCustomerId`), not a
//                              Contact id - so it cannot be derived from the
//                              contact. Included only when the caller passes
//                              the key it already holds.
//   targetType "order"         same id space, and there is no local Order
//                              table to enumerate a person's orders from.
//                              NOT attributable. Declared, never silently
//                              dropped.
// ════════════════════════════════════════════════════════════════════════════
const AUDIT_CONVERSATION_SCAN_CAP = 500;

const CUSTOMER_AUDIT_COVERAGE = {
  conversation: { attributable: true },
  customer: {
    attributable: true,
    requires: "shopifyCustomerId",
    detail: "Rows are keyed by the commerce platform's customer id, which this endpoint cannot derive from a contact. Pass ?shopifyCustomerId= to include them.",
  },
  order: {
    attributable: false,
    reason: "no_local_order_table",
    detail: "Order-keyed rows are keyed by the commerce platform's order id and there is no local Order table to enumerate this person's orders from.",
  },
} as const;

/**
 * The outcome of one row, reported as the two independent facts it actually is.
 *
 * `adapter.err.shopify.process_refund` carries an outcome in its NAME while
 * `metadata.ok` carries the emitter's explicit verdict, on the same row, with
 * nothing keeping them in agreement.
 *
 * ★ THEY ARE NOT MERGED INTO ONE FIELD. `succeeded` stays the explicit verdict
 * and stays null when none was recorded - "we did not record whether this
 * worked" is not "it failed", and resolving it from a naming convention would
 * turn a naming convention into evidence. The prefix is reported separately so
 * a screen can show it as a weaker signal, and `outcomeDisagrees` marks the row
 * where the emitter contradicts its own name about whether a refund happened.
 * That row is a bug worth seeing, not a value worth smoothing.
 */
function outcomeOf(action: string, metadata: unknown) {
  const meta = metadata as Record<string, unknown> | null;
  const succeeded = meta && typeof meta.ok === "boolean" ? (meta.ok as boolean) : null;
  const nameImpliesSucceeded = /(^|\.)ok\./.test(action) ? true : /(^|\.)err\./.test(action) ? false : null;
  return {
    succeeded,
    nameImpliesSucceeded,
    outcomeDisagrees:
      succeeded !== null && nameImpliesSucceeded !== null && succeeded !== nameImpliesSucceeded,
  };
}

router.get("/audit-logs/customer/:contactId", CAN_READ, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const bad = badDates(req);
  if (bad.length > 0) {
    res.status(422).json({ error: "Invalid audit filter", details: bad });
    return;
  }
  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;
  const shopifyCustomerId =
    typeof req.query.shopifyCustomerId === "string" && req.query.shopifyCustomerId.trim()
      ? req.query.shopifyCustomerId.trim()
      : null;

  try {
    const contact = await prisma.contact.findFirst({ where: { id: String(req.params.contactId), tenantId } });
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    // A merged-away contact is a valid entry point and must resolve to the
    // surviving person, not to an empty log.
    const effective = contact.mergedIntoId
      ? await prisma.contact.findFirst({ where: { id: contact.mergedIntoId, tenantId } })
      : contact;
    if (!effective) {
      res.status(404).json({ error: "Contact target not found" });
      return;
    }

    const siblings = await findSiblingContacts(tenantId, effective as never);
    const meta = ((effective as any).metadata as Record<string, unknown>) || {};
    const aliases = Array.isArray((meta as any).aliases)
      ? ((meta as any).aliases as Array<{ channel: string; externalId: string }>)
      : [];
    const identities = [
      ...(siblings as any[]).map((s) => ({ channel: s.channel, customerExternalId: s.externalId })),
      ...aliases.map((a) => ({ channel: a.channel as any, customerExternalId: a.externalId })),
    ];

    const empty = {
      contact: { id: (effective as any).id, displayName: (effective as any).displayName ?? null },
      data: [],
      nextCursor: null,
      coverage: CUSTOMER_AUDIT_COVERAGE,
      scope: { identities: identities.length, conversations: 0, conversationScanTruncated: false },
    };
    if (identities.length === 0) {
      res.json(empty);
      return;
    }

    // Both origins named explicitly: `applyLiveByDefault` injects origin LIVE
    // into bulk Conversation reads, so a customer whose history was imported
    // would otherwise have that history excluded from their own audit log.
    const convWhere = {
      tenantId,
      OR: identities,
      origin: { in: ["LIVE", "HISTORICAL_IMPORT"] } as never,
    };
    const [conversationCount, convos] = await Promise.all([
      prisma.conversation.count({ where: convWhere as never }),
      prisma.conversation.findMany({
        where: convWhere as never,
        orderBy: { updatedAt: "desc" },
        take: AUDIT_CONVERSATION_SCAN_CAP,
        select: { id: true },
      }),
    ]);
    const conversationIds = convos.map((c) => c.id);

    const targets: Array<Record<string, unknown>> = [];
    if (conversationIds.length > 0) {
      targets.push({ targetType: "conversation", targetId: { in: conversationIds } });
    }
    if (shopifyCustomerId) {
      targets.push({ targetType: "customer", targetId: shopifyCustomerId });
    }
    if (targets.length === 0) {
      res.json({ ...empty, scope: { identities: identities.length, conversations: conversationCount, conversationScanTruncated: conversationCount > convos.length } });
      return;
    }

    // The tenant-wide filters apply unchanged, so the two screens cannot
    // disagree about what `actorType=ai` means.
    const base = buildWhere(req, tenantId, { includeAction: true });
    const rows = await prisma.auditLog.findMany({
      where: { ...base, OR: targets } as never,
      select: {
        id: true, actorType: true, actorId: true, action: true,
        targetType: true, targetId: true, createdAt: true,
        // Lifted for `succeeded` only, exactly as the tenant-wide list does.
        // The blob itself is never returned: it holds args, and args hold
        // customer phone numbers.
        metadata: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      contact: { id: (effective as any).id, displayName: (effective as any).displayName ?? null },
      data: page.map((r) => ({
        id: r.id,
        actorType: r.actorType,
        actorId: r.actorId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        createdAt: r.createdAt,
        ...outcomeOf(r.action, r.metadata),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      coverage: CUSTOMER_AUDIT_COVERAGE,
      scope: {
        identities: identities.length,
        conversations: conversationCount,
        // The conversation id list becomes an IN clause, so it is capped.
        // Saying so is the difference between a bounded read and a short log.
        conversationScanTruncated: conversationCount > convos.length,
      },
    });
  } catch (err) {
    console.error("customer audit error:", err);
    res.status(500).json({ error: "Failed to read the customer's audit log" });
  }
});

// ─── List · newest first, cursor-paginated ────────────────────
router.get("/audit-logs", CAN_READ, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const bad = badDates(req);
  if (bad.length > 0) {
    res.status(422).json({ error: "Invalid audit filter", details: bad });
    return;
  }
  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;

  try {
    const rows = await prisma.auditLog.findMany({
      where: buildWhere(req, tenantId, { includeAction: true }) as never,
      select: {
        id: true,
        actorType: true,
        actorId: true,
        action: true,
        targetType: true,
        targetId: true,
        createdAt: true,
        // Lifted so the caller can tell an action that worked from one that
        // did not without receiving the blob it lives in. See the header.
        metadata: true,
      },
      // `createdAt` is not unique - a burst of AI calls shares a millisecond -
      // so `id` breaks the tie and keeps the cursor stable across pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      data: page.map((r) => {
        const meta = r.metadata as Record<string, unknown> | null;
        return {
          id: r.id,
          actorType: r.actorType,
          actorId: r.actorId,
          action: r.action,
          // The conversation the action happened in, NOT the business object
          // acted on - the order id lives in metadata.args and has no general
          // shape across tools, so it is not promoted to a field here.
          targetType: r.targetType,
          targetId: r.targetId,
          createdAt: r.createdAt,
          // null when the emitter recorded no verdict, which is different from
          // false: "we did not record whether this worked" is not "it failed".
          succeeded: meta && typeof meta.ok === "boolean" ? meta.ok : null,
        };
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    });
  } catch (err) {
    console.error("audit list error:", err);
    res.status(500).json({ error: "Failed to read the audit log" });
  }
});

/**
 * GET /api/audit-logs/export - the same rows as the screen, as a file.
 *
 * SAME GATE, deliberately. Omer's ruling: "there is no difference between
 * seeing it and exporting it." So it reuses `CAN_READ` rather than inventing a
 * second permission - a separate export gate would imply the export shows more,
 * and it must not.
 *
 * ★ AND IT SHOWS EXACTLY WHAT THE SCREEN SHOWS. `metadata` is NOT exported.
 * The list route omits it because it carries customer phone numbers, and an
 * export carrying it would be a data-exfiltration path with the SAME
 * permission as a screen that does not expose it. Same rows, same columns, a
 * different container - anything else and "no difference between seeing and
 * exporting" stops being true in the direction that matters.
 *
 * `succeeded` is derived here exactly as the list derives it, including the
 * null case: "we did not record whether this worked" is not "it failed", and a
 * spreadsheet column that turns the first into the second would be read as
 * fact by whoever opens it.
 *
 * Streamed in cursor batches rather than one findMany: 6,445 rows on the
 * biggest tenant today, unbounded tomorrow, and the point of an export is that
 * it does not have a page size.
 */
const EXPORT_BATCH = 500;

/**
 * RFC-4180 quoting, plus a leading apostrophe on anything a spreadsheet would
 * execute. A field beginning =, +, - or @ is a formula in Excel and Sheets, so
 * an action name or an actor id that starts with one becomes code the moment
 * someone opens the file. Neutralised here rather than trusted not to occur.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

router.get("/audit-logs/export", CAN_READ, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const bad = badDates(req);
  if (bad.length > 0) {
    res.status(422).json({ error: "Invalid audit filter", details: bad });
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-log-${stamp}.csv"`);
  // The BOM is what makes Excel read this as UTF-8. Without it Hebrew actor
  // names and tenant data arrive as mojibake, which looks like corrupted data
  // rather than a missing byte.
  res.write("\uFEFF");
  res.write(["timestamp", "action", "actor_type", "actor_id", "target_type", "target_id", "succeeded"].join(",") + "\n");

  let cursor: string | null = null;
  let written = 0;
  try {
    for (;;) {
      const rows: any[] = await prisma.auditLog.findMany({
        where: buildWhere(req, tenantId, { includeAction: true }) as never,
        select: {
          id: true, actorType: true, actorId: true, action: true,
          targetType: true, targetId: true, createdAt: true, metadata: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: EXPORT_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;

      for (const r of rows) {
        const meta = r.metadata as Record<string, unknown> | null;
        const succeeded = meta && typeof meta.ok === "boolean" ? meta.ok : null;
        res.write(
          [
            csvCell(r.createdAt.toISOString()),
            csvCell(r.action),
            csvCell(r.actorType),
            csvCell(r.actorId),
            csvCell(r.targetType),
            csvCell(r.targetId),
            // Blank, not "false", when nothing was recorded.
            succeeded === null ? "" : csvCell(succeeded),
          ].join(",") + "\n",
        );
      }
      written += rows.length;
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < EXPORT_BATCH) break;
    }
    res.end();
    console.log(`[audit-export] tenant=${tenantId} rows=${written}`);
  } catch (err) {
    console.error("audit export error:", err);
    // Headers are already sent, so there is no status left to change. End the
    // stream with a marker rather than a silently short file that looks
    // complete - a truncated audit export read as whole is worse than an error.
    res.write("\n\"EXPORT FAILED - this file is incomplete\",,,,,,\n");
    res.end();
  }
});

export default router;
