import { Router, Request, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import {
  prisma,
  authenticate,
  requireSystemAdmin,
  validate,
  signToken,
  publishEvent,
  crossTenantMiddleware,
  AI_MODEL_PRICING,
  resolveModelPricing,
  AI_FEATURE_CATEGORIES,
  AI_CATEGORY_ORDER,
  categorySqlCase,
  categoryLabel,
  type AiFeatureCategory,
} from "@chatcenter/shared";
import { sendOnboardingEmail } from "../services/notification.service";

const router = Router();
const SALT_ROUNDS = 10;

// System-admin routes legitimately need cross-tenant reads (list all
// tenants, aggregate usage across tenants, create new tenant admins,
// etc). Enable the Prisma tenant-guard opt-out for this entire router.
// Safe because every handler below is already gated by authenticate +
// requireSystemAdmin() - only SYSTEM_ADMIN users ever reach this code.
router.use(crossTenantMiddleware);

// ─── System Admin Login (no tenant slug needed) ──────────────

const systemLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", validate(systemLoginSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    // Find user with SYSTEM_ADMIN role across all tenants
    const user = await prisma.user.findFirst({
      where: { email, role: "SYSTEM_ADMIN", isActive: true },
    });
    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = signToken({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
      },
    });
  } catch (err) {
    console.error("System login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── System Stats ────────────────────────────────────────────

router.get("/stats", authenticate, requireSystemAdmin(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const [tenantCount, userCount, conversationCount, messageCount, channelCount] = await Promise.all([
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.conversation.count(),
      prisma.message.count(),
      prisma.channelAccount.count({ where: { connectionStatus: "CONNECTED" } }),
    ]);

    const activeTenants = await prisma.tenant.count({ where: { isActive: true } });

    const recentTenants = await prisma.tenant.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, slug: true, createdAt: true, isActive: true },
    });

    res.json({
      data: {
        tenants: { total: tenantCount, active: activeTenants },
        users: userCount,
        conversations: conversationCount,
        messages: messageCount,
        connectedChannels: channelCount,
        recentTenants,
      },
    });
  } catch (err) {
    console.error("System stats error:", err);
    res.status(500).json({ error: "Failed to fetch system stats" });
  }
});

// ─── List Tenants ────────────────────────────────────────────

router.get("/tenants", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const search = (req.query.search as string) || "";
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const where = search
      ? { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { slug: { contains: search, mode: "insensitive" as const } }] }
      : {};

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              users: true,
              conversations: { where: { status: { not: "CLOSED" } } },
              channelAccounts: { where: { connectionStatus: "CONNECTED" } },
            },
          },
        },
      }),
      prisma.tenant.count({ where }),
    ]);

    res.json({ data: tenants, meta: { total, page, limit } });
  } catch (err) {
    console.error("List tenants error:", err);
    res.status(500).json({ error: "Failed to list tenants" });
  }
});

// ─── Get Tenant Detail ───────────────────────────────────────

router.get("/tenants/:id", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id as string },
      include: {
        _count: {
          select: {
            users: true,
            conversations: true,
            messages: true,
            channelAccounts: true,
            departments: true,
            chatbotFlows: true,
          },
        },
      },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    // Get users for this tenant
    const users = await prisma.user.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Get connected channels
    const channels = await prisma.channelAccount.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, channel: true, displayName: true, connectionStatus: true, isActive: true },
    });

    // Get departments
    const departments = await prisma.department.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    });

    res.json({
      data: {
        ...tenant,
        users,
        channels,
        departments,
      },
    });
  } catch (err) {
    console.error("Get tenant error:", err);
    res.status(500).json({ error: "Failed to get tenant" });
  }
});

// ─── Create Tenant ───────────────────────────────────────────

const createTenantSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminName: z.string().min(1),
});

router.post("/tenants", authenticate, requireSystemAdmin(), validate(createTenantSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, slug, adminEmail, adminPassword, adminName } = req.body;

    // Check slug uniqueness
    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (existing) {
      res.status(409).json({ error: "A tenant with this slug already exists" });
      return;
    }

    // Create tenant + admin user + onboarding tracker in transaction
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name, slug, status: "PENDING_ADMIN_SETUP" },
      });

      const hashedPassword = await bcrypt.hash(adminPassword, SALT_ROUNDS);
      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          password: hashedPassword,
          name: adminName,
          role: "ADMIN",
        },
      });

      // Initialize onboarding tracker
      await tx.tenantOnboarding.create({
        data: { tenantId: tenant.id, currentStep: "BUSINESS_PROFILE" },
      });

      return { tenant, admin };
    });

    // Publish TenantCreated event
    await publishEvent({
      event: "tenant:created",
      tenantId: result.tenant.id,
      data: {
        tenantName: name,
        tenantSlug: slug,
        adminEmail,
        adminName,
      },
    });

    // Send onboarding email with magic link (non-blocking)
    sendOnboardingEmail(result.tenant.id, adminEmail, adminName, name, slug, result.admin.id).catch((err) => {
      console.error("Failed to send onboarding email:", err);
    });

    res.status(201).json({
      data: {
        tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug, status: result.tenant.status },
        admin: { id: result.admin.id, email: result.admin.email, name: result.admin.name },
      },
    });
  } catch (err) {
    console.error("Create tenant error:", err);
    res.status(500).json({ error: "Failed to create tenant" });
  }
});

// ─── Resend Onboarding Link ─────────────────────────────────

router.post("/tenants/:id/resend-onboarding", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (tenant.status === "ACTIVE") {
      res.status(400).json({ error: "Tenant has already completed onboarding" });
      return;
    }

    // Find the admin user for this tenant
    const admin = await prisma.user.findFirst({
      where: { tenantId: tenant.id, role: "ADMIN", isActive: true },
      select: { id: true, email: true, name: true },
    });
    if (!admin) {
      res.status(400).json({ error: "No active admin user found for this tenant" });
      return;
    }

    // Invalidate previous unused magic links
    await prisma.magicLink.updateMany({
      where: { tenantId: tenant.id, usedAt: null },
      data: { expiresAt: new Date() },
    });

    // Send new onboarding email with fresh magic link
    await sendOnboardingEmail(tenant.id, admin.email, admin.name, tenant.name, tenant.slug, admin.id);

    res.json({
      data: {
        message: "Onboarding link resent successfully",
        sentTo: admin.email,
      },
    });
  } catch (err) {
    console.error("Resend onboarding error:", err);
    res.status(500).json({ error: "Failed to resend onboarding link" });
  }
});

// ─── Delete Tenant (hierarchical cascade) ──────────────────
router.delete("/tenants/:id", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.params.id as string;
    const force = req.query.force === "true";

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, status: true },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    // Must be disabled unless force
    if (tenant.status === "ACTIVE" && !force) {
      res.status(400).json({ error: "Tenant must be disabled before deletion. Use ?force=true to override." });
      return;
    }

    // Cascade delete everything in a transaction
    await prisma.$transaction([
      prisma.magicLink.deleteMany({ where: { tenantId } }),
      prisma.notificationLog.deleteMany({ where: { tenantId } }),
      prisma.message.deleteMany({ where: { tenantId } }),
      prisma.conversation.deleteMany({ where: { tenantId } }),
      prisma.departmentMember.deleteMany({ where: { department: { tenantId } } }),
      prisma.department.deleteMany({ where: { tenantId } }),
      prisma.channelAccount.deleteMany({ where: { tenantId } }),
      prisma.businessProfile.deleteMany({ where: { tenantId } }),
      prisma.tenantOnboarding.deleteMany({ where: { tenantId } }),
      prisma.chatbotFlow.deleteMany({ where: { tenantId } }),
      prisma.user.deleteMany({ where: { tenantId } }),
      prisma.tenant.delete({ where: { id: tenantId } }),
    ]);

    res.json({ data: { deleted: true, tenantId, tenantName: tenant.name } });
  } catch (err: any) {
    console.error("Delete tenant error:", err);
    res.status(500).json({ error: "Failed to delete tenant" });
  }
});

// ─── Update Tenant ───────────────────────────────────────────

const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  // Voice Phase-1 master toggle and its two sub-flags. Flipping
  // voiceCopilotEnabled is what makes /settings/voice-channels appear in
  // the tenant's sidebar (see frontend/src/lib/use-voice-flags.ts).
  voiceCopilotEnabled: z.boolean().optional(),
  voiceInboxUiEnabled: z.boolean().optional(),
  voiceIncomingEnabled: z.boolean().optional(),
});

router.patch("/tenants/:id", authenticate, requireSystemAdmin(), validate(updateTenantSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const updated = await prisma.tenant.update({
      where: { id: req.params.id as string },
      data: req.body,
      select: { id: true, name: true, slug: true, isActive: true, updatedAt: true },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update tenant error:", err);
    res.status(500).json({ error: "Failed to update tenant" });
  }
});

// ─── Create User in Tenant ───────────────────────────────────

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.enum(["ADMIN", "AGENT"]).optional().default("AGENT"),
});

router.post("/tenants/:id/users", authenticate, requireSystemAdmin(), validate(createUserSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const { email, password, name, role } = req.body;

    const existing = await prisma.user.findFirst({ where: { tenantId: tenant.id, email } });
    if (existing) {
      res.status(409).json({ error: "User with this email already exists in this tenant" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email, password: hashedPassword, name, role: role as any },
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    });

    res.status(201).json({ data: user });
  } catch (err) {
    console.error("Create user error:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// ─── Update User (SysAdmin: name, email, password, role, active) ──

const updateUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).max(200).optional(),
  role: z.enum(["ADMIN", "AGENT"]).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/tenants/:id/users/:userId", authenticate, requireSystemAdmin(), validate(updateUserSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId as string, tenantId: req.params.id as string },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { isActive, role, name, email, password } = req.body;
    const data: any = {};
    if (typeof isActive === "boolean") data.isActive = isActive;
    // Never alter a SYSTEM_ADMIN's role through the tenant-scoped endpoint.
    if (role && ["ADMIN", "AGENT"].includes(role) && user.role !== "SYSTEM_ADMIN") data.role = role;
    if (typeof name === "string" && name.trim()) data.name = name.trim();
    if (typeof email === "string" && email.trim()) {
      const nextEmail = email.trim();
      if (nextEmail !== user.email) {
        const clash = await prisma.user.findFirst({
          where: { tenantId: req.params.id as string, email: nextEmail, id: { not: user.id } },
          select: { id: true },
        });
        if (clash) {
          res.status(409).json({ error: "Another user in this tenant already uses this email" });
          return;
        }
        data.email = nextEmail;
      }
    }
    if (typeof password === "string" && password.length >= 8) {
      data.password = await bcrypt.hash(password, SALT_ROUNDS);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

// ─── Delete User (SysAdmin) ──────────────────────────────────

router.delete("/tenants/:id/users/:userId", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.userId as string | undefined;
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId as string, tenantId: req.params.id as string },
      select: { id: true, role: true, name: true },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (user.role === "SYSTEM_ADMIN") {
      res.status(400).json({ error: "Cannot delete a system admin user" });
      return;
    }
    if (currentUserId && user.id === currentUserId) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }

    // User relations cascade / SetNull at the DB level (conversations →
    // assignedAgentId SetNull, departmentMember → Cascade), so a single
    // delete cleans up cleanly.
    await prisma.user.delete({ where: { id: user.id } });
    res.json({ data: { deleted: true, userId: user.id, name: user.name } });
  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ─── Bot Configuration (SysAdmin) ───────────────────────────

const botConfigSchema = z.object({
  botEnabled: z.boolean(),
  botType: z.enum(["CHATBOT_FLOW", "AUTONOMOUS_AI"]).optional(),
});

router.patch("/tenants/:id/bot-config", authenticate, requireSystemAdmin(), validate(botConfigSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { botEnabled, botType } = req.body;

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const data: any = { botEnabled };
    if (botEnabled && botType) {
      data.botType = botType;
      if (botType === "AUTONOMOUS_AI") {
        data.firstTakeCareEnabled = true;
      } else {
        data.firstTakeCareEnabled = false;
      }
    } else if (!botEnabled) {
      // When disabling, keep botType as-is but don't clear it
    }

    const updated = await prisma.tenant.update({
      where: { id: req.params.id as string },
      data,
      select: { id: true, botEnabled: true, botType: true, firstTakeCareEnabled: true },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update bot config error:", err);
    res.status(500).json({ error: "Failed to update bot configuration" });
  }
});

// ─── Toggle First-Take-Care Feature ─────────────────────────

router.patch("/tenants/:id/first-take-care", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const updated = await prisma.tenant.update({
      where: { id: req.params.id as string },
      data: { firstTakeCareEnabled: enabled },
      select: { id: true, firstTakeCareEnabled: true },
    });

    res.json({ data: { enabled: updated.firstTakeCareEnabled } });
  } catch (err) {
    console.error("Toggle first-take-care error:", err);
    res.status(500).json({ error: "Failed to toggle First-Take-Care" });
  }
});

// ─── Seed System Admin (one-time setup) ──────────────────────

const seedSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  setupSecret: z.string().min(1),
});

router.post("/seed", validate(seedSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, setupSecret } = req.body;

    // Verify setup secret (use JWT_SECRET as the setup key)
    const expectedSecret = process.env.SYSTEM_ADMIN_SETUP_SECRET || process.env.JWT_SECRET;
    if (setupSecret !== expectedSecret) {
      res.status(403).json({ error: "Invalid setup secret" });
      return;
    }

    // Check if any SYSTEM_ADMIN already exists
    const existingAdmin = await prisma.user.findFirst({ where: { role: "SYSTEM_ADMIN" } });
    if (existingAdmin) {
      res.status(409).json({ error: "System admin already exists" });
      return;
    }

    // Create a "system" tenant for the system admin
    let systemTenant = await prisma.tenant.findUnique({ where: { slug: "system" } });
    if (!systemTenant) {
      systemTenant = await prisma.tenant.create({
        data: { name: "System", slug: "system" },
      });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const admin = await prisma.user.create({
      data: {
        tenantId: systemTenant.id,
        email,
        password: hashedPassword,
        name,
        role: "SYSTEM_ADMIN",
      },
    });

    const token = signToken({
      userId: admin.id,
      tenantId: systemTenant.id,
      role: admin.role,
      email: admin.email,
    });

    res.status(201).json({
      data: {
        user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
        token,
      },
    });
  } catch (err) {
    console.error("Seed system admin error:", err);
    res.status(500).json({ error: "Failed to seed system admin" });
  }
});

// ─── System Admin: Usage Stats (all tenants) ───────────────

router.get("/usage/stats", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Aggregate by type across all tenants
    const byType = await prisma.usageLog.groupBy({
      by: ["type"],
      where: { createdAt: { gte: since } },
      _sum: { quantity: true, costUsd: true },
      _count: { id: true },
    });

    const stats: Record<string, { total: number; count: number; costUsd: number }> = {};
    for (const row of byType) {
      stats[row.type] = {
        total: row._sum.quantity || 0,
        count: row._count.id,
        costUsd: Number(row._sum.costUsd ?? 0),
      };
    }

    // AI-specific: feature + model breakdowns (only rows where type='ai_tokens')
    const aiWhere = { type: "ai_tokens", createdAt: { gte: since } };
    // Cached prompt tokens live on `metadata.cachedPromptTokens` (JSONB) - Prisma
    // can't aggregate them via groupBy, so we run parallel raw aggregates and
    // merge by key. Empty/missing values count as 0.
    const [byFeature, byModel, aiTotals, cachedTotalsRows, cachedByFeatureRows, cachedByModelRows] = await Promise.all([
      prisma.usageLog.groupBy({
        by: ["feature"],
        where: aiWhere,
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
        orderBy: { feature: "asc" },
      }),
      prisma.usageLog.groupBy({
        by: ["model"],
        where: aiWhere,
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
        orderBy: { model: "asc" },
      }),
      prisma.usageLog.aggregate({
        where: aiWhere,
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
      }),
      prisma.$queryRaw<Array<{ cached: bigint }>>`
        SELECT COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
      `,
      prisma.$queryRaw<Array<{ feature: string | null; cached: bigint }>>`
        SELECT feature,
               COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
        GROUP  BY feature
      `,
      prisma.$queryRaw<Array<{ model: string | null; cached: bigint }>>`
        SELECT model,
               COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
        GROUP  BY model
      `,
    ]);

    const cachedTotal = Number(cachedTotalsRows[0]?.cached ?? 0);
    const cachedByFeature = new Map(
      cachedByFeatureRows.map((r) => [r.feature ?? "unknown", Number(r.cached)]),
    );
    const cachedByModel = new Map(
      cachedByModelRows.map((r) => [r.model ?? "unknown", Number(r.cached)]),
    );

    const aiTokens = {
      totalTokens: aiTotals._sum.quantity || 0,
      promptTokens: aiTotals._sum.promptTokens || 0,
      completionTokens: aiTotals._sum.completionTokens || 0,
      costUsd: Number(aiTotals._sum.costUsd ?? 0),
      calls: aiTotals._count.id || 0,
      // Cache observability - derived from OpenAI's prompt_tokens_details.cached_tokens
      // captured in trackAIUsage(). Hit % is cached / total prompt; savings is the
      // 50%-discount applied at billing time vs. uncached.
      cachedPromptTokens: cachedTotal,
      byFeature: byFeature.map((r) => ({
        feature: r.feature ?? "unknown",
        totalTokens: r._sum.quantity || 0,
        promptTokens: r._sum.promptTokens || 0,
        completionTokens: r._sum.completionTokens || 0,
        cachedPromptTokens: cachedByFeature.get(r.feature ?? "unknown") ?? 0,
        costUsd: Number(r._sum.costUsd ?? 0),
        calls: r._count.id,
      })),
      byModel: byModel.map((r) => ({
        model: r.model ?? "unknown",
        totalTokens: r._sum.quantity || 0,
        promptTokens: r._sum.promptTokens || 0,
        completionTokens: r._sum.completionTokens || 0,
        cachedPromptTokens: cachedByModel.get(r.model ?? "unknown") ?? 0,
        costUsd: Number(r._sum.costUsd ?? 0),
        calls: r._count.id,
      })),
    };

    // Total events
    const totalEvents = await prisma.usageLog.count({ where: { createdAt: { gte: since } } });

    res.json({ data: { stats, aiTokens, totalEvents, period: days } });
  } catch (err) {
    console.error("System usage stats error:", err);
    res.status(500).json({ error: "Failed to get system usage stats" });
  }
});

// ─── System Admin: Usage by Tenant ──────────────────────────

router.get("/usage/by-tenant", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Per-tenant type totals (includes cost for ai_tokens rows)
    const byTenant = await prisma.usageLog.groupBy({
      by: ["tenantId", "type"],
      where: { createdAt: { gte: since } },
      _sum: { quantity: true, costUsd: true },
      _count: { id: true },
    });

    // Per-tenant AI feature breakdown - answers "which feature used how many
    // tokens per tenant" directly, no JSON probing needed.
    const [byTenantFeature, cachedByTenantFeatureRows] = await Promise.all([
      prisma.usageLog.groupBy({
        by: ["tenantId", "feature"],
        where: { type: "ai_tokens", createdAt: { gte: since } },
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
      }),
      // Cached tokens live on `metadata` JSONB; aggregate via raw SQL and merge
      // by (tenantId, feature) below. Missing values count as 0.
      prisma.$queryRaw<Array<{ tenant_id: string; feature: string | null; cached: bigint }>>`
        SELECT tenant_id,
               feature,
               COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
        GROUP  BY tenant_id, feature
      `,
    ]);
    const cachedByTenantFeature = new Map(
      cachedByTenantFeatureRows.map((r) => [`${r.tenant_id}::${r.feature ?? "unknown"}`, Number(r.cached)]),
    );

    // Get tenant names
    const tenantIds = [...new Set(byTenant.map((r) => r.tenantId))];
    const tenants = await prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, slug: true },
    });
    const tenantMap = new Map(tenants.map((t) => [t.id, t]));

    // Group by tenant
    const grouped: Record<
      string,
      {
        tenant: any;
        usage: Record<string, { total: number; count: number; costUsd: number }>;
        aiByFeature: Array<{
          feature: string;
          totalTokens: number;
          promptTokens: number;
          completionTokens: number;
          cachedPromptTokens: number;
          costUsd: number;
          calls: number;
        }>;
        aiCostUsd: number;
        aiCachedPromptTokens: number;
        aiPromptTokens: number;
      }
    > = {};
    for (const row of byTenant) {
      if (!grouped[row.tenantId]) {
        grouped[row.tenantId] = {
          tenant: tenantMap.get(row.tenantId) || { id: row.tenantId, name: "Unknown", slug: "" },
          usage: {},
          aiByFeature: [],
          aiCostUsd: 0,
          aiCachedPromptTokens: 0,
          aiPromptTokens: 0,
        };
      }
      grouped[row.tenantId].usage[row.type] = {
        total: row._sum.quantity || 0,
        count: row._count.id,
        costUsd: Number(row._sum.costUsd ?? 0),
      };
    }
    for (const row of byTenantFeature) {
      if (!grouped[row.tenantId]) continue;
      const cost = Number(row._sum.costUsd ?? 0);
      const cachedForRow =
        cachedByTenantFeature.get(`${row.tenantId}::${row.feature ?? "unknown"}`) ?? 0;
      const prompt = row._sum.promptTokens || 0;
      grouped[row.tenantId].aiByFeature.push({
        feature: row.feature ?? "unknown",
        totalTokens: row._sum.quantity || 0,
        promptTokens: prompt,
        completionTokens: row._sum.completionTokens || 0,
        cachedPromptTokens: cachedForRow,
        costUsd: cost,
        calls: row._count.id,
      });
      grouped[row.tenantId].aiCostUsd += cost;
      grouped[row.tenantId].aiCachedPromptTokens += cachedForRow;
      grouped[row.tenantId].aiPromptTokens += prompt;
    }

    // Sort by total usage descending
    const data = Object.values(grouped).sort((a, b) => {
      const aTotal = Object.values(a.usage).reduce((sum, u) => sum + u.total, 0);
      const bTotal = Object.values(b.usage).reduce((sum, u) => sum + u.total, 0);
      return bTotal - aTotal;
    });

    res.json({ data });
  } catch (err) {
    console.error("System usage by tenant error:", err);
    res.status(500).json({ error: "Failed to get usage by tenant" });
  }
});

// ─── System Admin: Pricing-Model Unit Economics ────────────
//
// Powers /system/pricing. For each customer-facing AI surface (Autonomous
// Agent, Inbox Co-pilot, Call-pilot, Embedded Chat, etc) we return raw
// totals plus unit averages: $/call and $/conversation. The frontend turns
// those into a pricing calculator (markup % → suggested price per unit) and
// a trends chart.
//
// Notes:
//  - Categorisation lives in @chatcenter/shared/lib/ai-feature-categories so
//    backend SQL CASE and frontend display labels stay in sync.
//  - We split prompt vs completion cost using AI_MODEL_PRICING because input
//    and output are billed at very different rates (e.g. gpt-4o = $2.50 in /
//    $10 out per 1M). The stored UsageLog.costUsd column already reflects
//    cache discounts; we re-derive the split here without re-applying them.
//  - Per-conversation averages count distinct `metadata.conversationId` -
//    embeddings and one-shot classifications won't have one, so those
//    categories return null for that metric.

router.get("/pricing/unit-costs", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    type CategoryAgg = {
      category: AiFeatureCategory;
      calls: bigint;
      conversations: bigint;
      prompt_tokens: bigint;
      completion_tokens: bigint;
      cached_prompt_tokens: bigint;
      total_tokens: bigint;
      cost_usd: string | number | null;
    };
    type CategoryModelAgg = {
      category: AiFeatureCategory;
      model: string | null;
      calls: bigint;
      prompt_tokens: bigint;
      completion_tokens: bigint;
      cached_prompt_tokens: bigint;
    };

    // The category CASE expression is built from the shared mapping so both
    // queries below classify identically.
    const caseSql = categorySqlCase("feature");

    const [byCategory, byCategoryModel] = await Promise.all([
      prisma.$queryRawUnsafe<CategoryAgg[]>(
        `
        SELECT
          ${caseSql} AS category,
          COUNT(*)::bigint AS calls,
          COUNT(DISTINCT metadata->>'conversationId')
            FILTER (WHERE metadata->>'conversationId' IS NOT NULL)::bigint AS conversations,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached_prompt_tokens,
          COALESCE(SUM(quantity), 0)::bigint AS total_tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM usage_logs
        WHERE type = 'ai_tokens' AND created_at >= $1
        GROUP BY category
        `,
        since,
      ),
      prisma.$queryRawUnsafe<CategoryModelAgg[]>(
        `
        SELECT
          ${caseSql} AS category,
          model,
          COUNT(*)::bigint AS calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached_prompt_tokens
        FROM usage_logs
        WHERE type = 'ai_tokens' AND created_at >= $1
        GROUP BY category, model
        `,
        since,
      ),
    ]);

    // Re-derive input vs output cost per category from real model mix. The
    // stored cost_usd column is the blended cached/uncached total; we want
    // to separate the input-side spend from the output-side spend so the
    // pricing calculator can show two rates (in vs out per 1K).
    const modelMixByCategory = new Map<AiFeatureCategory, CategoryModelAgg[]>();
    for (const row of byCategoryModel) {
      const k = row.category;
      const arr = modelMixByCategory.get(k) ?? [];
      arr.push(row);
      modelMixByCategory.set(k, arr);
    }

    const categoryDefMap = new Map(AI_FEATURE_CATEGORIES.map((d) => [d.key, d] as const));

    const categories = byCategory.map((row) => {
      const promptTokens = Number(row.prompt_tokens);
      const completionTokens = Number(row.completion_tokens);
      const cachedPromptTokens = Number(row.cached_prompt_tokens);
      const totalTokens = Number(row.total_tokens);
      const calls = Number(row.calls);
      const conversations = Number(row.conversations);
      const costUsd = Number(row.cost_usd ?? 0);

      // Per-model split: bill uncached prompt at full rate, cached at the
      // model's cached rate, completion at full rate. Mirrors trackAIUsage()'s
      // accounting via the same shared resolver (prefix-aware, gpt-5-safe).
      let inputCostUsd = 0;
      let outputCostUsd = 0;
      const modelMix = (modelMixByCategory.get(row.category) ?? []).map((m) => {
        const pricing = resolveModelPricing(m.model);
        const mPrompt = Number(m.prompt_tokens);
        const mCompletion = Number(m.completion_tokens);
        const mCached = Math.min(Number(m.cached_prompt_tokens), mPrompt);
        const mUncached = Math.max(0, mPrompt - mCached);
        const mIn =
          (mUncached / 1_000_000) * pricing.prompt +
          (mCached / 1_000_000) * (pricing.cachedPrompt ?? pricing.prompt * 0.5);
        const mOut = (mCompletion / 1_000_000) * pricing.completion;
        inputCostUsd += mIn;
        outputCostUsd += mOut;
        return {
          model: m.model ?? "unknown",
          calls: Number(m.calls),
          promptTokens: mPrompt,
          completionTokens: mCompletion,
          cachedPromptTokens: mCached,
          inputCostUsd: mIn,
          outputCostUsd: mOut,
        };
      });

      // Blended per-1K rates over the actual model mix consumed. Null when
      // there are no tokens of that direction (e.g. embeddings have no
      // completion tokens).
      const blendedInputUsdPer1K = promptTokens > 0 ? (inputCostUsd / promptTokens) * 1000 : null;
      const blendedOutputUsdPer1K =
        completionTokens > 0 ? (outputCostUsd / completionTokens) * 1000 : null;

      const def = categoryDefMap.get(row.category);

      return {
        category: row.category,
        label: def?.label ?? categoryLabel(row.category),
        description: def?.description ?? "",
        color: def?.color ?? "slate",
        perConversation: def?.perConversation ?? false,
        calls,
        conversations,
        promptTokens,
        completionTokens,
        cachedPromptTokens,
        totalTokens,
        costUsd,
        // Re-derived split - may drift slightly from stored costUsd because
        // of rounding; surface both so the dashboard can show observed total
        // and the in/out breakdown.
        inputCostUsd,
        outputCostUsd,
        blendedInputUsdPer1K,
        blendedOutputUsdPer1K,
        avgCostPerCall: calls > 0 ? costUsd / calls : 0,
        avgCostPerConversation: conversations > 0 ? costUsd / conversations : null,
        avgTokensPerCall: calls > 0 ? totalTokens / calls : 0,
        avgTokensPerConversation: conversations > 0 ? totalTokens / conversations : null,
        cacheHitPct: promptTokens > 0 ? (cachedPromptTokens / promptTokens) * 100 : null,
        modelMix,
      };
    });

    // Stable ordering - categories without any data still appear with zeros
    // so the calculator UI can offer them as inputs even before traffic.
    const present = new Map(categories.map((c) => [c.category, c]));
    const ordered = AI_CATEGORY_ORDER.map((key) => {
      if (present.has(key)) return present.get(key)!;
      const def = categoryDefMap.get(key);
      return {
        category: key,
        label: def?.label ?? categoryLabel(key),
        description: def?.description ?? "",
        color: def?.color ?? "slate",
        perConversation: def?.perConversation ?? false,
        calls: 0,
        conversations: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
        blendedInputUsdPer1K: null as number | null,
        blendedOutputUsdPer1K: null as number | null,
        avgCostPerCall: 0,
        avgCostPerConversation: null as number | null,
        avgTokensPerCall: 0,
        avgTokensPerConversation: null as number | null,
        cacheHitPct: null as number | null,
        modelMix: [] as Array<{
          model: string;
          calls: number;
          promptTokens: number;
          completionTokens: number;
          cachedPromptTokens: number;
          inputCostUsd: number;
          outputCostUsd: number;
        }>,
      };
    });

    const totals = ordered.reduce(
      (acc, c) => {
        acc.calls += c.calls;
        acc.conversations += c.conversations;
        acc.promptTokens += c.promptTokens;
        acc.completionTokens += c.completionTokens;
        acc.cachedPromptTokens += c.cachedPromptTokens;
        acc.totalTokens += c.totalTokens;
        acc.costUsd += c.costUsd;
        acc.inputCostUsd += c.inputCostUsd;
        acc.outputCostUsd += c.outputCostUsd;
        return acc;
      },
      {
        calls: 0,
        conversations: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
      },
    );

    res.json({
      data: {
        period: days,
        categories: ordered,
        totals,
        // Echo pricing table so the calculator can render "what we pay per
        // 1M tokens per model" without an extra round-trip.
        pricing: AI_MODEL_PRICING,
      },
    });
  } catch (err) {
    console.error("Pricing unit-costs error:", err);
    res.status(500).json({ error: "Failed to compute pricing unit costs" });
  }
});

// ─── System Admin: Pricing-Model Cost Trends ────────────────
//
// Daily cost-per-category buckets for the period. Used by the trends chart
// on /system/pricing. Returns dense buckets (zero-filled) so the chart x-axis
// never has gaps.

router.get("/pricing/trends", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    since.setUTCHours(0, 0, 0, 0);

    const caseSql = categorySqlCase("feature");

    type TrendRow = {
      day: Date;
      category: AiFeatureCategory;
      cost_usd: string | number | null;
      calls: bigint;
    };
    const rows = await prisma.$queryRawUnsafe<TrendRow[]>(
      `
      SELECT
        date_trunc('day', created_at)::date AS day,
        ${caseSql} AS category,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COUNT(*)::bigint AS calls
      FROM usage_logs
      WHERE type = 'ai_tokens' AND created_at >= $1
      GROUP BY day, category
      ORDER BY day
      `,
      since,
    );

    // Build the full day list (UTC) - zero-fill missing days so the chart
    // shows a continuous timeline.
    const dayList: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      dayList.push(d.toISOString().slice(0, 10));
    }

    // Pre-seed zero series per category in stable order.
    const seriesMap = new Map<AiFeatureCategory, { cost: number[]; calls: number[] }>();
    for (const key of AI_CATEGORY_ORDER) {
      seriesMap.set(key, {
        cost: new Array(dayList.length).fill(0),
        calls: new Array(dayList.length).fill(0),
      });
    }
    const dayIndex = new Map(dayList.map((d, i) => [d, i] as const));

    for (const row of rows) {
      const dayStr = (row.day instanceof Date ? row.day : new Date(row.day))
        .toISOString()
        .slice(0, 10);
      const idx = dayIndex.get(dayStr);
      if (idx === undefined) continue;
      const series = seriesMap.get(row.category) ?? seriesMap.get("other")!;
      series.cost[idx] = Number(row.cost_usd ?? 0);
      series.calls[idx] = Number(row.calls);
    }

    const categoryDefMap = new Map(AI_FEATURE_CATEGORIES.map((d) => [d.key, d] as const));
    const series = AI_CATEGORY_ORDER.map((key) => {
      const def = categoryDefMap.get(key);
      const s = seriesMap.get(key)!;
      return {
        category: key,
        label: def?.label ?? categoryLabel(key),
        color: def?.color ?? "slate",
        cost: s.cost,
        calls: s.calls,
      };
    });

    res.json({
      data: {
        period: days,
        days: dayList,
        series,
      },
    });
  } catch (err) {
    console.error("Pricing trends error:", err);
    res.status(500).json({ error: "Failed to compute pricing trends" });
  }
});

export default router;
