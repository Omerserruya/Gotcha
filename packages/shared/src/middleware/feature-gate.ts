import type { Request, Response, NextFunction } from "express";
import { hasFeature, isFeatureEnabledForTenant } from "../lib/permissions";
import type { Feature } from "../lib/features";

/**
 * Express middleware: gate a route on a two-layer feature check.
 *
 * Resolution mirrors `hasFeature()` in permissions.ts:
 *   SYSTEM_ADMIN bypass → tenant enabled? → user-level access?
 *
 * Returns a structured 403 body so the frontend can render a meaningful
 * "feature unavailable" state instead of a generic permission error.
 *
 * Usage:
 *   router.post(
 *     "/orders/auto-buy",
 *     authenticate,
 *     resolveTenant,
 *     requireFeature(FEATURES.AUTO_BUY),
 *     handler,
 *   );
 */
export function requireFeature(feature: Feature) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const tenantId = req.user.tenantId || req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }

    try {
      // Cheap pre-check so we can distinguish tenant- vs user-level denial in
      // the response body — the frontend uses this to choose copy ("contact
      // your sysadmin to enable" vs "contact your tenant admin for access").
      const tenantOk = await isFeatureEnabledForTenant(tenantId, feature);
      if (!tenantOk && req.user.role !== "SYSTEM_ADMIN") {
        res.status(403).json({
          error: "Feature not available",
          code: "FEATURE_NOT_AVAILABLE",
          feature,
          scope: "tenant",
        });
        return;
      }

      const ok = await hasFeature(
        { userId: req.user.userId, tenantId, role: req.user.role },
        feature,
      );
      if (!ok) {
        res.status(403).json({
          error: "Feature not available",
          code: "FEATURE_NOT_AVAILABLE",
          feature,
          scope: "user",
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Tenant-only gate (skips user-level checks). Useful for endpoints that any
 * authenticated user in a feature-enabled tenant should hit (e.g. listing
 * feature config without needing per-user access).
 */
export function requireTenantFeature(feature: Feature) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (req.user.role === "SYSTEM_ADMIN") {
      next();
      return;
    }
    const tenantId = req.user.tenantId || req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }
    try {
      const ok = await isFeatureEnabledForTenant(tenantId, feature);
      if (!ok) {
        res.status(403).json({
          error: "Feature not available",
          code: "FEATURE_NOT_AVAILABLE",
          feature,
          scope: "tenant",
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
