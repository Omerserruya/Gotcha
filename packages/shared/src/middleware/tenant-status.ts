import { reportOperationalFailure } from "../lib/observability/operational-failure";
import { ERROR_CODES } from "../lib/observability/error-codes";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import {
  evaluateTenantAccess,
  tenantAccessErrorBody,
  type TenantAccessScope,
  type TenantPlanAccessFacts,
} from "../lib/tenant-access-policy";
import { tenantPlanGateFacts } from "../lib/billing/tenant-plan-resolver";

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
      // NOT a denied request - an INVARIANT failure. The caller is
      // authenticated and reached a tenant-scoped route with no tenant
      // resolved, which is the precondition for Prisma dropping its
      // `where: { tenantId }` filter and returning every tenant's rows. The
      // request is refused here, so nothing leaked; that this state was
      // reachable at all is the thing worth waking someone for.
      reportOperationalFailure({
        errorCode: ERROR_CODES.authorization_invariant_broken,
        domain: "security", service: "shared",
        context: { invariant: "tenant_scoped_route_without_tenant", scope, role: String(req.user.role) },
      });
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

    // Only the paid product asks the commercial question, so onboarding and
    // payment setup cost no extra query - and those are precisely the flows a
    // tenant without a plan has to be able to reach.
    let planAccess: TenantPlanAccessFacts | undefined;
    if (scope === "FULL_APPLICATION") {
      const facts = await tenantPlanGateFacts(req.tenantId);
      // `unknown` means the plan state could not be read. Denying on it would
      // turn a database blip into every paying organization losing the product
      // at once; the entitlement gate makes the same call for the same reason.
      if (!facts.unknown) planAccess = facts;
    }

    const decision = evaluateTenantAccess(tenant.status, scope, planAccess);
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
 * data, workflows, knowledge. ACTIVE *and* holding an active access source -
 * a paid subscription, a POC, a trial, or a manual contract.
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
