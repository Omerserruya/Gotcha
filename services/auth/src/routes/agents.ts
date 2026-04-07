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

// Admin reset agent password
const resetAgentPasswordSchema = z.object({
  newPassword: z.string().min(8),
});

router.post("/:id/reset-password", requireRole("ADMIN"), validate(resetAgentPasswordSchema), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.user.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId!, role: "AGENT" },
    });
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

    const bcrypt = require("bcryptjs");
    const hashed = await bcrypt.hash(req.body.newPassword, 12);
    await prisma.user.update({ where: { id: agent.id }, data: { passwordHash: hashed } });
    res.json({ success: true });
  } catch (err) {
    console.error("Reset agent password error:", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// Delete agent (admin only)
router.delete("/:id", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.user.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId!, role: "AGENT" },
    });
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

    // Unassign from conversations first
    await prisma.conversation.updateMany({
      where: { assignedAgentId: agent.id },
      data: { assignedAgentId: null },
    });

    await prisma.user.delete({ where: { id: agent.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete agent error:", err);
    res.status(500).json({ error: "Failed to delete agent" });
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

// ─── Bot Config (for tenant admins) ─────────────────────────

router.get("/settings/bot-config", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { botEnabled: true, botType: true },
    });
    res.json({ data: { botEnabled: tenant?.botEnabled ?? false, botType: tenant?.botType ?? null } });
  } catch (err) {
    console.error("Get bot config error:", err);
    res.status(500).json({ error: "Failed to get bot configuration" });
  }
});

// Legacy copilot/first-take-care settings — now managed via AI Employees in AI Studio
router.get("/settings/copilot", requireRole("ADMIN"), async (_req: Request, res: Response) => {
  res.status(410).json({ error: "Deprecated. AI configuration is now managed via AI Employees in AI Studio." });
});

router.put("/settings/copilot", requireRole("ADMIN"), async (_req: Request, res: Response) => {
  res.status(410).json({ error: "Deprecated. AI configuration is now managed via AI Employees in AI Studio." });
});

router.get("/settings/first-take-care", requireRole("ADMIN"), async (_req: Request, res: Response) => {
  res.status(410).json({ error: "Deprecated. Bot configuration is now managed via AI Employees in AI Studio." });
});

router.put("/settings/first-take-care", requireRole("ADMIN"), async (_req: Request, res: Response) => {
  res.status(410).json({ error: "Deprecated. Bot configuration is now managed via AI Employees in AI Studio." });
});

export default router;

