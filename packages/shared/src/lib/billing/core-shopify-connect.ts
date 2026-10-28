/**
 * A store can be connected only after GOTCHA Core is paid (Omer, 2026-10-28).
 *
 * ONE rule, answered by the same function the install claim has always run
 * (`requireActiveTenant`: the tenant's status and its plan facts, FULL_APPLICATION),
 * so the billing screen's `core.allowsShopifyConnect` can never disagree with
 * the claim that refuses. Core decides only whether a store may be CONNECTED;
 * it never grants a Shopify capability (that is the Connector's, billed by
 * Shopify).
 */
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma";
import { evaluateTenantAccess, tenantAccessErrorBody } from "../tenant-access-policy";
import { tenantPlanGateFacts } from "./tenant-plan-resolver";

export interface CoreShopifyConnect {
  allowed: boolean;
  /** The access policy's stable code when refused (e.g. TENANT_PAYMENT_REQUIRED); null when allowed. */
  reason: string | null;
  httpStatus: number;
  body: Record<string, unknown> | null;
  tenantStatus: string | null;
}

export async function coreAllowsShopifyConnect(tenantId: string): Promise<CoreShopifyConnect> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  if (!tenant) return { allowed: false, reason: "TENANT_NOT_FOUND", httpStatus: 404, body: null, tenantStatus: null };
  const facts = await tenantPlanGateFacts(tenantId);
  const decision = evaluateTenantAccess(tenant.status, "FULL_APPLICATION", facts.unknown ? undefined : facts);
  if (decision.allow) return { allowed: true, reason: null, httpStatus: 200, body: null, tenantStatus: tenant.status };
  return {
    allowed: false,
    reason: decision.code,
    httpStatus: decision.httpStatus,
    body: tenantAccessErrorBody(decision),
    tenantStatus: tenant.status,
  };
}

/** The refusal both connect routes send: a stable code the UI shows in plain words. */
export const CORE_PLAN_REQUIRED = "core_plan_required";

/**
 * Express gate for the Shopify install start and claim. A system admin passes,
 * as with `requireActiveTenant`.
 */
export function requireCoreForShopifyConnect() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!req.tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }
    if ((req.user as any).role === "SYSTEM_ADMIN") {
      next();
      return;
    }
    const gate = await coreAllowsShopifyConnect(req.tenantId);
    if (gate.allowed) {
      next();
      return;
    }
    res.status(gate.httpStatus === 404 ? 404 : 402).json({
      error: CORE_PLAN_REQUIRED,
      scope: "gotcha_core",
      billedBy: "gotcha",
      tenantStatus: gate.tenantStatus,
      ...(gate.body ?? {}),
    });
  };
}
