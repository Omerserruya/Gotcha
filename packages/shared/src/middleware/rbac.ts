import { Request, Response, NextFunction } from "express";

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    // SYSTEM_ADMIN bypasses all role checks
    if (req.user.role === "SYSTEM_ADMIN") {
      next();
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
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
