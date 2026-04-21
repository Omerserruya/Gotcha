import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  try {
    const token = header.slice(7);

    // Internal service-to-service calls use a shared secret instead of a JWT.
    // The caller must also set x-tenant-id so we know which tenant scope to use.
    const internalKey = process.env.INTERNAL_SERVICE_KEY || process.env.INTERNAL_SERVICE_TOKEN;
    if (internalKey && token === internalKey) {
      const tenantId = req.headers["x-tenant-id"] as string | undefined;
      req.user = { userId: "system", role: "ADMIN", tenantId: tenantId || "" } as any;
      req.tenantId = tenantId || undefined;
      next();
      return;
    }

    const payload = verifyToken(token);
    req.user = payload;
    req.tenantId = payload.tenantId;

    // Verify user is still active (lightweight DB check)
    prisma.user.findUnique({
      where: { id: payload.userId },
      select: { isActive: true },
    }).then((user) => {
      if (!user || !user.isActive) {
        res.status(401).json({ error: "Account has been deactivated" });
        return;
      }
      next();
    }).catch(() => {
      // If DB check fails, allow request to proceed (fail-open for availability)
      next();
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
