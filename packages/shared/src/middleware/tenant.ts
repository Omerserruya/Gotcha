import { Request, Response, NextFunction } from "express";

export function resolveTenant(req: Request, res: Response, next: NextFunction): void {
  // Check for tenant ID from path parameter (/:tenantId/api/...)
  if (req.params.tenantId) {
    const paramValue = req.params.tenantId;
    req.tenantId = Array.isArray(paramValue) ? paramValue[0] : paramValue;
  }
  // Check for tenant ID from nginx header (X-Tenant-ID)
  if (req.headers["x-tenant-id"] && !req.tenantId) {
    const headerValue = req.headers["x-tenant-id"];
    req.tenantId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  }
  // Fallback to JWT payload tenant
  if (!req.tenantId && req.user?.tenantId) {
    req.tenantId = req.user.tenantId;
  }

  if (!req.tenantId) {
    res.status(400).json({ error: "Tenant context required" });
    return;
  }
  next();
}
