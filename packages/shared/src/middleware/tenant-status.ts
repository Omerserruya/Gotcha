import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import {
  evaluateTenantAccess,
  tenantAccessErrorBody,
  type TenantAccessScope,
} from "../lib/tenant-access-policy";

/**
 * Tenant status gates.
 *
 * All three variants below defer to ONE matrix in lib/tenant-access-policy, so
 * the allowlist is not duplicated per service and a new status cannot be
 * handled inconsistently in different places.
 */

/** Shared resolution + policy application. */
function gate(scope: TenantAccessScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // Every request on a tenant-scoped route MUST have a resolved tenant
    // context by this point - even SYSTEM_ADMINs. This is the backstop
    // against the silent-cross-tenant-read bug: if req.tenantId is
    // undefined, Prisma drops `where: { tenantId }` filters and returns
    // everyone's data. Fail loudly.
    if (!req.tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }

    // System admins bypass the status check (so they can operate on
    // pending/suspended tenants for recovery) BUT they still need a resolved
    // tenant - that was already enforced above.
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

    const decision = evaluateTenantAccess(tenant.status, scope);
    if (!decision.allow) {
      res.status(decision.httpStatus).json({
        // `error` and `tenantStatus` are retained for existing consumers; the
        // structured `code` is what new clients should branch on.
        error: "Tenant is not active",
        tenantStatus: tenant.status,
        ...tenantAccessErrorBody(decision),
      });
      return;
    }

    next();
  };
}

/**
 * The paid product: inbox, conversations, AI, channels, integrations, customer
 * data, workflows, knowledge. ACTIVE only.
 */
export function requireActiveTenant() {
  return gate("FULL_APPLICATION");
}

/**
 * Endpoints that must be reachable DURING onboarding - notably connecting the
 * "source of truth" core system (CRM / Shopify), which is itself the activation
 * event. Without this, "connect your CRM" would 403, a chicken-and-egg since
 * connecting is what flips the tenant to ACTIVE.
 *
 * Also permits PENDING_PAYMENT, so a paid tenant awaiting its first payment can
 * still complete identity and organization setup while it waits.
 */
export function requireOnboardingOrActiveTenant() {
  return gate("ONBOARDING");
}

/**
 * Payment setup and the safe checkout surface: the routes a tenant that owes
 * its first payment must be able to reach in order to resolve that. Notably
 * NOT reachable by a SUSPENDED tenant, which may not self-serve back in.
 */
export function requirePaymentSetupAccess() {
  return gate("PAYMENT_SETUP");
}
