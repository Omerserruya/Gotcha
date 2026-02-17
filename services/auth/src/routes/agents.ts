import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, resolveTenant, requireRole, validate, getRedis } from "@chatcenter/shared";
import * as authService from "../services/auth.service";

const router = Router();
router.use(authenticate, resolveTenant);

router.get("/", async (req: Request, res: Response) => {
  try {
    const agents = await prisma.user.findMany({
      where: { tenantId: req.tenantId!, role: "AGENT" },
      select: {
        id: true, name: true, email: true, isActive: true, createdAt: true,
        _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
      },
    });
    res.json(agents);
  } catch (err) {
    console.error("List agents error:", err);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

// Register a new agent (admin only)
const createAgentSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

router.post("/", requireRole("ADMIN"), validate(createAgentSchema), async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;
    const result = await authService.register(req.tenantId!, email, password, name, "AGENT");
    res.status(201).json(result);
  } catch (err: any) {
    if (err.message?.includes("already exists")) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("Create agent error:", err);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/:id", requireRole("ADMIN"), validate(updateAgentSchema), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.user.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId!, role: "AGENT" },
    });
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    const updated = await prisma.user.update({
      where: { id: req.params.id as string },
      data: req.body,
      select: { id: true, name: true, email: true, isActive: true },
    });
    res.json(updated);
  } catch (err) {
    console.error("Update agent error:", err);
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// Auto-greeting settings
router.get("/settings/auto-greeting", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    const template = await redis.get(`tenant:${req.tenantId!}:autoGreeting`) || "";
    res.json({ template });
  } catch (err) {
    console.error("Get auto-greeting error:", err);
    res.status(500).json({ error: "Failed to get auto-greeting settings" });
  }
});

router.put("/settings/auto-greeting", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { template } = req.body;
    const redis = getRedis();
    if (template) {
      await redis.set(`tenant:${req.tenantId!}:autoGreeting`, template);
    } else {
      await redis.del(`tenant:${req.tenantId!}:autoGreeting`);
    }
    res.json({ template: template || "" });
  } catch (err) {
    console.error("Update auto-greeting error:", err);
    res.status(500).json({ error: "Failed to update auto-greeting settings" });
  }
});

// ─── Co-Pilot Settings ──────────────────────────────────────

const copilotSettingsSchema = z.object({
  systemPrompt: z.string().optional(),
  rules: z.array(z.string()).optional(),
  tools: z.array(z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    config: z.record(z.any()).optional(),
  })).optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(8192).optional(),
  isActive: z.boolean().optional(),
});

router.get("/settings/copilot", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    let config = await prisma.copilotConfig.findUnique({
      where: { tenantId: req.tenantId! },
    });
    if (!config) {
      // Return defaults without creating
      res.json({
        systemPrompt: "",
        rules: [],
        tools: [
          { id: "kb_search", name: "Knowledge Base Search", enabled: true, config: {} },
          { id: "conversation_history", name: "Conversation History", enabled: true, config: {} },
          { id: "customer_lookup", name: "Customer Lookup", enabled: false, config: {} },
          { id: "order_status", name: "Order Status", enabled: false, config: {} },
        ],
        model: "gpt-4o-mini",
        provider: "openai",
        temperature: 0.7,
        maxTokens: 1024,
        isActive: true,
      });
      return;
    }
    res.json(config);
  } catch (err) {
    console.error("Get copilot settings error:", err);
    res.status(500).json({ error: "Failed to get copilot settings" });
  }
});

router.put("/settings/copilot", requireRole("ADMIN"), validate(copilotSettingsSchema), async (req: Request, res: Response) => {
  try {
    const config = await prisma.copilotConfig.upsert({
      where: { tenantId: req.tenantId! },
      update: req.body,
      create: {
        tenantId: req.tenantId!,
        ...req.body,
      },
    });
    res.json(config);
  } catch (err) {
    console.error("Update copilot settings error:", err);
    res.status(500).json({ error: "Failed to update copilot settings" });
  }
});

export default router;
