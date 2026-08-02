/**
 * Internal service-to-service auth. The gateway does no auth, so billing must
 * authenticate its own internal endpoints with the shared X-Internal-Key. Same
 * convention as services/ai (accepts INTERNAL_SERVICE_KEY or _TOKEN).
 */
import type { Request, Response, NextFunction } from "express";
import { verifyInternalServiceKey } from "@chatcenter/shared";

export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  // Hardened, constant-time, fail-closed. No hardcoded default: an unset or
  // weak key in production is rejected, not silently accepted against the
  // historically committed public string.
  if (!verifyInternalServiceKey(req.headers["x-internal-key"])) {
    res.status(401).json({ error: "unauthorized", scope: "internal" });
    return;
  }
  next();
}
