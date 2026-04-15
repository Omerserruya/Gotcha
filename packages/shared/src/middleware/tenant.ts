import { Request, Response, NextFunction } from "express";

/**
 * Resolve the tenant context for a request.
 *
 * RULES (strict — prevents the cross-tenant data leak that was possible
 * when tenantId silently resolved to `undefined`):
 *
 *  - Non-admin users: the JWT's `tenantId` claim is authoritative. Any
 *    `x-tenant-id` header or `:tenantId` path param from the client is
 *    IGNORED — it cannot override the JWT. If the JWT has no tenantId,
 *    the request is rejected with 400.
 *  - SYSTEM_ADMIN: may explicitly impersonate a tenant via `:tenantId`
 *    path param, `x-tenant-id` header, or their own JWT tenant. If none
 *    of those resolve, the request is REJECTED — previously we silently
 *    called `next()` with `req.tenantId === undefined`, which Prisma
 *    then treated as "no filter" and returned cross-tenant rows. That
 *    behavior is gone.
 *
 * Routes that are genuinely tenantless (system-level admin endpoints
 * like /api/system/tenants, /api/system/usage/stats) MUST NOT mount
 * this middleware — use `requireSystemAdmin()` directly. If you need
 * both (an admin acting on a tenant), mount
 * `authenticate, resolveTenant, requireSystemAdmin()`.
 */
export function resolveTenant(req: Request, res: Response, next: NextFunction): void {
  const jwtTenantId = req.user?.tenantId;
  const role = req.user?.role;

  // Non-admin: JWT is the only source of truth. Client-supplied headers
  // and path params are ignored — they cannot widen the tenant scope.
  if (role !== "SYSTEM_ADMIN") {
    if (!jwtTenantId) {
      res.status(400).json({ error: "Tenant context required" });
      return;
    }
    req.tenantId = jwtTenantId;
    next();
    return;
  }

  // SYSTEM_ADMIN: accept explicit impersonation via path/header, else fall
  // back to the admin's own JWT tenant (admins also belong to a tenant).
  const pathValue = req.params.tenantId;
  const pathTenant = Array.isArray(pathValue) ? pathValue[0] : pathValue;
  const headerValue = req.headers["x-tenant-id"];
  const headerTenant = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const resolved = pathTenant || headerTenant || jwtTenantId;

  if (!resolved) {
    res.status(400).json({
      error:
        "SYSTEM_ADMIN requests on tenant-scoped routes require an explicit tenant (path param or x-tenant-id header).",
    });
    return;
  }
  req.tenantId = resolved;
  next();
}

/**
 * Runtime assertion used inside route handlers. Throws if req.tenantId
 * is missing, so a missing filter becomes an obvious 500 instead of a
 * silent cross-tenant query.
 *
 *   const tenantId = assertTenantId(req);
 *   const kbs = await prisma.knowledgeBase.findMany({ where: { tenantId } });
 */
export function assertTenantId(req: Request): string {
  const t = req.tenantId;
  if (!t || typeof t !== "string") {
    throw new Error(
      "assertTenantId: req.tenantId is missing. Mount resolveTenant + requireActiveTenant before this handler, or use an explicit system-admin route that does not need tenant context.",
    );
  }
  return t;
}
