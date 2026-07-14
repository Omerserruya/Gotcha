import { Request, Response, NextFunction } from "express";
import { getEffectiveBuiltinRole } from "../lib/permissions";

/**
 * Map a requested legacy role name to the set of acceptable built-in role keys.
 * This bridges the coarse `Role` enum gates (used across all services) onto the
 * new assignment model, so a user's ASSIGNED role governs access everywhere -
 * e.g. a user with the "Admin" built-in role passes requireRole("ADMIN") even
 * if their legacy enum is still AGENT.
 *
 *   "ADMIN"   → owner, admin                 (tenant administrators)
 *   "MANAGER" → owner, admin, department_manager
 *   "AGENT"   → owner, admin, department_manager, agent  (any member)
 */
function acceptableBuiltins(roles: string[]): Set<string> {
  const accept = new Set<string>();
  for (const r of roles) {
    if (r === "ADMIN") { accept.add("owner"); accept.add("admin"); }
    else if (r === "MANAGER") { accept.add("owner"); accept.add("admin"); accept.add("department_manager"); }
    else if (r === "AGENT") { accept.add("owner"); accept.add("admin"); accept.add("department_manager"); accept.add("agent"); }
  }
  return accept;
}

export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    // SYSTEM_ADMIN (platform tier) bypasses all role checks.
    if (req.user.role === "SYSTEM_ADMIN") {
      next();
      return;
    }
    // Fast path: legacy enum still satisfies the gate (unchanged behavior for
    // users whose assigned role matches their enum).
    if (roles.includes(req.user.role)) {
      next();
      return;
    }
    // Resolver-backed bridge: honor the user's ASSIGNED built-in role.
    try {
      const effective = await getEffectiveBuiltinRole({
        userId: req.user.userId,
        tenantId: req.tenantId || req.user.tenantId,
        role: req.user.role,
        departmentRole: req.user.departmentRole,
      });
      if (effective && acceptableBuiltins(roles).has(effective)) {
        next();
        return;
      }
    } catch {
      // Resolver/DB error → fall through to deny (legacy enum already checked).
    }
    res.status(403).json({ error: "Insufficient permissions" });
  };
}

export function requireSystemAdmin() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (req.user.role !== "SYSTEM_ADMIN") {
      res.status(403).json({ error: "System admin access required" });
      return;
    }
    next();
  };
}

export function requireDepartmentRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    // SYSTEM_ADMIN and ADMIN bypass department role checks
    if (req.user.role === "SYSTEM_ADMIN" || req.user.role === "ADMIN") {
      next();
      return;
    }
    if (!req.user.departmentRole || !roles.includes(req.user.departmentRole)) {
      res.status(403).json({ error: "Insufficient department permissions" });
      return;
    }
    next();
  };
}
