import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { resolvePrincipal, AuthError } from "../lib/principal";
import { prisma } from "../lib/prisma";

/**
 * Constant-time secret comparison.
 *
 * `===` on a secret leaks its length and matching prefix through timing.
 * `timingSafeEqual` requires equal lengths, so hash both sides to a fixed
 * width first.
 */
function secretMatches(candidate: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function internalSecrets(): string[] {
  return [process.env.INTERNAL_SERVICE_KEY, process.env.INTERNAL_SERVICE_TOKEN]
    .filter((v): v is string => !!v && v.length > 0);
}

/**
 * Service-to-service authentication.
 *
 * Internal callers present a shared secret instead of a user token, plus an
 * `x-tenant-id` naming the tenant scope to act in. We accept either
 * INTERNAL_SERVICE_KEY or INTERNAL_SERVICE_TOKEN: services historically
 * populated different ones, and a mismatch surfaces as a misleading 401.
 *
 * SECURITY: the tenant header is caller-supplied, so it is only ever as
 * trustworthy as the secret accompanying it. Holding the secret means a caller
 * can act in ANY tenant - inherent to one shared secret, and not fixed by
 * validating the header. What is enforced here:
 *   - the secret is compared in constant time;
 *   - a weak/placeholder secret refuses to authenticate in production, so a
 *     forgotten env var fails closed rather than granting cross-tenant access;
 *   - the named tenant must exist, so a probe or typo cannot land in an
 *     empty-string tenant scope that some queries would read as "unscoped";
 *   - the principal is tagged `isInternal`, letting routes tell a service
 *     apart from a human admin.
 * Narrowing further (per-service scoped keys, or mTLS) is an authorization
 * change tracked separately from this migration.
 */
async function tryInternalAuth(req: Request, token: string): Promise<boolean> {
  const secrets = internalSecrets();
  if (secrets.length === 0) return false;
  if (!secrets.some((s) => secretMatches(token, s))) return false;

  if (process.env.NODE_ENV === "production") {
    const weak = secrets.some((s) => s.length < 32 || /change-me|placeholder/i.test(s));
    if (weak) {
      throw new Error(
        "[auth] INTERNAL_SERVICE_KEY is weak or a placeholder. Refusing internal auth in production.",
      );
    }
  }

  const tenantId = req.headers["x-tenant-id"];
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("[auth] internal call missing x-tenant-id");
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) throw new Error("[auth] internal call names an unknown tenant");

  req.user = { userId: "system", role: "ADMIN", tenantId, isInternal: true } as any;
  req.tenantId = tenantId;
  return true;
}

/**
 * The single authentication gate for every GOTCHA service.
 *
 * A request arrives bearing an Authentik-issued access token. We verify it
 * against Authentik's JWKS, then resolve the token's `sub` to a local user to
 * load tenancy and role. Authentik proves WHO you are; the local database
 * decides WHAT you may do - Authentik never carries authorization data.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }
  const token = header.slice(7);

  try {
    if (await tryInternalAuth(req, token)) {
      next();
      return;
    }
  } catch {
    res.status(401).json({ error: "Invalid internal service credentials" });
    return;
  }

  try {
    const principal = await resolvePrincipal(token);
    req.user = principal as any;
    req.tenantId = principal.tenantId;
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      // A valid token whose subject has no GOTCHA user means the identity is
      // real but was never invited here (or was removed). Authentication
      // succeeded; access does not follow from it - hence 403, not 401.
      const status = err.code === "no_account" ? 403 : 401;
      res.status(status).json({ error: err.message });
      return;
    }
    // SECURITY: fail CLOSED. The previous implementation called next() when
    // the lookup threw, so a database blip admitted deactivated users and
    // requests with no resolved tenant. Availability is not a reason to skip
    // an authorization decision.
    console.error("[auth] identity resolution failed:", err);
    res.status(503).json({ error: "Authentication temporarily unavailable" });
  }
}
