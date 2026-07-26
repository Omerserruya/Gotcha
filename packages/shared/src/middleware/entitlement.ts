/**
 * Server-side entitlement gates as Express middleware.
 *
 * Hiding a menu item is not enforcement. Every route that performs a real
 * operation behind a paid capability mounts `requireEntitlement()`, and every
 * create path behind a numeric limit calls `assertWithinLimit()` (or mounts
 * `requireCapacity()`) before it writes.
 *
 * Denials return a structured 402 the frontend can act on:
 *
 *   { "code": "PLAN_FEATURE_REQUIRED", "feature": "ai.employee",
 *     "currentPlan": "foundation", "upgradePath": "/settings/billing/plan" }
 *
 * The body deliberately carries no pricing configuration, no plan catalog
 * internals and no cost data.
 */
import type { Request, Response, NextFunction } from "express";
import {
  assertEntitled,
  assertWithinLimit,
  EntitlementDeniedError,
  entitlementErrorResponse,
} from "../lib/billing/entitlement-resolver";

/** Require a BOOLEAN capability (`ai.employee`, `voice.call_pilot`, …). */
export function requireEntitlement(featureKey: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenant_required" });
      return;
    }
    try {
      await assertEntitled(tenantId, featureKey);
      next();
    } catch (err) {
      const mapped = entitlementErrorResponse(err);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      next(err);
    }
  };
}

/**
 * Require headroom under a numeric limit before a create route runs.
 * `countCurrent` reports how many the organization already has.
 */
export function requireCapacity(
  limitKey: string,
  countCurrent: (tenantId: string, req: Request) => Promise<number>,
  adding = 1,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenant_required" });
      return;
    }
    try {
      await assertWithinLimit(tenantId, limitKey, await countCurrent(tenantId, req), adding);
      next();
    } catch (err) {
      const mapped = entitlementErrorResponse(err);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      next(err);
    }
  };
}

/**
 * Error handler shim for routes that call `assertEntitled` / `assertWithinLimit`
 * inline inside a try/catch. Returns true when it handled the error.
 */
export function handleEntitlementError(err: unknown, res: Response): boolean {
  const mapped = entitlementErrorResponse(err);
  if (!mapped) return false;
  res.status(mapped.status).json(mapped.body);
  return true;
}

export { EntitlementDeniedError };
