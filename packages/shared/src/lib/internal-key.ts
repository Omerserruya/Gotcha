import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Constant-time comparison of two secrets.
 *
 * `===` on a secret leaks its length and matching prefix through timing.
 * `timingSafeEqual` needs equal-length buffers, so hash both sides to a fixed
 * width first.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verify the shared internal-service key presented on an internal
 * service-to-service call (the `x-internal-key` header). FAIL-CLOSED:
 *
 *   - no configured secret         -> reject (never fall back to a default)
 *   - production + weak/short/placeholder secret -> reject
 *   - no header presented          -> reject
 *   - otherwise                    -> constant-time compare
 *
 * Accepts either INTERNAL_SERVICE_KEY or INTERNAL_SERVICE_TOKEN, matching the
 * rest of the mesh. The `< 32` prod guard is what makes the historically
 * committed default `chatcenter-internal-2026` (24 chars) unusable in
 * production even if a receiver's env is accidentally left unset - the request
 * is rejected rather than silently accepted against a public string.
 *
 * This is the single hardened primitive; callers must not re-implement a
 * `header === (process.env.X || "<default>")` check.
 */
export function verifyInternalServiceKey(header: unknown): boolean {
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || provided.length === 0) return false;

  let secrets = [process.env.INTERNAL_SERVICE_KEY, process.env.INTERNAL_SERVICE_TOKEN].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (secrets.length === 0) return false;

  if (process.env.NODE_ENV === "production") {
    secrets = secrets.filter((s) => s.length >= 32 && !/change-me|placeholder/i.test(s));
    if (secrets.length === 0) return false;
  }

  return secrets.some((s) => constantTimeEquals(provided, s));
}

/**
 * The internal service key to ATTACH on an outbound service-to-service call
 * (the sender side). Returns the configured secret with NO literal fallback, so
 * a misconfigured sender sends an empty key and is rejected by the hardened
 * receiver (fail-closed) rather than silently authenticating with the committed
 * default `chatcenter-internal-2026`. Never inline `process.env.X || "<default>"`.
 */
export function getInternalServiceKey(): string {
  return process.env.INTERNAL_SERVICE_KEY || process.env.INTERNAL_SERVICE_TOKEN || "";
}

/**
 * Express middleware guarding an internal service-to-service route. This is the
 * ONLY sanctioned way to gate an internal endpoint; do not re-implement a
 * `header === (process.env.X || "<default>")` check inline (non-constant-time
 * and accepts the committed default). Fails closed via verifyInternalServiceKey.
 */
export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  if (!verifyInternalServiceKey(req.headers["x-internal-key"])) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
