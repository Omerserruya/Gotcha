import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

// ─── List Router Rules (ordered by priority) ─────────────────
router.get("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const rules = await prisma.routerRule.findMany({
      where: { tenantId: req.tenantId! as string },
      include: {
        aiAgent: { select: { id: true, name: true, role: true, status: true } },
      },
      orderBy: { priority: "asc" },
    });

    // Enrich flow targets with names
    const flowIds = rules
      .filter(r => r.routeType === "FLOW" && r.routeTarget)
      .map(r => r.routeTarget!);

    const flows = flowIds.length > 0
      ? await prisma.chatbotFlow.findMany({
          where: { id: { in: flowIds } },
          select: { id: true, name: true },
        })
      : [];

    const flowMap = new Map(flows.map(f => [f.id, f.name]));

    const enriched = rules.map(rule => ({
      ...rule,
      routeTargetName: rule.routeType === "AI_AGENT" && rule.aiAgent
        ? rule.aiAgent.name
        : rule.routeType === "FLOW" && rule.routeTarget
        ? flowMap.get(rule.routeTarget) || rule.routeTarget
        : rule.routeTarget || "Unassigned",
    }));

    res.json({ data: enriched });
  } catch (err) {
    console.error("List router rules error:", err);
    res.status(500).json({ error: "Failed to list router rules" });
  }
});

// ─── Get Router Rule by ID ───────────────────────────────────
router.get("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const rule = await prisma.routerRule.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
      include: {
        aiAgent: { select: { id: true, name: true, role: true } },
      },
    });

    if (!rule) {
      res.status(404).json({ error: "Router rule not found" });
      return;
    }

    res.json({ data: rule });
  } catch (err) {
    console.error("Get router rule error:", err);
    res.status(500).json({ error: "Failed to get router rule" });
  }
});

// ─── Create Router Rule ──────────────────────────────────────
router.post("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { name, conditions, logic, routeType, routeTarget, enabled, isDefault } = req.body;

    if (!name || !routeType) {
      res.status(400).json({ error: "Name and routeType are required" });
      return;
    }

    // Get next priority
    const maxPriority = await prisma.routerRule.aggregate({
      where: { tenantId: req.tenantId! as string },
      _max: { priority: true },
    });
    const nextPriority = (maxPriority._max.priority ?? 0) + 1;

    // Determine aiAgentId for the relation
    const aiAgentId = routeType === "AI_AGENT" ? routeTarget : null;

    const rule = await prisma.routerRule.create({
      data: {
        tenantId: req.tenantId! as string,
        priority: nextPriority,
        name,
        conditions: conditions || [],
        logic: logic || "AND",
        routeType,
        routeTarget: routeTarget || null,
        aiAgentId,
        enabled: enabled !== false,
        isDefault: isDefault || false,
      },
    });

    res.status(201).json({ data: rule });
  } catch (err) {
    console.error("Create router rule error:", err);
    res.status(500).json({ error: "Failed to create router rule" });
  }
});

// ─── Update Router Rule ──────────────────────────────────────
router.patch("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.routerRule.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Router rule not found" });
      return;
    }

    const updateData = { ...req.body };

    // Sync aiAgentId with routeTarget when routeType is AI_AGENT
    if (updateData.routeType === "AI_AGENT" && updateData.routeTarget) {
      updateData.aiAgentId = updateData.routeTarget;
    } else if (updateData.routeType && updateData.routeType !== "AI_AGENT") {
      updateData.aiAgentId = null;
    }

    const rule = await prisma.routerRule.update({
      where: { id: req.params.id as string },
      data: updateData,
    });

    res.json({ data: rule });
  } catch (err) {
    console.error("Update router rule error:", err);
    res.status(500).json({ error: "Failed to update router rule" });
  }
});

// ─── Reorder Router Rules ────────────────────────────────────
router.put("/reorder", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { ruleIds } = req.body;

    if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
      res.status(400).json({ error: "ruleIds array is required" });
      return;
    }

    // Verify all rules belong to this tenant
    const rules = await prisma.routerRule.findMany({
      where: { tenantId: req.tenantId! as string, id: { in: ruleIds } },
      select: { id: true },
    });

    if (rules.length !== ruleIds.length) {
      res.status(400).json({ error: "Some rule IDs are invalid" });
      return;
    }

    // Update priorities in a transaction
    await prisma.$transaction(
      ruleIds.map((id: string, index: number) =>
        prisma.routerRule.update({
          where: { id },
          data: { priority: index + 1 },
        })
      )
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Reorder router rules error:", err);
    res.status(500).json({ error: "Failed to reorder router rules" });
  }
});

// ─── Delete Router Rule ──────────────────────────────────────
router.delete("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.routerRule.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Router rule not found" });
      return;
    }

    if (existing.isDefault) {
      res.status(409).json({ error: "Cannot delete the default fallback rule" });
      return;
    }

    await prisma.routerRule.delete({ where: { id: req.params.id as string } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete router rule error:", err);
    res.status(500).json({ error: "Failed to delete router rule" });
  }
});

export default router;
