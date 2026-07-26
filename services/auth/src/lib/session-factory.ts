import crypto from "crypto";
import {
  sealSessionSecret,
  generateSessionToken,
  hashSessionToken,
  serializeSessionCookie,
  readSessionTtl,
} from "@chatcenter/shared";
import type { TokenResponse } from "./oidc-server";

/**
 * Turn a fresh OIDC token response into a UserSession row + the Set-Cookie for
 * the browser (BFF migration §A5). Pure and DB-free so it is unit-testable:
 * the caller persists `createData` and writes `setCookie`.
 *
 * Guarantees: the opaque cookie value (`rawToken`) is returned ONLY here (never
 * persisted - only its hash is); the provider tokens are sealed with
 * SESSION_ENCRYPTION_KEY, AAD-bound to purpose + identity; a fresh id is minted
 * every call (session-fixation prevention happens by always creating anew).
 */
export interface BuildSessionArgs {
  tokens: TokenResponse;
  identityId: string;
  identitySessionVersion: number;
  activeMembershipId: string | null;
  rememberMe: boolean;
  userAgent?: string | null;
  ip?: string | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface BuiltSession {
  rawToken: string;
  setCookie: string;
  createData: Record<string, unknown>;
}

const b64url = (b: Buffer) => b.toString("base64url");
const sha256Hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function buildSessionRecord(args: BuildSessionArgs): BuiltSession {
  const env = args.env ?? process.env;
  const now = args.now ?? new Date();
  const { idleSeconds, rememberedSeconds } = readSessionTtl(env);
  const lifetimeSeconds = args.rememberMe ? rememberedSeconds : idleSeconds;

  const rawToken = generateSessionToken();
  const sessionTokenHash = hashSessionToken(rawToken);

  const encryptedAccessToken = sealSessionSecret(
    args.tokens.access_token,
    { purpose: "session.access", ownerId: args.identityId },
    env,
  );
  const encryptedRefreshToken = args.tokens.refresh_token
    ? sealSessionSecret(args.tokens.refresh_token, { purpose: "session.refresh", ownerId: args.identityId }, env)
    : null;

  const tokenExpiresAt =
    typeof args.tokens.expires_in === "number"
      ? new Date(now.getTime() + args.tokens.expires_in * 1000)
      : null;

  const createData = {
    identityId: args.identityId,
    sessionVersion: args.identitySessionVersion,
    activeMembershipId: args.activeMembershipId,
    sessionTokenHash,
    encryptedAccessToken,
    encryptedRefreshToken,
    tokenExpiresAt,
    // CSRF double-submit secret (server-side only; used from commit 6).
    csrfSecret: b64url(crypto.randomBytes(32)),
    rememberMe: args.rememberMe,
    lastActivityAt: now,
    expiresAt: new Date(now.getTime() + lifetimeSeconds * 1000),
    // Device metadata: only non-reversible hashes here (session-list UI = commit 9).
    userAgentHash: args.userAgent ? sha256Hex(args.userAgent) : null,
    ipHash: args.ip ? sha256Hex(`${args.ip}`) : null,
  };

  const setCookie = serializeSessionCookie(rawToken, { maxAgeSeconds: lifetimeSeconds, env });

  return { rawToken, setCookie, createData };
}

/**
 * Choose the active membership (User row) for a new session: exactly one active
 * membership auto-selects; multiple prefer the identity's last-used tenant;
 * otherwise leave it null so the tenant picker gates the app.
 */
export function chooseActiveMembership(
  memberships: { id: string; tenantId: string; isActive: boolean }[],
  lastTenantId: string | null,
): string | null {
  const active = memberships.filter((m) => m.isActive);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0].id;
  if (lastTenantId) {
    const last = active.find((m) => m.tenantId === lastTenantId);
    if (last) return last.id;
  }
  return null; // ambiguous → tenant picker
}
