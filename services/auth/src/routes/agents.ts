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

// ─── SLA Settings ───────────────────────────────────────────

const slaSettingsSchema = z.object({
  enabled: z.boolean(),
  slaMinutes: z.number().min(1).max(1440).optional(),
  warningThreshold: z.number().min(0).max(100).optional(), // percentage of SLA time before warning
});

router.get("/settings/sla", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    const raw = await redis.get(`tenant:${req.tenantId!}:sla`);
    if (!raw) {
      res.json({ enabled: false, slaMinutes: 30, warningThreshold: 70 });
      return;
    }
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("Get SLA settings error:", err);
    res.status(500).json({ error: "Failed to get SLA settings" });
  }
});

router.put("/settings/sla", requireRole("ADMIN"), validate(slaSettingsSchema), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    await redis.set(`tenant:${req.tenantId!}:sla`, JSON.stringify(req.body));
    res.json(req.body);
  } catch (err) {
    console.error("Update SLA settings error:", err);
    res.status(500).json({ error: "Failed to update SLA settings" });
  }
});

// Department-level SLA override
router.get("/settings/sla/department/:departmentId", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    const raw = await redis.get(`department:${req.params.departmentId}:sla`);
    if (!raw) {
      res.json({ enabled: false, slaMinutes: null, warningThreshold: null });
      return;
    }
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("Get department SLA error:", err);
    res.status(500).json({ error: "Failed to get department SLA settings" });
  }
});

router.put("/settings/sla/department/:departmentId", requireRole("ADMIN"), validate(slaSettingsSchema), async (req: Request, res: Response) => {
  try {
    // Verify department belongs to tenant
    const dept = await prisma.department.findFirst({
      where: { id: req.params.departmentId, tenantId: req.tenantId! },
    });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const redis = getRedis();
    await redis.set(`department:${req.params.departmentId}:sla`, JSON.stringify(req.body));
    res.json(req.body);
  } catch (err) {
    console.error("Update department SLA error:", err);
    res.status(500).json({ error: "Failed to update department SLA settings" });
  }
});

// ─── Idle Automation Settings (Auto-Reminder & Auto-Close) ──

const idleAutomationSchema = z.object({
  reminderEnabled: z.boolean(),
  reminderDelayMinutes: z.number().min(1).max(10080).optional(), // up to 7 days
  reminderMessage: z.string().max(1000).optional(),
  autoCloseEnabled: z.boolean(),
  autoCloseDelayMinutes: z.number().min(1).max(10080).optional(),
  autoCloseMessage: z.string().max(1000).optional(),
});

router.get("/settings/idle-automation", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    const raw = await redis.get(`tenant:${req.tenantId!}:idleAutomation`);
    if (!raw) {
      res.json({
        reminderEnabled: false,
        reminderDelayMinutes: 60,
        reminderMessage: "Hi! We're still here and waiting for your response. Is there anything else we can help you with?",
        autoCloseEnabled: false,
        autoCloseDelayMinutes: 1440,
        autoCloseMessage: "Due to the lack of response, this conversation has been closed. Feel free to reach out again anytime!",
      });
      return;
    }
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("Get idle automation error:", err);
    res.status(500).json({ error: "Failed to get idle automation settings" });
  }
});

router.put("/settings/idle-automation", requireRole("ADMIN"), validate(idleAutomationSchema), async (req: Request, res: Response) => {
  try {
    const redis = getRedis();
    await redis.set(`tenant:${req.tenantId!}:idleAutomation`, JSON.stringify(req.body));
    res.json(req.body);
  } catch (err) {
    console.error("Update idle automation error:", err);
    res.status(500).json({ error: "Failed to update idle automation settings" });
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

// ─── First-Take-Care AI Agent Settings ──────────────────────

const firstTakeCareSettingsSchema = z.object({
  isActive: z.boolean().optional(),
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
  identity: z.any().optional(),
  goals: z.any().optional(),
  tone: z.any().optional(),
  behavioral: z.any().optional(),
  maxAutonomousMessages: z.number().min(1).optional(),
  maxAutonomousMinutes: z.number().min(1).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  escalationMessage: z.string().optional(),
});

router.get("/settings/first-take-care", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const [config, tenant] = await Promise.all([
      prisma.firstTakeCareConfig.findUnique({ where: { tenantId: req.tenantId! } }),
      prisma.tenant.findUnique({ where: { id: req.tenantId! }, select: { firstTakeCareEnabled: true } }),
    ]);

    if (!config) {
      res.json({
        data: {
          isActive: false,
          systemPrompt: "",
          rules: [],
          tools: [],
          model: "gpt-4o-mini",
          provider: "openai",
          temperature: 0.7,
          maxTokens: 1024,
          identity: null,
          goals: null,
          tone: null,
          behavioral: null,
          maxAutonomousMessages: 10,
          maxAutonomousMinutes: 15,
          confidenceThreshold: 0.6,
          escalationMessage: "Let me connect you with a team member who can help further.",
        },
        enabled: tenant?.firstTakeCareEnabled ?? false,
      });
      return;
    }

    res.json({ data: config, enabled: tenant?.firstTakeCareEnabled ?? false });
  } catch (err) {
    console.error("Get first-take-care settings error:", err);
    res.status(500).json({ error: "Failed to get First-Take-Care settings" });
  }
});

router.put("/settings/first-take-care", requireRole("ADMIN"), validate(firstTakeCareSettingsSchema), async (req: Request, res: Response) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { firstTakeCareEnabled: true },
    });

    if (!tenant?.firstTakeCareEnabled) {
      res.status(403).json({ error: "First-Take-Care is not enabled for this tenant. Contact system administrator." });
      return;
    }

    const config = await prisma.firstTakeCareConfig.upsert({
      where: { tenantId: req.tenantId! },
      update: req.body,
      create: {
        tenantId: req.tenantId!,
        ...req.body,
      },
    });

    res.json({ data: config });
  } catch (err) {
    console.error("Update first-take-care settings error:", err);
    res.status(500).json({ error: "Failed to update First-Take-Care settings" });
  }
});

export default router;

