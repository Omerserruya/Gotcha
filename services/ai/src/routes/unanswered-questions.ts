/**
 * GET /api/knowledge/unanswered-questions - what customers asked that the AI
 * could not answer.
 *
 * Screen 08's centrepiece. The table has been written since it was built
 * (knowledge-gaps.ts) and read by analytics, and no route has ever served it
 * to the people who could answer the questions.
 *
 * UNSERVED, NOT ABSENT: nothing here computes anything new. It serves rows
 * that exist, clustered by a key the writer already maintains, using the two
 * indexes that are already on the table.
 *
 * TWO COUNTS, AND THEY ARE DIFFERENT FACTS.
 *   askCount  how many TIMES the cluster was asked
 *   askedBy   how many DIFFERENT people asked it
 * One person asking eleven times is a confused customer; eleven people asking
 * once is a missing page. The design asked only for frequency; returning both
 * is what lets the screen tell those apart, so they are named distinctly
 * rather than collapsed into a single "count".
 *
 * `resolvedAt` decides open versus answered. It is returned raw rather than as
 * a boolean so the screen can say WHEN something was answered, and so a caller
 * cannot mistake "not answered" for "no data".
 *
 * WHAT IS NOT RETURNED: `clusterKey`. It is the writer's dedup handle - a
 * normalised form of the question used to merge repeats - and it is internal
 * machinery, not something a reader needs. `question` IS returned, because it
 * is the entire point of the screen: the customer's own words are what the
 * owner reads in order to answer them.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermissionOrRole,
} from "@chatcenter/shared";

const router = Router();

// Matches the knowledge routes this belongs beside rather than introducing a
// key for one read.
router.use(
  "/knowledge/unanswered-questions",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requirePermissionOrRole("ai:knowledge:read", "ADMIN"),
);

const VALID_REASONS = new Set(["no_knowledge", "low_confidence", "conflicting"]);

router.get("/knowledge/unanswered-questions", async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;

  const details: Array<{ field: string; message: string }> = [];
  for (const f of ["from", "to"] as const) {
    const raw = req.query[f];
    if (typeof raw === "string" && raw && Number.isNaN(new Date(raw).getTime())) {
      details.push({ field: f, message: `${f} must be an ISO-8601 date` });
    }
  }
  const reason = typeof req.query.reason === "string" ? req.query.reason.trim() : "";
  if (reason && !VALID_REASONS.has(reason)) {
    details.push({ field: "reason", message: `must be one of ${[...VALID_REASONS].join(", ")}` });
  }
  const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
  if (statusParam && statusParam !== "open" && statusParam !== "answered") {
    details.push({ field: "status", message: "must be open or answered" });
  }
  if (details.length > 0) {
    res.status(422).json({ error: "Invalid unanswered-question filter", details });
    return;
  }

  const from = typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : null;

  const where: Record<string, unknown> = { tenantId };
  if (reason) where.reason = reason;
  // Both sides are index-served by @@index([tenantId, resolvedAt]).
  if (statusParam === "open") where.resolvedAt = null;
  else if (statusParam === "answered") where.resolvedAt = { not: null };
  // Windowed on lastAskedAt, not firstAskedAt: "what is being asked now"
  // is the question this screen answers, and a cluster first raised in March
  // and still being asked today belongs in this week.
  if (from || to) {
    where.lastAskedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;

  try {
    const rows = await prisma.unansweredQuestion.findMany({
      where: where as never,
      select: {
        id: true,
        question: true,
        reason: true,
        askCount: true,
        askedBy: true,
        firstAskedAt: true,
        lastAskedAt: true,
        resolvedAt: true,
        // clusterKey deliberately omitted - see the header.
      },
      // Most-recently-asked first: the screen is a work queue, not an archive.
      // lastAskedAt is not unique, so id breaks the tie and keeps the cursor
      // stable across pages.
      orderBy: [{ lastAskedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      data: page.map((r) => ({
        id: r.id,
        question: r.question,
        reason: r.reason,
        // Named for what each one is. `askCount` and `askedBy` are different
        // facts and a screen that collapses them cannot tell a confused
        // customer from a missing page.
        timesAsked: r.askCount,
        distinctAskers: r.askedBy,
        firstAskedAt: r.firstAskedAt,
        lastAskedAt: r.lastAskedAt,
        resolvedAt: r.resolvedAt,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      // Always echoed, bounds included when absent, so an empty page cannot be
      // read as "nothing was ever asked" when it means "nothing in this window".
      window: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
    });
  } catch (err) {
    console.error("unanswered-questions list error:", err);
    res.status(500).json({ error: "Failed to read unanswered questions" });
  }
});

export default router;
