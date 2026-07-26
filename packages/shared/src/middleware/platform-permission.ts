/**
 * The platform (Sysadmin) gate, with an explicit capability declaration.
 *
 * `requirePlatformPermission("platform:pricing:publish")` enforces the same
 * SYSTEM_ADMIN tier as `requireSystemAdmin()` - authorization is unchanged - but
 * the route now names the capability it exercises. That name is attached to the
 * request and written into the audit trail, so a pricing change is attributable
 * to a capability rather than to "some system route".
 *
 * A tenant ADMIN can never satisfy this gate. That is the whole point: pricing
 * configuration and cross-organization analytics are platform concerns, and
 * routing them through tenant authorization would let an organization's own
 * admin read another organization's negotiated terms.
 */
import type { Request, Response, NextFunction } from "express";
import type { PlatformPermission } from "../lib/platform-permissions";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The platform capability this route declared, for audit attribution. */
      platformPermission?: string;
    }
  }
}

export function requirePlatformPermission(permission: PlatformPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (req.user.role !== "SYSTEM_ADMIN") {
      // Deliberately does not say which permission was required: an
      // unauthorized caller learns nothing about the platform surface.
      res.status(403).json({ error: "Platform administrator access required" });
      return;
    }
    req.platformPermission = permission;
    next();
  };
}
