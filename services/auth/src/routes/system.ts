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
} from "@chatcenter/shared";
import { sendOnboardingEmail } from "../services/notification.service";

const router = Router();
const SALT_ROUNDS = 10;

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
      prisma.departmentCopilotConfig.deleteMany({ where: { department: { tenantId } } }),
      prisma.departmentMember.deleteMany({ where: { department: { tenantId } } }),
      prisma.department.deleteMany({ where: { tenantId } }),
      prisma.channelAccount.deleteMany({ where: { tenantId } }),
      prisma.copilotConfig.deleteMany({ where: { tenantId } }),
      prisma.firstTakeCareConfig.deleteMany({ where: { tenantId } }),
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

// ─── Toggle User Active Status ───────────────────────────────

router.patch("/tenants/:id/users/:userId", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId as string, tenantId: req.params.id as string },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { isActive, role } = req.body;
    const data: any = {};
    if (typeof isActive === "boolean") data.isActive = isActive;
    if (role && ["ADMIN", "AGENT"].includes(role)) data.role = role;

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

    // If enabling AUTONOMOUS_AI, auto-create FirstTakeCareConfig if missing
    if (botEnabled && botType === "AUTONOMOUS_AI") {
      await prisma.firstTakeCareConfig.upsert({
        where: { tenantId: req.params.id as string },
        update: {},
        create: { tenantId: req.params.id as string },
      });
    }

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

    // If enabling for the first time, create a default FirstTakeCareConfig if none exists
    if (enabled) {
      await prisma.firstTakeCareConfig.upsert({
        where: { tenantId: req.params.id as string },
        update: {},
        create: { tenantId: req.params.id as string },
      });
    }

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

export default router;
