import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { resolvePrincipal, AuthError } from "../lib/principal";
import { readSessionCookie, resolvePrincipalFromSessionToken } from "../lib/session-principal";
import { readSessionFlags } from "../lib/session-flags";
import { prisma } from "../lib/prisma";

/**
 * The ACTIVE-tenant hint. Client-supplied, therefore never trusted as-is: both
 * resolvers validate it against the identity's memberships and reject a tenant
 * the caller does not belong to. Absent header = the identity's default tenant,
 * so single-membership callers need no header at all.
 */
function tenantHintOf(req: Request): string | null {
  const raw = req.headers["x-tenant-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The one place a failed identity resolution becomes a response, shared by the
 * cookie and Bearer paths so the two cannot drift into answering differently
 * about the same rejection.
 */
function respondToAuthFailure(res: Response, err: unknown): void {
  if (err instanceof AuthError) {
    // A valid credential whose subject has no GOTCHA user means the identity is
    // real but was never invited here (or was removed). Authentication
    // succeeded; access does not follow from it - hence 403, not 401.
    // Same for a hint naming a tenant the identity has no membership in.
    const status = err.code === "no_account" || err.code === "tenant_denied" ? 403 : 401;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  // SECURITY: fail CLOSED. An earlier implementation called next() when the
  // lookup threw, so a database blip admitted deactivated users and requests
  // with no resolved tenant. Availability is not a reason to skip an
  // authorization decision.
  console.error("[auth] identity resolution failed:", err);
  res.status(503).json({ error: "Authentication temporarily unavailable" });
}

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
  const matched = secrets.find((s) => secretMatches(token, s));
  if (!matched) return false;

  // The weakness check applies to the secret that MATCHED, not to every
  // secret in the list. Checking the whole list meant one weak legacy var
  // (a 24-char INTERNAL_SERVICE_TOKEN left in prod env) threw here for EVERY
  // internal call - including callers presenting the strong 64-char KEY - and
  // silently killed all service-to-service auth on the services that carried
  // it. A weak secret still never GRANTS access; it just no longer poisons
  // the strong one.
  if (process.env.NODE_ENV === "production") {
    if (matched.length < 32 || /change-me|placeholder/i.test(matched)) {
      throw new Error(
        "[auth] the presented internal secret is weak or a placeholder. Refusing internal auth in production.",
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
 * A request arrives one of three ways, checked in this order:
 *
 *   1. An INTERNAL Bearer secret - service-to-service. Always accepted; the
 *      flags below govern browser credentials only, and a rollout that locks
 *      browsers to cookies must not sever the platform's own plumbing.
 *   2. The opaque session COOKIE (SESSION_COOKIE_ACCEPT). Server-side session,
 *      revocable, and the only credential the browser holds under the BFF model.
 *   3. A browser Bearer access token (LEGACY_BEARER_ACCEPT, on by default).
 *      Verified against Authentik's JWKS, then the token's `sub` is resolved to
 *      a local user.
 *
 * Authentik proves WHO you are; the local database decides WHAT you may do -
 * Authentik never carries authorization data, whichever door was used.
 *
 * The cookie is tried BEFORE the browser Bearer so that a session survives a
 * stale token left in a tab's storage: the credential the server can revoke
 * wins over the one it cannot.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const flags = readSessionFlags(process.env);
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;

  // ── 1. Internal service secret ────────────────────────────
  if (bearer) {
    try {
      if (await tryInternalAuth(req, bearer)) {
        next();
        return;
      }
    } catch {
      res.status(401).json({ error: "Invalid internal service credentials" });
      return;
    }
  }

  // ── 2. Session cookie ─────────────────────────────────────
  if (flags.cookieAccept) {
    const rawSession = readSessionCookie(req.headers.cookie, process.env);
    if (rawSession) {
      try {
        const principal = await resolvePrincipalFromSessionToken(rawSession, tenantHintOf(req));
        req.user = principal as any;
        req.tenantId = principal.tenantId;
        next();
        return;
      } catch (err) {
        // A presented-but-invalid session is a hard failure, never a silent
        // fall-through to Bearer: a revoked session must not be rescued by a
        // token the same browser still happens to be holding.
        respondToAuthFailure(res, err);
        return;
      }
    }
  }

  // ── 3. Browser Bearer (legacy) ────────────────────────────
  if (!bearer) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }
  if (flags.cookieOnlyEnforce || !flags.legacyBearerAccept) {
    // The token may well be valid. It is refused because this deployment has
    // moved browsers to cookie sessions, and accepting both would leave the
    // weaker credential live for exactly as long as anyone kept using it.
    res.status(401).json({
      error: "Browser bearer tokens are not accepted; sign in to receive a session",
      code: "cookie_required",
    });
    return;
  }

  try {
    const principal = await resolvePrincipal(bearer, tenantHintOf(req));
    req.user = principal as any;
    req.tenantId = principal.tenantId;
    next();
  } catch (err) {
    respondToAuthFailure(res, err);
  }
}
