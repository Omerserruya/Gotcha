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

    // Every request on a tenant-scoped route MUST have a resolved tenant
    // context by this point — even SYSTEM_ADMINs. This is the backstop
    // against the silent-cross-tenant-read bug: if req.tenantId is
    // undefined, Prisma drops `where: { tenantId }` filters and returns
    // everyone's data. Fail loudly.
    if (!req.tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }

    // System admins bypass the ACTIVE-status check (so they can operate
    // on pending/suspended tenants for recovery) BUT they still need a
    // resolved tenant — that was already enforced above.
    if (req.user.role === "SYSTEM_ADMIN") {
      next();
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
