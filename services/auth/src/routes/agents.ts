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
        departmentMember: {
          select: { departmentId: true, departmentRole: true, department: { select: { name: true } } },
        },
      },
    });
    // Flatten department info
    const data = agents.map((a) => {
      const { departmentMember, ...rest } = a;
      return {
        ...rest,
        departmentId: departmentMember?.departmentId || null,
        departmentRole: departmentMember?.departmentRole || null,
        departmentName: departmentMember?.department?.name || null,
      };
    });
    res.json(data);
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

// ─── Channel Account Management ─────────────────────────────

router.get("/settings/channels", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const accounts = await prisma.channelAccount.findMany({
      where: { tenantId: req.tenantId! },
      select: {
        id: true, channel: true, externalId: true, displayName: true,
        isActive: true, createdAt: true, updatedAt: true,
        _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ data: accounts });
  } catch (err) {
    console.error("List channel accounts error:", err);
    res.status(500).json({ error: "Failed to list channel accounts" });
  }
});

const createChannelSchema = z.object({
  channel: z.enum(["WHATSAPP", "MESSENGER"]),
  externalId: z.string().min(1),
  displayName: z.string().min(1),
  credentials: z.object({
    accessToken: z.string().min(1),
    appSecret: z.string().optional(),
    webhookSecret: z.string().optional(),
  }),
});

router.post("/settings/channels", requireRole("ADMIN"), validate(createChannelSchema), async (req: Request, res: Response) => {
  try {
    const { channel, externalId, displayName, credentials } = req.body;

    // Check uniqueness
    const existing = await prisma.channelAccount.findFirst({
      where: { channel, externalId },
    });
    if (existing) {
      res.status(409).json({ error: "This channel account is already registered" });
      return;
    }

    const account = await prisma.channelAccount.create({
      data: {
        tenantId: req.tenantId!,
        channel,
        externalId,
        displayName,
        credentials,
      },
    });
    res.status(201).json({ data: account });
  } catch (err) {
    console.error("Create channel account error:", err);
    res.status(500).json({ error: "Failed to create channel account" });
  }
});

const updateChannelSchema = z.object({
  displayName: z.string().min(1).optional(),
  credentials: z.object({
    accessToken: z.string().min(1),
    appSecret: z.string().optional(),
    webhookSecret: z.string().optional(),
  }).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/settings/channels/:id", requireRole("ADMIN"), validate(updateChannelSchema), async (req: Request, res: Response) => {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!account) { res.status(404).json({ error: "Channel account not found" }); return; }

    const updated = await prisma.channelAccount.update({
      where: { id: req.params.id as string },
      data: req.body,
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("Update channel account error:", err);
    res.status(500).json({ error: "Failed to update channel account" });
  }
});

router.delete("/settings/channels/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const account = await prisma.channelAccount.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! },
    });
    if (!account) { res.status(404).json({ error: "Channel account not found" }); return; }

    await prisma.channelAccount.delete({ where: { id: req.params.id as string } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete channel account error:", err);
    res.status(500).json({ error: "Failed to delete channel account" });
  }
});

// ─── Tenant Channel Config (Bot Flow Mode) ─────────────────

router.get("/settings/channel-config", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    let config = await prisma.tenantChannelConfig.findUnique({
      where: { tenantId: req.tenantId! },
    });
    if (!config) {
      res.json({ data: { botFlowMode: "UNIFIED" } });
      return;
    }
    res.json({ data: config });
  } catch (err) {
    console.error("Get channel config error:", err);
    res.status(500).json({ error: "Failed to get channel config" });
  }
});

const channelConfigSchema = z.object({
  botFlowMode: z.enum(["UNIFIED", "PER_CHANNEL"]),
});

router.put("/settings/channel-config", requireRole("ADMIN"), validate(channelConfigSchema), async (req: Request, res: Response) => {
  try {
    const config = await prisma.tenantChannelConfig.upsert({
      where: { tenantId: req.tenantId! },
      update: { botFlowMode: req.body.botFlowMode },
      create: { tenantId: req.tenantId!, botFlowMode: req.body.botFlowMode },
    });
    res.json({ data: config });
  } catch (err) {
    console.error("Update channel config error:", err);
    res.status(500).json({ error: "Failed to update channel config" });
  }
});

// ─── Business Hours Settings ─────────────────────────────────

const dayScheduleSchema = z.object({
  enabled: z.boolean(),
  open: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  close: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

const businessHoursSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1),
  autoResponse: z.string().optional().default(""),
  schedule: z.object({
    sunday: dayScheduleSchema,
    monday: dayScheduleSchema,
    tuesday: dayScheduleSchema,
    wednesday: dayScheduleSchema,
    thursday: dayScheduleSchema,
    friday: dayScheduleSchema,
    saturday: dayScheduleSchema,
  }),
});

router.get("/settings/business-hours", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    const raw = await redis.get(`tenant:${req.tenantId!}:businessHours`);
    if (!raw) {
      res.json({
        enabled: false,
        timezone: "Asia/Jerusalem",
        autoResponse: "",
        schedule: {
          sunday:    { enabled: true,  open: "09:00", close: "18:00" },
          monday:    { enabled: true,  open: "09:00", close: "18:00" },
          tuesday:   { enabled: true,  open: "09:00", close: "18:00" },
          wednesday: { enabled: true,  open: "09:00", close: "18:00" },
          thursday:  { enabled: true,  open: "09:00", close: "18:00" },
          friday:    { enabled: false },
          saturday:  { enabled: false },
        },
      });
      return;
    }
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("Get business hours error:", err);
    res.status(500).json({ error: "Failed to get business hours" });
  }
});

router.put("/settings/business-hours", requireRole("ADMIN"), validate(businessHoursSchema), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    await redis.set(`tenant:${req.tenantId!}:businessHours`, JSON.stringify(req.body));
    res.json(req.body);
  } catch (err) {
    console.error("Update business hours error:", err);
    res.status(500).json({ error: "Failed to update business hours" });
  }
});

// ─── Co-Pilot Settings ──────────────────────────────────────

const copilotSettingsSchema = z.object({
  copilotMode: z.enum(["READY_MESSAGE", "CONTEXT_ONLY"]).optional(),
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
