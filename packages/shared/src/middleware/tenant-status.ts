import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

/**
 * Middleware that blocks conversation processing and other tenant operations
 * when tenant status is not ACTIVE. System admins bypass this check.
 */
export function requireActiveTenant() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // System admins bypass tenant status checks
    if (req.user.role === "SYSTEM_ADMIN") {
      next();
      return;
    }

    if (!req.tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: { status: true },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (tenant.status !== "ACTIVE") {
      res.status(403).json({
        error: "Tenant is not active",
        tenantStatus: tenant.status,
        message: tenant.status === "PENDING_ADMIN_SETUP"
          ? "Admin setup is required before using the platform"
          : tenant.status === "PENDING_ONBOARDING"
            ? "Organization onboarding must be completed before using the platform"
            : "This tenant account is suspended",
      });
      return;
    }

    next();
  };
}
