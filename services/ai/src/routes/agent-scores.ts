import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { getAgentOverview } from "../services/agent-scoring.service";

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

// GET / — get scores for all agents (admin)
router.get("/", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { from, to, agentId } = req.query;
    const where: any = { tenantId: req.tenantId! };
    if (agentId) where.agentId = agentId as string;
    if (from || to) {
      where.analyzedAt = {};
      if (from) where.analyzedAt.gte = new Date(from as string);
      if (to) where.analyzedAt.lte = new Date(to as string);
    }
    const scores = await prisma.agentScore.findMany({
      where,
      orderBy: { analyzedAt: "desc" },
    });
    res.json({ data: scores });
  } catch (err) {
    console.error("List agent scores error:", err);
    res.status(500).json({ error: "Failed to list agent scores" });
  }
});

// GET /:agentId — get overview for specific agent
router.get("/:agentId", async (req: Request, res: Response) => {
  try {
    const agentId = req.params.agentId as string;
    const { from, to } = req.query;

    // Verify agent belongs to this tenant
    const agent = await prisma.user.findFirst({
      where: { id: agentId, tenantId: req.tenantId! },
      select: { id: true, name: true, email: true },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const overview = await getAgentOverview(
      req.tenantId!,
      agentId,
      from as string | undefined,
      to as string | undefined
    );
    res.json({ data: { agent, ...overview } });
  } catch (err) {
    console.error("Agent overview error:", err);
    res.status(500).json({ error: "Failed to get agent overview" });
  }
});

// GET /:agentId/history — get score history
router.get("/:agentId/history", async (req: Request, res: Response) => {
  try {
    const agentId = req.params.agentId as string;
    const { from, to, limit } = req.query;

    const agent = await prisma.user.findFirst({
      where: { id: agentId, tenantId: req.tenantId! },
      select: { id: true, name: true },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const where: any = { tenantId: req.tenantId!, agentId };
    if (from || to) {
      where.analyzedAt = {};
      if (from) where.analyzedAt.gte = new Date(from as string);
      if (to) where.analyzedAt.lte = new Date(to as string);
    }

    const scores = await prisma.agentScore.findMany({
      where,
      orderBy: { analyzedAt: "desc" },
      take: limit ? parseInt(limit as string, 10) : 50,
    });
    res.json({ data: scores });
  } catch (err) {
    console.error("Agent score history error:", err);
    res.status(500).json({ error: "Failed to get score history" });
  }
});

export default router;
