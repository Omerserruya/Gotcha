/**
 * Internal service-to-service auth. The gateway does no auth, so billing must
 * authenticate its own internal endpoints with the shared X-Internal-Key. Same
 * convention as services/ai (accepts INTERNAL_SERVICE_KEY or _TOKEN).
 */
import type { Request, Response, NextFunction } from "express";

export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-internal-key"];
  const expected = process.env.INTERNAL_SERVICE_KEY || process.env.INTERNAL_SERVICE_TOKEN || "chatcenter-internal-2026";
  if (!key || key !== expected) {
    res.status(401).json({ error: "unauthorized", scope: "internal" });
    return;
  }
  next();
}
