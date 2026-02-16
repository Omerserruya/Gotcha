import { Router, Request, Response } from "express";
import { authenticate, resolveTenant, requireRole } from "@chatcenter/shared";
import * as analyticsService from "../services/analytics.service";

const router = Router();
router.use(authenticate, resolveTenant);

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

export default router;
