import { Router, Request, Response } from "express";
import { z } from "zod";
import { validate, authenticate, prisma } from "@chatcenter/shared";
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

export default router;
