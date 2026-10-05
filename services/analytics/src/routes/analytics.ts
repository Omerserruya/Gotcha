import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireRole, requirePermission } from "@chatcenter/shared";
import * as analyticsService from "../services/analytics.service";

const router = Router();
router.use(authenticate, resolveTenant);

// ─── Product events (guided tour, setup checklist, empty-state CTAs,
// outbound calling) ─────────────────────────────────────────────────
// Open to every authenticated tenant member (agents run the tour and place
// calls too). Attribution is server-side only: tenant comes from the resolved
// membership, user from the verified token - a client-sent tenant id is
// ignored by construction. Events are emitted as structured logs (one line
// per event, greppable/shippable); there is deliberately no DB table yet.
const EVENT_NAME = /^[a-z][a-z0-9_.:-]{0,63}$/i;
router.post("/events", async (req: Request, res: Response) => {
  const { event, props } = (req.body || {}) as { event?: unknown; props?: unknown };
  if (typeof event !== "string" || !EVENT_NAME.test(event)) {
    res.status(400).json({ error: "Invalid event name" });
    return;
  }
  let safeProps: Record<string, unknown> = {};
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const raw = JSON.stringify(props);
    if (raw.length <= 2048) safeProps = props as Record<string, unknown>;
  }
  console.log(
    JSON.stringify({
      type: "product_event",
      event,
      props: safeProps,
      tenantId: req.tenantId,
      userId: (req as any).user?.id ?? null,
      at: new Date().toISOString(),
    }),
  );
  res.json({ data: { ok: true } });
});

router.get("/dashboard", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const stats = await analyticsService.getDashboardStats(req.tenantId!);
    res.json({ data: stats });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ error: "Failed to get dashboard stats" });
  }
});

router.get("/agents", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const stats = await analyticsService.getAgentStats(req.tenantId!);
    res.json({ data: stats });
  } catch (err) {
    console.error("Agent stats error:", err);
    res.status(500).json({ error: "Failed to get agent stats" });
  }
});

router.get("/hourly", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const date = req.query.date as string | undefined;
    const data = await analyticsService.getHourlyVolume(req.tenantId!, date);
    res.json({ data });
  } catch (err) {
    console.error("Hourly stats error:", err);
    res.status(500).json({ error: "Failed to get hourly stats" });
  }
});

router.get("/daily", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
    const data = await analyticsService.getDailyVolume(req.tenantId!, days);
    res.json({ data });
  } catch (err) {
    console.error("Daily stats error:", err);
    res.status(500).json({ error: "Failed to get daily stats" });
  }
});

router.get("/queue", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const data = await analyticsService.getQueueDepth(req.tenantId!);
    res.json({ data });
  } catch (err) {
    console.error("Queue stats error:", err);
    res.status(500).json({ error: "Failed to get queue stats" });
  }
});

/**
 * The ranked queue behind Home's "needs you now".
 *
 * NOT requireRole("ADMIN"): this is the list an agent works from, and the
 * conversations in it are unassigned ones any member could pick up. Every
 * other route here is a management report, which is why they are admin-gated.
 */
router.get("/queue/items", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await analyticsService.getQueueItems(req.tenantId!, { limit, cursor });
    res.json(result);
  } catch (err) {
    console.error("Queue items error:", err);
    res.status(500).json({ error: "Failed to get queue items" });
  }
});

/**
 * The time-ordered activity stream behind Home's activity card.
 *
 * Open to every tenant member for the same reason as the queue: an agent needs
 * to see that a refund is awaiting approval before they promise one.
 */
router.get("/activity", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await analyticsService.getActivity(req.tenantId!, { limit, cursor });
    res.json(result);
  } catch (err) {
    console.error("Activity stream error:", err);
    res.status(500).json({ error: "Failed to get activity" });
  }
});

/**
 * Seconds the AI saved, with the arithmetic attached. Any tenant member: it is
 * a headline on Home, not a management report.
 */
router.get("/time-saved", async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await analyticsService.getTimeSaved(req.tenantId!, from, to);
    res.json({ data });
  } catch (err) {
    console.error("Time saved error:", err);
    res.status(500).json({ error: "Failed to get time saved" });
  }
});

// 06c Team: people + AI employees, with the cards above them.
router.get("/team", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days ?? 7);
    res.json({ data: await analyticsService.getTeamReport(req.tenantId!, days) });
  } catch (err) {
    console.error("Team report error:", err);
    res.status(500).json({ error: "Failed to get team report" });
  }
});

// Per-day series for the Overview chart (gotcha/team) and 06b (alone/passedOver).
// NOT "/daily": that path already serves getDailyVolume to the old app (above),
// and Express answers the first registration - this one never ran there.
router.get("/daily-series", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days ?? 7);
    res.json({ data: await analyticsService.getDailySeries(req.tenantId!, days) });
  } catch (err) {
    console.error("Daily series error:", err);
    res.status(500).json({ error: "Failed to get daily series" });
  }
});

router.get("/overview", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await analyticsService.getOverview(req.tenantId!, from, to);
    res.json({ data });
  } catch (err) {
    console.error("Overview stats error:", err);
    res.status(500).json({ error: "Failed to get overview stats" });
  }
});

router.get("/top-questions", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const data = await analyticsService.getTopQuestions(req.tenantId!, from, to, limit);
    res.json({ data });
  } catch (err) {
    console.error("Top questions error:", err);
    res.status(500).json({ error: "Failed to get top questions" });
  }
});

router.get("/tool-usage", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await analyticsService.getToolUsageStats(req.tenantId!, from, to);
    res.json({ data });
  } catch (err) {
    console.error("Tool usage stats error:", err);
    res.status(500).json({ error: "Failed to get tool usage stats" });
  }
});

/**
 * GET /language-share - the language mix of recent conversations.
 *
 * Gated on EITHER permission, deliberately. It is read by the workspace
 * language settings screen, whose admins hold `settings:workspace:read`, and it
 * belongs in analytics because that is what owns conversation aggregates. Gating
 * it on the analytics permission alone would ship an endpoint the screen that
 * needs it cannot call.
 */
router.get(
  "/language-share",
  requirePermission("settings:workspace:read", "analytics:workspace:read"),
  async (req: Request, res: Response) => {
    try {
      const raw = Number(req.query.days);
      // Bounded rather than trusted: an unbounded window turns a settings panel
      // into a full-table scan, and a nonsense value should not decide the query.
      const days = Number.isFinite(raw) && raw > 0 ? Math.min(365, Math.round(raw)) : 30;
      res.json({ data: await analyticsService.getLanguageShare(req.tenantId!, days) });
    } catch (err) {
      console.error("Language share error:", err);
      res.status(500).json({ error: "Failed to get language share" });
    }
  },
);

router.get("/channel-performance", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await analyticsService.getChannelPerformance(req.tenantId!, from, to);
    res.json({ data });
  } catch (err) {
    console.error("Channel performance error:", err);
    res.status(500).json({ error: "Failed to get channel performance" });
  }
});

router.get("/department-performance", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await analyticsService.getDepartmentPerformance(req.tenantId!, from, to);
    res.json({ data });
  } catch (err) {
    console.error("Department performance error:", err);
    res.status(500).json({ error: "Failed to get department performance" });
  }
});

router.get("/ai-performance", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const data = await analyticsService.getAIPerformance(req.tenantId!, from, to);
    res.json({ data });
  } catch (err) {
    console.error("AI performance error:", err);
    res.status(500).json({ error: "Failed to get AI performance" });
  }
});

router.get("/insights", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const data = await analyticsService.getAIInsights(req.tenantId!);
    res.json({ data });
  } catch (err) {
    console.error("AI insights error:", err);
    res.status(500).json({ error: "Failed to get AI insights" });
  }
});

/**
 * Hide an insight. The "Worth knowing" card is informational - a trend and a
 * Dismiss - and this is the whole of its interaction. Anything that ACTS on an
 * insight belongs in Outreach, behind broadcast validation, template approval
 * and audience preview, not behind a second send path with none of them.
 *
 * ADMIN, unlike the queue and the activity stream: dismissing hides the card
 * for everyone in the tenant, so it is not one agent's call.
 */
router.post("/insights/:id/dismiss", requirePermission("analytics:dashboard:read"), async (req: Request, res: Response) => {
  try {
    const insightId = String(req.params.id ?? "").trim();
    if (!insightId || insightId.length > 128) {
      res.status(400).json({ error: "Invalid insight id" });
      return;
    }
    await analyticsService.dismissInsight(req.tenantId!, insightId, (req as any).user?.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Dismiss insight error:", err);
    res.status(500).json({ error: "Failed to dismiss insight" });
  }
});

/**
 * "Worth an hour, while it is quiet" - the four sources in one ranked list.
 *
 * Ranked server-side so Home and any other surface showing this list cannot
 * order it differently.
 */
router.get("/quiet-day", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const result = await analyticsService.getQuietDayList(req.tenantId!, { limit });
    res.json(result);
  } catch (err) {
    console.error("Quiet-day list error:", err);
    res.status(500).json({ error: "Failed to build quiet-day list" });
  }
});

/**
 * What the AI is doing at this instant - the dark card's opening line.
 *
 * Part of the shared operational picture, so it rides the same permission as
 * the queue rather than the reporting one.
 */
router.get("/in-flight", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const data = await analyticsService.getInFlight(req.tenantId!);
    res.json({ data });
  } catch (err) {
    console.error("In-flight error:", err);
    res.status(500).json({ error: "Failed to get in-flight summary" });
  }
});

/**
 * Questions GOTCHA could not answer. Any tenant member: the point of the card
 * is that whoever sees it can go and write the missing answer.
 */
router.get("/unanswered-questions", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const includeResolved = req.query.includeResolved === "true";
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const result = await analyticsService.getUnansweredQuestions(req.tenantId!, {
      limit, includeResolved, from, to,
    });
    res.json(result);
  } catch (err) {
    console.error("Unanswered questions error:", err);
    res.status(500).json({ error: "Failed to get unanswered questions" });
  }
});

/** What shoppers asked the catalogue for, by ISO week. */
router.get("/product-demand", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const weekKey = typeof req.query.week === "string" ? req.query.week : undefined;
    const includeStocked = req.query.includeStocked === "true";
    const result = await analyticsService.getProductDemand(req.tenantId!, { limit, weekKey, includeStocked });
    res.json(result);
  } catch (err) {
    console.error("Product demand error:", err);
    res.status(500).json({ error: "Failed to get product demand" });
  }
});

/**
 * Customers who have gone quiet. ADMIN: this is a list of named customers with
 * their phone numbers, which is a different thing from a queue of conversations
 * already assigned to nobody, and it is the input to an outreach decision.
 */
router.get("/dormant-customers", requirePermission("analytics:workspace:read"), async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const days = req.query.days ? parseInt(req.query.days as string, 10) : undefined;
    const minConversations = req.query.minConversations
      ? parseInt(req.query.minConversations as string, 10)
      : undefined;
    const result = await analyticsService.getDormantCustomers(req.tenantId!, { limit, days, minConversations });
    res.json(result);
  } catch (err) {
    console.error("Dormant customers error:", err);
    res.status(500).json({ error: "Failed to get dormant customers" });
  }
});

export default router;
