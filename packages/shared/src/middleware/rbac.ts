import { Request, Response, NextFunction } from "express";

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
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
    // ADMIN bypasses department role checks
    if (req.user.role === "ADMIN") {
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
