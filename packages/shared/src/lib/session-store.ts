import type { Prisma } from "@prisma/client";
import { assertSessionEncryptionReady } from "./session-crypto";
import { assertAppOriginReady } from "./app-origins";
import { resolveSessionCookieContract } from "./session-cookie";
import { readSessionFlags, sessionInfraEnabled } from "./session-flags";

/**
 * Model-level primitives for the BFF app session: query builders for cleanup,
 * identity listing and the three invalidation mechanisms, plus a redacted view
 * and the aggregate startup guard. No scheduled jobs and no runtime auth path
 * here - just the pure pieces later commits compose.
 */

/** Canonical revocation reasons (audit + policy table in the migration map). */
export const REVOCATION_REASON = {
  LOGOUT: "logout",
  LOGOUT_ALL: "logout_all",
  PASSWORD_CHANGE: "password_change",
  CREDENTIAL_RESET: "credential_reset",
  MFA_CHANGE: "mfa_change",
  IDENTITY_DISABLED: "identity_disabled",
  SECURITY_INCIDENT: "security_incident",
  FORCED_REAUTH: "forced_reauth",
  SUBJECT_BINDING_CHANGE: "subject_binding_change",
  MEMBERSHIP_REVOKED: "membership_revoked",
  REFRESH_INVALID_GRANT: "refresh_invalid_grant",
  EXPIRED: "expired",
  SUPERSEDED: "superseded",
  ADMIN_REVOKED: "admin_revoked",
} as const;
export type RevocationReason = (typeof REVOCATION_REASON)[keyof typeof REVOCATION_REASON];

/** Remember-me durations (A20): 12h non-remembered, 30d remembered. */
export interface SessionTtl {
  idleSeconds: number;
  rememberedSeconds: number;
}
const DEFAULT_IDLE = 12 * 60 * 60; // 12h
const DEFAULT_REMEMBERED = 30 * 24 * 60 * 60; // 30d
function positiveInt(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
export function readSessionTtl(env: NodeJS.ProcessEnv = process.env): SessionTtl {
  return {
    idleSeconds: positiveInt(env.SESSION_IDLE_TTL_SECONDS, DEFAULT_IDLE),
    rememberedSeconds: positiveInt(env.SESSION_REMEMBER_TTL_SECONDS, DEFAULT_REMEMBERED),
  };
}

// ── Invalidation / cleanup query builders (pure; unit-testable without a DB) ──

/** Sessions whose hard expiry has passed - safe to delete. */
export function expiredSessionsWhere(now: Date): Prisma.UserSessionWhereInput {
  return { expiresAt: { lt: now } };
}

/** Already-revoked sessions older than a cutoff - safe to purge. */
export function revokedSessionsWhere(purgeBefore: Date): Prisma.UserSessionWhereInput {
  return { revokedAt: { not: null, lt: purgeBefore } };
}

/** All live sessions for an identity (session-list UI). */
export function identitySessionsWhere(identityId: string): Prisma.UserSessionWhereInput {
  return { identityId, revokedAt: null };
}

/**
 * Sessions invalidated by a global sessionVersion bump: any snapshot BELOW the
 * identity's current version. This is the "global reauthentication" set.
 */
export function staleVersionSessionsWhere(identityId: string, currentVersion: number): Prisma.UserSessionWhereInput {
  return { identityId, sessionVersion: { lt: currentVersion } };
}

/** Sessions currently acting as a given membership (membership-context enforcement). */
export function membershipSessionsWhere(activeMembershipId: string): Prisma.UserSessionWhereInput {
  return { activeMembershipId, revokedAt: null };
}

/** A session is usable iff not revoked, not expired, and version-current. */
export function isSessionUsable(
  session: { revokedAt: Date | null; expiresAt: Date; sessionVersion: number },
  identityCurrentVersion: number,
  now: Date,
): boolean {
  if (session.revokedAt) return false;
  if (session.expiresAt.getTime() <= now.getTime()) return false;
  if (session.sessionVersion < identityCurrentVersion) return false;
  return true;
}

// ── Redaction ───────────────────────────────────────────────────────────────

/** Secret fields that must never leave the server or hit a log/serializer. */
export const SESSION_SECRET_FIELDS = [
  "encryptedAccessToken",
  "encryptedRefreshToken",
  "csrfSecret",
  "sessionTokenHash",
] as const;

export interface SafeSessionView {
  id: string;
  identityId: string;
  activeMembershipId: string | null;
  rememberMe: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  browser: string | null;
  device: string | null;
  operatingSystem: string | null;
}

/** Project a session row to a view safe for the session-list UI + logs. */
export function toSafeSessionView(s: Record<string, any>): SafeSessionView {
  return {
    id: s.id,
    identityId: s.identityId,
    activeMembershipId: s.activeMembershipId ?? null,
    rememberMe: !!s.rememberMe,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    expiresAt: s.expiresAt,
    revokedAt: s.revokedAt ?? null,
    revocationReason: s.revocationReason ?? null,
    browser: s.browser ?? null,
    device: s.device ?? null,
    operatingSystem: s.operatingSystem ?? null,
  };
}

// ── Startup guard ─────────────────────────────────────────────────────────────

/**
 * Aggregate startup assertion. NO-OP unless cookie-session infrastructure is
 * actually enabled by a flag - so today's deployments (all flags off) are
 * unaffected. When enabled, a missing/invalid session key, an unsafe cookie
 * contract, or an absent production APP_ORIGIN stops boot. Wire this into
 * service startup in the commit that turns the flags on, not here.
 */
export function assertSessionInfraReady(env: NodeJS.ProcessEnv = process.env): void {
  if (!sessionInfraEnabled(readSessionFlags(env))) return;
  assertSessionEncryptionReady(env);
  assertAppOriginReady(env);
  resolveSessionCookieContract(env); // throws on an unsafe prod cookie contract
}
