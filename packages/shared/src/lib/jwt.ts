import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * OIDC access-token verification.
 *
 * GOTCHA does not issue tokens. Authentik does. This module's only job is to
 * verify a token Authentik signed, using Authentik's published JWKS.
 *
 * There is deliberately no `signToken` here: if this service could mint a
 * token, it would be an identity provider, and the whole point of the
 * Authentik migration is that it is not one.
 */

function required(name: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  throw new Error(
    `[jwt] ${name} is required. Authentication cannot start without a trusted OIDC issuer.`,
  );
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedIssuer: string | null = null;

/**
 * The JWKS is fetched lazily and cached in-process by jose, which also
 * handles key rotation: on an unknown `kid` it re-fetches (rate-limited, so a
 * bogus-kid flood cannot be used to hammer Authentik). This is why rotating
 * Authentik's signing key needs no GOTCHA deploy.
 */
function getJwks() {
  if (!jwks) {
    const uri = required("OIDC_JWKS_URI");
    jwks = createRemoteJWKSet(new URL(uri), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }
  return jwks;
}

function getIssuer(): string {
  if (!cachedIssuer) cachedIssuer = required("OIDC_ISSUER");
  return cachedIssuer;
}

/**
 * Claims GOTCHA reads off a verified Authentik token.
 *
 * Note what is NOT here: no tenantId, no role. Those are GOTCHA business
 * facts, resolved from the local database by `sub`. Authentik must never be
 * the source of authorization data - a token claim could be shaped by IdP
 * config, whereas the local DB is the system of record for tenancy and RBAC.
 */
export interface VerifiedIdentity {
  subject: string;
  email?: string;
  name?: string;
}

/**
 * The request principal after `authenticate()` has resolved the token's
 * subject against the local database.
 */
export interface JwtPayload {
  /** Membership (User row) id in the ACTIVE tenant. */
  userId: string;
  /** The person behind the membership (Identity row id). */
  identityId?: string;
  tenantId: string;
  role: string;
  email: string;
  departmentId?: string;
  departmentRole?: string;
}

export interface SystemAdminJwtPayload {
  userId: string;
  role: "SYSTEM_ADMIN";
  email: string;
  tenantId: string;
}

/**
 * Verify an Authentik-issued access token.
 *
 * Throws on any failure - bad signature, expired, wrong issuer, wrong
 * algorithm. Callers must treat a throw as a hard 401 and never fall through.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: getIssuer(),
    // Pin the algorithm. Without this, a token could assert `alg: "none"` or a
    // symmetric alg and sidestep the JWKS entirely - the classic JWT
    // confusion attack.
    algorithms: ["RS256"],
    ...(process.env.OIDC_AUDIENCE ? { audience: process.env.OIDC_AUDIENCE } : {}),
  });

  const claims = payload as JWTPayload & { email?: string; name?: string };
  if (!claims.sub) throw new Error("[jwt] token has no subject claim");

  return { subject: claims.sub, email: claims.email, name: claims.name };
}

/** Reset cached JWKS/issuer. Tests only. */
export function __resetJwtCaches(): void {
  jwks = null;
  cachedIssuer = null;
}
