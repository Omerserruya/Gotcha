import { Router, Request, Response } from "express";
import { z } from "zod";
import { validate, authenticate, prisma, signToken, generateRefreshToken, getJwtExpiresInMs } from "@chatcenter/shared";
import * as authService from "../services/auth.service";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.enum(["SYSTEM_ADMIN", "ADMIN", "AGENT"]).optional(),
  tenantSlug: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: z.string().min(1),
});

router.post("/register", validate(registerSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, role, tenantSlug } = req.body;
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    const result = await authService.register(tenant.id, email, password, name, role);
    res.status(201).json(result);
  } catch (err: any) {
    if (err.message?.includes("already exists")) { res.status(409).json({ error: err.message }); return; }
    console.error("Register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/login", validate(loginSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, tenantSlug } = req.body;
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    const result = await authService.login(tenant.id, email, password);
    res.json(result);
  } catch (err: any) {
    if (err.message === "Invalid email or password") { res.status(401).json({ error: err.message }); return; }
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Magic Link Verification (passwordless onboarding) ──────

const verifyMagicLinkSchema = z.object({
  token: z.string().min(1),
});

router.post("/verify-magic-link", validate(verifyMagicLinkSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.body;

    const magicLink = await prisma.magicLink.findUnique({ where: { token } });
    if (!magicLink) {
      res.status(401).json({ error: "Invalid or expired link" });
      return;
    }

    if (magicLink.usedAt) {
      res.status(401).json({ error: "This link has already been used. Please log in instead." });
      return;
    }

    if (new Date() > magicLink.expiresAt) {
      res.status(401).json({ error: "This link has expired. Please contact your administrator for a new one." });
      return;
    }

    // Mark as used
    await prisma.magicLink.update({
      where: { id: magicLink.id },
      data: { usedAt: new Date() },
    });

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: magicLink.userId },
      select: { id: true, email: true, name: true, role: true, tenantId: true, isActive: true },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ error: "User account is not available" });
      return;
    }

    // Get tenant status
    const tenant = await prisma.tenant.findUnique({
      where: { id: magicLink.tenantId },
      select: { status: true, slug: true },
    });

    // Transition tenant from PENDING_ADMIN_SETUP to PENDING_ONBOARDING
    if (user.role === "ADMIN" && tenant?.status === "PENDING_ADMIN_SETUP") {
      await prisma.tenant.update({
        where: { id: magicLink.tenantId },
        data: { status: "PENDING_ONBOARDING" },
      });
    }

    // Get department info
    const member = await prisma.departmentMember.findUnique({
      where: { userId: user.id },
      include: { department: { select: { id: true, name: true } } },
    });
    const deptInfo = member ? {
      departmentId: member.departmentId,
      departmentRole: member.departmentRole,
      departmentName: member.department.name,
    } : {};

    // Sign JWT
    const jwt = signToken({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
      departmentId: deptInfo.departmentId,
      departmentRole: deptInfo.departmentRole,
    });

    // Generate refresh token
    const refresh = generateRefreshToken();
    await prisma.refreshToken.create({
      data: { token: refresh.token, userId: user.id, tenantId: user.tenantId, expiresAt: refresh.expiresAt },
    });

    res.json({
      token: jwt,
      refreshToken: refresh.token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId, ...deptInfo },
      tenantStatus: tenant?.status || "ACTIVE",
    });
  } catch (err) {
    console.error("Magic link verification error:", err);
    res.status(500).json({ error: "Failed to verify link" });
  }
});

// ─── Refresh Token ──────────────────────────────────────────

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

router.post("/refresh", validate(refreshSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;

    // Find and validate refresh token
    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
      if (stored) await prisma.refreshToken.delete({ where: { id: stored.id } });
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    // Verify user is still active
    const user = await prisma.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, email: true, name: true, role: true, tenantId: true, isActive: true },
    });
    if (!user || !user.isActive) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
      res.status(401).json({ error: "Account is not active" });
      return;
    }

    // Get department info
    const member = await prisma.departmentMember.findUnique({
      where: { userId: user.id },
      include: { department: { select: { id: true, name: true } } },
    });
    const deptInfo = member ? {
      departmentId: member.departmentId,
      departmentRole: member.departmentRole,
      departmentName: member.department.name,
    } : {};

    // Issue new access token
    const newToken = signToken({
      userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email,
      departmentId: deptInfo.departmentId, departmentRole: deptInfo.departmentRole,
    });

    // Rotate refresh token (delete old, create new)
    const newRefresh = generateRefreshToken();
    await prisma.$transaction([
      prisma.refreshToken.delete({ where: { id: stored.id } }),
      prisma.refreshToken.create({
        data: { token: newRefresh.token, userId: user.id, tenantId: user.tenantId, expiresAt: newRefresh.expiresAt },
      }),
    ]);

    res.json({
      token: newToken,
      refreshToken: newRefresh.token,
      expiresIn: getJwtExpiresInMs(),
    });
  } catch (err) {
    console.error("Token refresh error:", err);
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

router.get("/me", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, name: true, role: true, tenantId: true, isActive: true, createdAt: true },
    });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    // Include department info
    const member = await prisma.departmentMember.findUnique({
      where: { userId: user.id },
      include: { department: { select: { id: true, name: true } } },
    });
    const deptInfo = member ? {
      departmentId: member.departmentId,
      departmentRole: member.departmentRole,
      departmentName: member.department.name,
    } : {};

    res.json({ user: { ...user, ...deptInfo } });
  } catch { res.status(500).json({ error: "Internal server error" }); }
});

// ─── Change Password ─────────────────────────────────────────
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post("/change-password", authenticate, validate(changePasswordSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body;
    await authService.changePassword(req.user!.tenantId, req.user!.userId, currentPassword, newPassword);
    res.json({ success: true });
  } catch (err: any) {
    if (err.message === "Invalid current password") { res.status(400).json({ error: err.message }); return; }
    console.error("Change password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Forgot Password (request reset link) ────────────────────
const forgotPasswordSchema = z.object({
  email: z.string().email(),
  tenantSlug: z.string().min(1),
});

router.post("/forgot-password", validate(forgotPasswordSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, tenantSlug } = req.body;
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) {
      // Don't leak tenant existence - always return success
      res.json({ success: true, message: "If the email exists, a reset link has been sent." });
      return;
    }
    const result = await authService.createPasswordResetToken(tenant.id, email);
    if (result) {
      // Import and call sendPasswordResetEmail from notification service
      const { sendPasswordResetEmail } = await import("../services/notification.service");
      const user = await prisma.user.findFirst({ where: { id: result.userId }, select: { name: true } });
      await sendPasswordResetEmail(tenant.id, email, user?.name || "User", tenant.name, result.token);
    }
    // Always return success to prevent email enumeration
    res.json({ success: true, message: "If the email exists, a reset link has been sent." });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Reset Password (with token) ─────────────────────────────
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post("/reset-password", validate(resetPasswordSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, newPassword } = req.body;
    await authService.resetPassword(token, newPassword);
    res.json({ success: true });
  } catch (err: any) {
    if (err.message?.includes("Invalid") || err.message?.includes("expired") || err.message?.includes("used")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
