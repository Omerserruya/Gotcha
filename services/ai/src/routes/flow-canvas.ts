import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";

const router = Router();

const DEFAULT_CANVAS = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

// ─── Get Flow Canvas ─────────────────────────────────────────
router.get("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;

    const [canvas, channelAccounts, routerRules, chatbotFlows, aiAgents, departments] = await Promise.all([
      prisma.flowCanvas.findUnique({ where: { tenantId } }),
      prisma.channelAccount.findMany({
        where: { tenantId },
        select: { id: true, channel: true, displayName: true, connectionStatus: true },
      }),
      prisma.routerRule.findMany({
        where: { tenantId },
        select: { id: true, name: true, routeType: true, routeTarget: true, enabled: true, priority: true },
      }),
      prisma.chatbotFlow.findMany({
        where: { tenantId },
        select: { id: true, name: true, isActive: true, channel: true },
      }),
      prisma.aIAgent.findMany({
        where: { tenantId },
        select: { id: true, name: true, status: true },
      }),
      prisma.department.findMany({
        where: { tenantId },
        select: { id: true, name: true, isActive: true },
      }),
    ]);

    const canvasData = canvas
      ? { nodes: canvas.nodes, edges: canvas.edges, viewport: canvas.viewport ?? DEFAULT_CANVAS.viewport }
      : DEFAULT_CANVAS;

    res.json({
      data: {
        ...canvasData,
        relatedData: { channelAccounts, routerRules, chatbotFlows, aiAgents, departments },
      },
    });
  } catch (err) {
    console.error("Get flow canvas error:", err);
    res.status(500).json({ error: "Failed to get flow canvas" });
  }
});

// ─── Save Flow Canvas ────────────────────────────────────────
router.put("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const { nodes, edges, viewport } = req.body;

    const canvas = await prisma.flowCanvas.upsert({
      where: { tenantId },
      create: {
        tenantId,
        nodes: nodes ?? [],
        edges: edges ?? [],
        viewport: viewport ?? DEFAULT_CANVAS.viewport,
        updatedBy: req.user?.userId ?? null,
      },
      update: {
        nodes: nodes ?? [],
        edges: edges ?? [],
        viewport: viewport ?? DEFAULT_CANVAS.viewport,
        updatedBy: req.user?.userId ?? null,
      },
    });

    res.json({ data: canvas });
  } catch (err) {
    console.error("Save flow canvas error:", err);
    res.status(500).json({ error: "Failed to save flow canvas" });
  }
});

// ─── Auto-generate Canvas Layout ─────────────────────────────
router.post("/auto-generate", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;

    const [channelAccounts, routerRules, chatbotFlows, aiAgents, departments] = await Promise.all([
      prisma.channelAccount.findMany({
        where: { tenantId },
        select: { id: true, channel: true, displayName: true, connectionStatus: true },
      }),
      prisma.routerRule.findMany({
        where: { tenantId },
        select: { id: true, name: true, routeType: true, routeTarget: true, enabled: true, priority: true },
        orderBy: { priority: "asc" },
      }),
      prisma.chatbotFlow.findMany({
        where: { tenantId },
        select: { id: true, name: true, isActive: true, channel: true },
      }),
      prisma.aIAgent.findMany({
        where: { tenantId },
        select: { id: true, name: true, status: true },
      }),
      prisma.department.findMany({
        where: { tenantId },
        select: { id: true, name: true, isActive: true },
      }),
    ]);

    // Column X positions
    const COL_CHANNELS = 100;
    const COL_RULES    = 450;
    const COL_FLOWS    = 450;
    const COL_HANDLERS = 800;
    const ROW_GAP      = 120;

    const nodes: any[] = [];
    const edges: any[] = [];

    // Column 1 – channel nodes
    channelAccounts.forEach((ch, i) => {
      nodes.push({
        id: `channel-${ch.id}`,
        type: "channel",
        position: { x: COL_CHANNELS, y: i * ROW_GAP + 80 },
        data: { ...ch },
      });
    });

    // Column 2 – router rule nodes
    routerRules.forEach((rule, i) => {
      nodes.push({
        id: `rule-${rule.id}`,
        type: "rule",
        position: { x: COL_RULES, y: i * ROW_GAP + 80 },
        data: { ...rule },
      });
    });

    // Column 2 (below rules) – chatbot flow nodes
    const flowOffset = routerRules.length;
    chatbotFlows.forEach((flow, i) => {
      nodes.push({
        id: `flow-${flow.id}`,
        type: "flow",
        position: { x: COL_FLOWS, y: (flowOffset + i) * ROW_GAP + 80 },
        data: { ...flow },
      });
    });

    // Column 3 – AI agent handler nodes
    aiAgents.forEach((agent, i) => {
      nodes.push({
        id: `agent-${agent.id}`,
        type: "agent",
        position: { x: COL_HANDLERS, y: i * ROW_GAP + 80 },
        data: { ...agent },
      });
    });

    // Column 3 (below agents) – department nodes
    const deptOffset = aiAgents.length;
    departments.forEach((dept, i) => {
      nodes.push({
        id: `department-${dept.id}`,
        type: "department",
        position: { x: COL_HANDLERS, y: (deptOffset + i) * ROW_GAP + 80 },
        data: { ...dept },
      });
    });

    // Edges: channel → rule (connect all channels to all rules as a routing fan-out)
    channelAccounts.forEach((ch) => {
      routerRules.forEach((rule) => {
        edges.push({
          id: `edge-channel-${ch.id}-rule-${rule.id}`,
          source: `channel-${ch.id}`,
          target: `rule-${rule.id}`,
          data: {},
        });
      });
    });

    // Edges: rule → target (agent or flow or department)
    routerRules.forEach((rule) => {
      if (!rule.routeTarget) return;

      if (rule.routeType === "AI_AGENT") {
        const targetNode = `agent-${rule.routeTarget}`;
        if (nodes.find((n) => n.id === targetNode)) {
          edges.push({
            id: `edge-rule-${rule.id}-agent-${rule.routeTarget}`,
            source: `rule-${rule.id}`,
            target: targetNode,
            data: { routeType: rule.routeType },
          });
        }
      } else if (rule.routeType === "FLOW") {
        const targetNode = `flow-${rule.routeTarget}`;
        if (nodes.find((n) => n.id === targetNode)) {
          edges.push({
            id: `edge-rule-${rule.id}-flow-${rule.routeTarget}`,
            source: `rule-${rule.id}`,
            target: targetNode,
            data: { routeType: rule.routeType },
          });
        }
      } else if (rule.routeType === "DEPARTMENT") {
        const targetNode = `department-${rule.routeTarget}`;
        if (nodes.find((n) => n.id === targetNode)) {
          edges.push({
            id: `edge-rule-${rule.id}-dept-${rule.routeTarget}`,
            source: `rule-${rule.id}`,
            target: targetNode,
            data: { routeType: rule.routeType },
          });
        }
      }
    });

    const viewport = DEFAULT_CANVAS.viewport;

    // Persist the generated canvas
    const canvas = await prisma.flowCanvas.upsert({
      where: { tenantId },
      create: { tenantId, nodes, edges, viewport, updatedBy: req.user?.userId ?? null },
      update: { nodes, edges, viewport, updatedBy: req.user?.userId ?? null },
    });

    res.json({ data: canvas });
  } catch (err) {
    console.error("Auto-generate flow canvas error:", err);
    res.status(500).json({ error: "Failed to auto-generate flow canvas" });
  }
});

export default router;
