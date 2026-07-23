import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireRole } from "@chatcenter/shared";
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

router.get("/dashboard", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const stats = await analyticsService.getDashboardStats(req.tenantId!);
    res.json({ data: stats });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ error: "Failed to get dashboard stats" });
  }
});

router.get("/agents", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const stats = await analyticsService.getAgentStats(req.tenantId!);
    res.json({ data: stats });
  } catch (err) {
    console.error("Agent stats error:", err);
    res.status(500).json({ error: "Failed to get agent stats" });
  }
});

router.get("/hourly", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const date = req.query.date as string | undefined;
    const data = await analyticsService.getHourlyVolume(req.tenantId!, date);
    res.json({ data });
  } catch (err) {
    console.error("Hourly stats error:", err);
    res.status(500).json({ error: "Failed to get hourly stats" });
  }
});

router.get("/daily", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
    const data = await analyticsService.getDailyVolume(req.tenantId!, days);
    res.json({ data });
  } catch (err) {
    console.error("Daily stats error:", err);
    res.status(500).json({ error: "Failed to get daily stats" });
  }
});

router.get("/queue", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const data = await analyticsService.getQueueDepth(req.tenantId!);
    res.json({ data });
  } catch (err) {
    console.error("Queue stats error:", err);
    res.status(500).json({ error: "Failed to get queue stats" });
  }
});

router.get("/overview", requireRole("ADMIN"), async (req: Request, res: Response) => {
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

router.get("/top-questions", requireRole("ADMIN"), async (req: Request, res: Response) => {
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

router.get("/tool-usage", requireRole("ADMIN"), async (req: Request, res: Response) => {
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

router.get("/channel-performance", requireRole("ADMIN"), async (req: Request, res: Response) => {
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

router.get("/department-performance", requireRole("ADMIN"), async (req: Request, res: Response) => {
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

router.get("/ai-performance", requireRole("ADMIN"), async (req: Request, res: Response) => {
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

router.get("/insights", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const data = await analyticsService.getAIInsights(req.tenantId!);
    res.json({ data });
  } catch (err) {
    console.error("AI insights error:", err);
    res.status(500).json({ error: "Failed to get AI insights" });
  }
});

export default router;
