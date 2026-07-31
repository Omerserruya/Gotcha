import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireRole,
  requirePermissionOrRole,
  enforceMfaEnrollment,
  validate,
  requireCapacity,
  getRedis,
  resolveEffectiveLocale,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  writeAudit,
  AuditAction,
  getLastLoginBySubject,
  normalizeE164,
  userMayApprove, readDurableSetting, writeDurableSetting } from "@chatcenter/shared";
import * as invitations from "../services/invitation.service";

const router = Router();
// API-level MFA enforcement: a required-but-unenrolled caller is 403'd here, not
// just blocked by the client gate. Reference mount - the same one-liner should
// be added to the other services' protected routers to close the API path fully.
router.use(authenticate, resolveTenant, enforceMfaEnrollment());

router.get("/", async (req: Request, res: Response) => {
  try {
    const agents = await prisma.user.findMany({
      where: { tenantId: req.tenantId!, role: "AGENT" },
      select: {
        id: true, name: true, email: true, isActive: true, createdAt: true,
        phoneNumber: true,
        _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
        departmentMembers: {
          select: { departmentId: true, departmentRole: true, department: { select: { name: true } } },
          orderBy: { createdAt: "asc" as const },
        },
      },
    });
    // Multi-department membership: `departments` carries the full list; the
    // singular fields stay (first membership) for legacy consumers.
    const data = agents.map((a) => {
      const { departmentMembers, ...rest } = a;
      const first = departmentMembers[0];
      return {
        ...rest,
        departments: departmentMembers.map((m) => ({
          departmentId: m.departmentId,
          departmentRole: m.departmentRole,
          departmentName: m.department?.name || null,
        })),
        departmentId: first?.departmentId || null,
        departmentRole: first?.departmentRole || null,
        departmentName: first?.department?.name || null,
      };
    });
    res.json(data);
  } catch (err) {
    console.error("List agents error:", err);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

// Login/invitation status for the tenant's members (admin only, lazy-loaded by
// the Users page so the main list stays fast). For each user we ask Authentik
// for last_login in one call and derive a status:
//   disabled       - GOTCHA isActive=false
//   invited        - active, never signed in (invite pending / link unused)
//   active         - active, has signed in (returns lastLogin)
router.get("/login-status", requirePermissionOrRole("settings:members:manage", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.tenantId!, role: "AGENT" },
      select: { id: true, isActive: true, identity: { select: { authentikSubject: true } } },
    });
    const entries = await Promise.all(users.map(async (u) => {
      let lastLogin: string | null = null;
      if (u.identity?.authentikSubject) {
        try { lastLogin = await getLastLoginBySubject(u.identity.authentikSubject); } catch { /* best-effort */ }
      }
      const status = !u.isActive ? "disabled" : lastLogin ? "active" : "invited";
      return [u.id, { status, lastLogin }] as const;
    }));
    res.json(Object.fromEntries(entries));
  } catch (err) {
    console.error("Login status error:", err);
    res.status(500).json({ error: "Failed to load login status" });
  }
});

// Invite a new agent (admin only).
//
// No password is accepted: an admin cannot choose someone else's credential.
// We create the identity in Authentik and hand back a one-time setup link that
// the invitee uses to set their own password there.
const inviteAgentSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  // Zero, one or many departments. Every id is validated against the ACTIVE
  // tenant below - ids arriving from frontend state are never trusted as-is.
  departmentIds: z.array(z.string().min(1)).max(20).optional(),
});

// Seat limit. Counts ACTIVE members only, so deactivating someone frees their
// seat rather than permanently consuming it.
router.post(
  "/",
  requirePermissionOrRole("settings:members:manage", "ADMIN"),
  requireCapacity("limit:users", (tenantId) => prisma.user.count({ where: { tenantId, isActive: true } })),
  validate(inviteAgentSchema),
  async (req: Request, res: Response) => {
  try {
    const { email, name, departmentIds } = req.body as { email: string; name: string; departmentIds?: string[] };
    // Validate EVERY requested department against the active tenant first -
    // a foreign/unknown id fails the whole invite (no partial memberships).
    const wantedDepts = Array.from(new Set(departmentIds ?? []));
    if (wantedDepts.length > 0) {
      const found = await prisma.department.findMany({
        where: { id: { in: wantedDepts }, tenantId: req.tenantId! },
        select: { id: true },
      });
      if (found.length !== wantedDepts.length) {
        res.status(400).json({ error: "One or more departments do not belong to this workspace" });
        return;
      }
    }
    const result = await invitations.inviteUser(req.tenantId!, email, name, "AGENT");
    if (wantedDepts.length > 0) {
      await prisma.departmentMember.createMany({
        data: wantedDepts.map((departmentId) => ({
          tenantId: req.tenantId!,
          userId: result.user.id,
          departmentId,
        })),
        skipDuplicates: true,
      });
    }
    void writeAudit({
      tenantId: req.tenantId!, actorType: "user", actorId: (req as any).user?.userId,
      action: AuditAction.INVITE_CREATED, targetType: "user", targetId: result.user.id,
      metadata: { email, role: "AGENT", departmentIds: wantedDepts },
    });
    res.status(201).json(result);
  } catch (err: any) {
    if (err.message?.includes("already exists") || err.message?.includes("already linked") || err.message?.includes("already a member")) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("Invite agent error:", err);
    res.status(500).json({ error: "Failed to invite agent" });
  }
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  // E.164 personal mobile. Allow null to clear. Loose validation here -
  // strict format enforcement happens in the frontend + voice-copilot's
  // normalizePhone().
  phoneNumber: z.string().nullable().optional(),
});

router.patch("/:id", requirePermissionOrRole("settings:members:manage", "ADMIN"), validate(updateAgentSchema), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.user.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId!, role: "AGENT" },
    });
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    // Explicit allowlist. NEVER pass req.body straight into a user write: role,
    // tenantId, and authentikSubject (the auth join key) must never be settable
    // from a request body.
    const { name, isActive, phoneNumber } = req.body as {
      name?: string; isActive?: boolean; phoneNumber?: string | null;
    };
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (isActive !== undefined) data.isActive = isActive;
    if (phoneNumber !== undefined) data.phoneNumber = phoneNumber;
    const updated = await prisma.user.update({
      where: { id: req.params.id as string },
      data,
      select: { id: true, name: true, email: true, isActive: true, phoneNumber: true },
    });
    // Keep Authentik's display name in sync on a rename so the IdP login card,
    // account portal, and emails don't show the stale name. Fire-and-forget.
    if (name !== undefined && name !== agent.name) {
      void invitations.syncIdentityNameByUser(agent.id, updated.name);
    }
    // Disabling in GOTCHA must also disable authentication at the IdP (when
    // this was the person's last active tenant) AND kill live sessions - else
    // a disabled user keeps a working Authentik session until token expiry.
    if (isActive !== undefined && isActive !== agent.isActive) {
      void invitations.syncMembershipAccess(agent.id, isActive);
    }
    void writeAudit({
      tenantId: req.tenantId!, actorType: "user", actorId: (req as any).user?.userId,
      action: isActive === false ? AuditAction.USER_DEACTIVATED
        : isActive === true ? AuditAction.USER_ACTIVATED : AuditAction.USER_UPDATED,
      targetType: "user", targetId: updated.id, metadata: { fields: Object.keys(data) },
    });
    res.json(updated);
  } catch (err) {
    console.error("Update agent error:", err);
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// Re-issue an agent's password-setup link (admin only).
//
// This replaces the old admin-sets-a-password endpoint. An admin can help
// someone regain access, but never learns or chooses their credential: all
// this returns is a one-time link into Authentik's recovery flow.
router.post("/:id/reset-password", requirePermissionOrRole("settings:members:manage", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.user.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId!, role: "AGENT" },
    });
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

    const setupLink = await invitations.resendSetupLink(agent.id);
    void writeAudit({
      tenantId: req.tenantId!, actorType: "user", actorId: (req as any).user?.userId,
      action: AuditAction.PASSWORD_RESET_REQUESTED, targetType: "user", targetId: agent.id,
    });
    res.json({ success: true, setupLink });
  } catch (err) {
    console.error("Resend agent setup link error:", err);
    res.status(500).json({ error: "Failed to issue password setup link" });
  }
});

// Delete agent (admin only)
router.delete("/:id", requirePermissionOrRole("settings:members:manage", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.user.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId!, role: "AGENT" },
    });
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

    // Unassign from conversations first (tenant-scoped: the membership being
    // removed only ever held conversations in ITS tenant).
    await prisma.conversation.updateMany({
      where: { tenantId: req.tenantId!, assignedAgentId: agent.id },
      data: { assignedAgentId: null },
    });

    // Disable the identity BEFORE dropping the row. Deleting locally alone
    // would leave a live Authentik session that still authenticates - the
    // token would simply resolve to no user. Belt-and-braces: authenticate()
    // 403s an unlinked subject, but the identity should not stay usable.
    await invitations.revokeUserAccess(agent.id);

    await prisma.user.delete({ where: { id: agent.id } });
    void writeAudit({
      tenantId: req.tenantId!, actorType: "user", actorId: (req as any).user?.userId,
      action: AuditAction.USER_DELETED, targetType: "user", targetId: agent.id,
      metadata: { email: agent.email, role: agent.role },
    });
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
    const template = (await readDurableSetting(req.tenantId!, "autoGreeting")) || "";
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
      await writeDurableSetting(req.tenantId!, "autoGreeting", template, req.user?.userId);
    } else {
      await writeDurableSetting(req.tenantId!, "autoGreeting", null, req.user?.userId);
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

    // Explicit allowlist (updateChannelSchema fields only).
    const { displayName, credentials, isActive } = req.body as {
      displayName?: string; credentials?: unknown; isActive?: boolean;
    };
    const data: Record<string, unknown> = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (credentials !== undefined) data.credentials = credentials;
    if (isActive !== undefined) data.isActive = isActive;
    const updated = await prisma.channelAccount.update({
      where: { id: req.params.id as string },
      data,
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

// ─── Approval Recipient (WhatsApp one-tap approvals) ─────────
//
// EXPLICIT opt-in. Nothing is ever sent unless a row exists AND is enabled -
// there is deliberately no "notify the owner" fallback, because routing a
// refund approval at whoever happens to be an admin is how the wrong person
// authorises money movement.

const approvalRecipientSchema = z.object({
  /** Membership authorised to decide. Validated against THIS tenant below. */
  userId: z.string().min(1),
  /** Free-form on input; normalised to E.164 before storage. */
  phone: z.string().min(6).max(24),
  enabled: z.boolean().optional().default(false),
  /** Ceiling for one-tap decisions; higher-risk actions go to the web UI. */
  maxRiskLevel: z.enum(["low", "medium", "high"]).optional().default("medium"),
});

router.get("/settings/approval-recipient", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const row = await (prisma as any).approvalRecipient.findFirst({
      where: { tenantId: req.tenantId!, channel: "whatsapp" },
      include: { user: { select: { id: true, name: true, email: true, isActive: true } } },
    });
    res.json({ data: row ?? null });
  } catch (err) {
    console.error("Get approval recipient error:", err);
    res.status(500).json({ error: "Failed to load approval recipient" });
  }
});

router.put("/settings/approval-recipient", requireRole("ADMIN"), validate(approvalRecipientSchema), async (req: Request, res: Response) => {
  try {
    const { userId, phone, enabled, maxRiskLevel } = req.body as z.infer<typeof approvalRecipientSchema>;

    // The approver must be an ACTIVE member of the CALLER's tenant. Never
    // trust a userId from the browser without this check.
    const member = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.tenantId!, isActive: true },
      select: { id: true },
    });
    if (!member) {
      res.status(400).json({ error: "That user is not an active member of this workspace" });
      return;
    }
    // …and must actually be allowed to approve, so we cannot configure a
    // recipient who would be refused at decision time.
    if (!(await userMayApprove(req.tenantId!, userId))) {
      res.status(400).json({ error: "That user does not have permission to approve actions" });
      return;
    }

    // INTERNATIONAL FORMAT ONLY. `Tenant.defaultCountryCode` holds an ISO-2
    // code ("IL"), not a dialling code, and inventing an ISO->dial mapping to
    // expand a bare "0501234567" is how an approval request for one business
    // gets delivered to a stranger in another country. The number an approver
    // is reached on is worth one extra "+" of friction.
    const e164 = normalizeE164(phone);
    if (!e164) {
      res.status(400).json({ error: "Enter a valid phone number in international format (e.g. +972501234567)" });
      return;
    }

    const saved = await (prisma as any).approvalRecipient.upsert({
      where: { tenantId_userId_channel: { tenantId: req.tenantId!, userId, channel: "whatsapp" } },
      update: { phoneE164: e164, enabled, maxRiskLevel },
      create: { tenantId: req.tenantId!, userId, channel: "whatsapp", phoneE164: e164, enabled, maxRiskLevel },
    });
    res.json({ data: saved });
  } catch (err) {
    console.error("Update approval recipient error:", err);
    res.status(500).json({ error: "Failed to save approval recipient" });
  }
});

router.delete("/settings/approval-recipient/:userId", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    await (prisma as any).approvalRecipient.deleteMany({
      where: { tenantId: req.tenantId!, userId: req.params.userId, channel: "whatsapp" },
    });
    res.json({ data: { removed: true } });
  } catch (err) {
    console.error("Delete approval recipient error:", err);
    res.status(500).json({ error: "Failed to remove approval recipient" });
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
  // Outside-hours AI policy (shared/lib/business-hours.ts owns the semantics):
  // "active" = the AI employee keeps answering while closed (handoffs must say
  // the team is away and when it returns); "silent" = no AI replies while
  // closed - the autoResponse (or a generated default) is sent instead.
  aiOutsideHours: z.enum(["active", "silent"]).optional().default("active"),
  // Optional owner-written line appended to human-handoff messages while
  // closed (a generated line with the real next opening time is the default).
  outsideHoursHandoffMessage: z.string().max(500).optional().default(""),
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
    const raw = await readDurableSetting(req.tenantId!, "businessHours");
    if (!raw) {
      res.json({
        enabled: false,
        timezone: "Asia/Jerusalem",
        autoResponse: "",
        aiOutsideHours: "active",
        outsideHoursHandoffMessage: "",
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
    await writeDurableSetting(req.tenantId!, "businessHours", JSON.stringify(req.body), req.user?.userId);
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
    const raw = await readDurableSetting(req.tenantId!, "sla");
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
    await writeDurableSetting(req.tenantId!, "sla", JSON.stringify(req.body), req.user?.userId);
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
    const raw = await readDurableSetting(req.tenantId!, `department:${req.params.departmentId}:sla`);
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
      where: { id: String(req.params.departmentId), tenantId: req.tenantId! },
    });
    if (!dept) { res.status(404).json({ error: "Department not found" }); return; }

    const redis = getRedis();
    await writeDurableSetting(req.tenantId!, `department:${req.params.departmentId}:sla`, JSON.stringify(req.body), req.user?.userId);
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

// Legacy copilot/first-take-care settings - now managed via AI Employees in AI Studio
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

// ─── System language ──────────────────────────────────────────
// Three endpoints in one file: read the effective locale (anyone),
// set the per-agent override (anyone), set the tenant default (admin).
// The "effective" value follows the resolver precedence - agent
// override > tenant default > "en" fallback.

const localeSchema = z.object({
  locale: z.union([z.string(), z.null()]).optional(),
});

router.get("/me/locale", async (req: Request, res: Response) => {
  try {
    const resolved = await resolveEffectiveLocale({
      tenantId: req.tenantId!,
      userId: req.user!.userId,
    });
    res.json({
      data: {
        effective: resolved.effective,
        tenantDefault: resolved.tenantDefault,
        userOverride: resolved.userOverride,
        supported: SUPPORTED_LOCALES,
      },
    });
  } catch (err) {
    console.error("Get me/locale error:", err);
    res.status(500).json({ error: "failed_to_load_locale" });
  }
});

router.put("/me/locale", validate(localeSchema), async (req: Request, res: Response) => {
  try {
    const raw = (req.body as { locale?: string | null }).locale;
    // NULL / empty / "system" all collapse to "clear the override" so
    // the agent falls back to the tenant default.
    let nextLocale: string | null = null;
    if (raw && raw !== "system") {
      if (!isSupportedLocale(raw)) {
        res.status(400).json({ error: "unsupported_locale", supported: SUPPORTED_LOCALES });
        return;
      }
      nextLocale = raw;
    }
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: { locale: nextLocale },
    });
    const resolved = await resolveEffectiveLocale({
      tenantId: req.tenantId!,
      userId: req.user!.userId,
    });
    res.json({ data: { effective: resolved.effective, userOverride: resolved.userOverride } });
  } catch (err) {
    console.error("Put me/locale error:", err);
    res.status(500).json({ error: "failed_to_set_locale" });
  }
});

router.put("/settings/locale", requireRole("ADMIN"), validate(localeSchema), async (req: Request, res: Response) => {
  try {
    const raw = (req.body as { locale?: string }).locale;
    if (!raw || !isSupportedLocale(raw)) {
      res.status(400).json({ error: "unsupported_locale", supported: SUPPORTED_LOCALES });
      return;
    }
    await prisma.tenant.update({
      where: { id: req.tenantId! },
      data: { defaultLocale: raw },
    });
    res.json({ data: { tenantDefault: raw } });
  } catch (err) {
    console.error("Put settings/locale error:", err);
    res.status(500).json({ error: "failed_to_set_tenant_locale" });
  }
});

export default router;

