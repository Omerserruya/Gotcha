import type { Request, Response, NextFunction } from "express";
import { hasPermission, type PermissionPrincipal } from "../lib/permissions";

/**
 * Express middleware: gate a route on a hierarchical permission key
 * (`feature:sub-feature:action`). Fully data-driven - resolves through the
 * permission resolver (License → grant → role). No role names are matched.
 *
 * Usage:
 *   router.post(
 *     "/agents",
 *     authenticate,
 *     resolveTenant,
 *     requirePermission("settings:members:manage"),
 *     handler,
 *   );
 *
 * Pass multiple keys to require ANY of them (OR semantics).
 */
export function requirePermission(...permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const tenantId = req.tenantId || req.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }
    const principal: PermissionPrincipal = {
      userId: req.user.userId,
      tenantId,
      role: req.user.role,
      departmentRole: req.user.departmentRole,
    };
    try {
      for (const key of permissions) {
        if (await hasPermission(principal, key)) {
          next();
          return;
        }
      }
      res.status(403).json({
        error: "Permission denied",
        code: "PERMISSION_DENIED",
        permissions,
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Permission-FIRST gate with a legacy-role safety net.
 *
 * The permission catalog denies when the tenant is not LICENSED for a key's
 * domain - correct for feature areas, but core administration (managing
 * members, workspace security) must never lock out an ADMIN of a tenant whose
 * licensing predates the catalog. This gate resolves the permission first
 * (the enforcement layer we are migrating to); only when it denies does it
 * fall back to the coarse legacy roles, so behavior is never WORSE than the
 * old requireRole gate.
 *
 * TRANSITIONAL: delete the fallback once every tenant's licensing covers the
 * `settings` domain - at that point these routes become requirePermission.
 */
export function requirePermissionOrRole(permission: string, ...fallbackRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const tenantId = req.tenantId || req.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }
    try {
      const principal: PermissionPrincipal = {
        userId: req.user.userId,
        tenantId,
        role: req.user.role,
        departmentRole: req.user.departmentRole,
      };
      if (await hasPermission(principal, permission)) {
        next();
        return;
      }
    } catch {
      // Resolver error → the legacy-role check below still decides.
    }
    if (req.user.role === "SYSTEM_ADMIN" || fallbackRoles.includes(req.user.role)) {
      next();
      return;
    }
    res.status(403).json({
      error: "Permission denied",
      code: "PERMISSION_DENIED",
      permissions: [permission],
    });
  };
}
