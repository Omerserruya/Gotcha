/**
 * /api/policy-decisions - what the policy engine decided, and how often.
 *
 * `PolicyDecision` is an append-only record of EVERY policy evaluation, with
 * the decision, the action kind, the tool, the cap that applied and the facts
 * it judged. It has carried correct, complete, indexed data since it was
 * built and no route has ever read it. Screen 03c's "handled without asking
 * you today" and its by-type breakdown are both this table.
 *
 * Unserved, not absent - the distinction matters. Nothing here computes a
 * number that did not exist; it serves one that did.
 *
 * WHAT IS DELIBERATELY NOT RETURNED
 *
 *   `inputFacts` is the evidence a decision was made on - order values,
 *   customer identifiers, amounts. Returning the blob would put customer data
 *   on a screen whose subject is what the engine DECIDED, not who it decided
 *   about. Same shape as `metadata` on the audit log and the same answer:
 *   serve what the screen renders. `matchedRules` and `reasonCodes` are about
 *   the decision rather than the customer, so those do go out.
 *
 * THE WINDOW IS ALWAYS ECHOED BACK
 *
 *   A total means nothing without the period it covers, and "31 actions" read
 *   as all-time when it is this week is the kind of wrong that looks right.
 *   `window` is returned on every response, including when the caller passed
 *   no bounds, so a client can never render a figure without its period.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
} from "@chatcenter/shared";
import { visibilityClause } from "../lib/conversation-visibility";

const router = Router();

router.use(authenticate, resolveTenant, requireActiveTenant());

// Matches the sibling /api/business-policies routes rather than introducing a
// key for a read of the same domain.
const canRead = requirePermissionOrRole("settings:business-policies:read", "ADMIN", "SYSTEM_ADMIN");

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

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

/** One filter builder, so the summary and the list can never disagree. */
function buildWhere(req: Request, tenantId: string, opts: { includeFacets: boolean }) {
  const where: Record<string, unknown> = { tenantId };
  if (opts.includeFacets) {
    const decision = typeof req.query.decision === "string" ? req.query.decision.trim() : "";
    if (decision) where.decision = decision;
    const actionKind = typeof req.query.actionKind === "string" ? req.query.actionKind.trim() : "";
    if (actionKind) where.actionKind = actionKind;
  }
  const from = typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : null;
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }
  return { where, from, to };
}

/**
 * The inbox's visibility rule, applied to decisions (2026-10-09).
 *
 * A decision about a conversation the viewer may not see is not theirs to
 * count or read: the rows carry the conversation id, tool and reason codes,
 * and the summary counts them. So it is filtered in the WHERE, and the list
 * and the summary share it, rather than dropped after the query (which would
 * break the cursor and leave the totals counting what the list hides).
 *
 * PolicyDecision has no relation to Conversation, so the visible ids are
 * resolved first: only among the conversations these decisions name, which
 * keeps the IN list bounded by the window rather than by the tenant. A
 * decision with no conversation (a broadcast, a tenant-level check) is about
 * no thread and stays visible, as an approval with none does.
 *
 * Null for an unrestricted viewer: the where is exactly what it was.
 */
async function visibleDecisionsWhere(
  req: Request,
  tenantId: string,
  where: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const clause = visibilityClause({
    userId: (req as any).user?.userId as string,
    role: (req as any).user?.role as string | undefined,
    departmentId: (req as any).user?.departmentId as string | undefined,
  });
  if (!clause) return null;
  const named = await prisma.policyDecision.findMany({
    where: { ...where, conversationId: { not: null } } as never,
    distinct: ["conversationId"],
    select: { conversationId: true },
  });
  const ids = named.map((r) => r.conversationId).filter((id): id is string => !!id);
  const visible = ids.length === 0 ? [] : await prisma.conversation.findMany({
    where: { tenantId, id: { in: ids }, OR: clause },
    select: { id: true },
  });
  return { OR: [{ conversationId: null }, { conversationId: { in: visible.map((c) => c.id) } }] };
}

/** `where` narrowed to what this viewer may see; unchanged for an unrestricted one. */
async function scopedWhere(req: Request, tenantId: string, where: Record<string, unknown>) {
  const visible = await visibleDecisionsWhere(req, tenantId, where);
  return visible ? { ...where, AND: [visible] } : where;
}

// ─── Summary · the counts screen 03c renders ──────────────────
//
// Mounted above the list for the usual reason: a later `/:id` would capture
// "summary" as an id and 404 a path that exists.
//
// Both group-bys are served by indexes that already exist -
// @@index([tenantId, actionKind]) and @@index([tenantId, createdAt]) - so this
// is a read over existing data rather than a scan.
router.get("/summary", canRead, async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const bad = badDates(req);
  if (bad.length > 0) {
    res.status(422).json({ error: "Invalid policy-decision filter", details: bad });
    return;
  }
  try {
    const built = buildWhere(req, tenantId, { includeFacets: false });
    const { from, to } = built;
    const where = await scopedWhere(req, tenantId, built.where);
    const [total, byDecision, byActionKind] = await Promise.all([
      prisma.policyDecision.count({ where: where as never }),
      prisma.policyDecision.groupBy({
        by: ["decision"],
        where: where as never,
        _count: { _all: true },
      }),
      prisma.policyDecision.groupBy({
        by: ["actionKind", "decision"],
        where: where as never,
        _count: { _all: true },
      }),
    ]);
    res.json({
      data: {
        total,
        byDecision: byDecision.map((r) => ({ decision: r.decision, count: r._count._all })),
        byActionKind: byActionKind.map((r) => ({
          actionKind: r.actionKind,
          decision: r.decision,
          count: r._count._all,
        })),
      },
      // Always present, bounds included even when the caller passed none, so a
      // total can never be rendered without the period it covers. A zero here
      // is a fact about the window, not a failure - the engine records only
      // what it evaluated, and a quiet week really is zero.
      window: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
    });
  } catch (err) {
    console.error("policy-decision summary error:", err);
    res.status(500).json({ error: "Failed to summarise policy decisions" });
  }
});

// ─── List · newest first, cursor-paginated ────────────────────
router.get("/", canRead, async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const bad = badDates(req);
  if (bad.length > 0) {
    res.status(422).json({ error: "Invalid policy-decision filter", details: bad });
    return;
  }
  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;

  try {
    const built = buildWhere(req, tenantId, { includeFacets: true });
    const { from, to } = built;
    const where = await scopedWhere(req, tenantId, built.where);
    const rows = await prisma.policyDecision.findMany({
      where: where as never,
      select: {
        id: true,
        decision: true,
        actionKind: true,
        evaluationPoint: true,
        tool: true,
        maxAmount: true,
        matchedRules: true,
        reasonCodes: true,
        policyId: true,
        policyVersion: true,
        conversationId: true,
        aiEmployeeId: true,
        createdAt: true,
        // inputFacts is NOT selected - see the header. It is the customer data
        // the decision was made about, and this screen is about the decision.
      },
      // createdAt is not unique - a burst of evaluations shares a millisecond -
      // so id breaks the tie and keeps the cursor stable across pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      data: page,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      window: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
    });
  } catch (err) {
    console.error("policy-decision list error:", err);
    res.status(500).json({ error: "Failed to read policy decisions" });
  }
});

export default router;
