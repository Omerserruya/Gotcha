import { Router, Request, Response } from "express";
import { authenticate, prisma } from "@chatcenter/shared";

/**
 * Session routes.
 *
 * Everything that used to live here - register, login, magic-link, refresh,
 * change-password, forgot-password, reset-password - is now Authentik's job.
 * GOTCHA cannot issue, refresh, or reset a credential, by construction: it has
 * no signing key and stores no password.
 *
 * What remains is the profile lookup: given an identity Authentik has already
 * proven, tell the caller who they are *in GOTCHA* - tenant, role, department.
 * That is business data, and it stays here.
 */
const router = Router();

router.get("/me", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tenantId: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const member = await prisma.departmentMember.findUnique({
      where: { userId: user.id },
      include: { department: { select: { id: true, name: true } } },
    });
    const deptInfo = member
      ? {
          departmentId: member.departmentId,
          departmentRole: member.departmentRole,
          departmentName: member.department.name,
        }
      : {};

    const tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { status: true },
    });

    res.json({ user: { ...user, ...deptInfo }, tenantStatus: tenant?.status || "ACTIVE" });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
