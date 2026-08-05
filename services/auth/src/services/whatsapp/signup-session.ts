/**
 * The customer's business token, between inspect and connect.
 *
 * Two problems solved in one place:
 *
 *  1. **The token must never reach the browser.** It is a customer-scoped
 *     credential that can read and modify their WhatsApp accounts. Handing it
 *     to a page so the page can hand it back is exposure with no upside, so
 *     the browser only ever holds an opaque `sessionId`.
 *
 *  2. **Meta's authorization codes are single-use.** Exchanging one to inspect
 *     and again to connect fails the second time, so the resulting token has to
 *     survive between the two calls.
 *
 * Sessions are tenant-scoped in the key itself, so a `sessionId` leaked from
 * one workspace cannot be replayed against another.
 */

import { getRedis } from "@chatcenter/shared";
import { randomUUID } from "crypto";

/**
 * Long enough to read the options and choose, short enough that an abandoned
 * flow leaves no usable credential behind.
 */
export const SIGNUP_SESSION_TTL_SECONDS = 15 * 60;

export interface SignupSession {
  accessToken: string;
  /** Which Embedded Signup flow produced this token. */
  path: string;
  businessPortfolioId?: string;
  wabaIds?: string[];
}

export function signupSessionKey(tenantId: string, sessionId: string): string {
  return `wa_signup:${tenantId}:${sessionId}`;
}

/** Points at the tenant's one live session so the previous one can be killed. */
export function signupCurrentKey(tenantId: string): string {
  return `wa_signup_current:${tenantId}`;
}

/**
 * Begin a session, destroying the tenant's previous one first.
 *
 * The old session is deleted rather than left to expire, and that is the whole
 * point of this function:
 *
 *   * Every relaunch runs a fresh `FB.login`, producing a fresh authorization
 *     code and a fresh token. The previous token belongs to an authorization
 *     the customer walked away from.
 *   * Switching between the standard and Business app flows is exactly when
 *     the granted assets change. Leaving the old session alive would let a
 *     stale `sessionId` connect numbers under a grant that no longer reflects
 *     what the customer chose.
 *
 * One live session per tenant, always.
 */
export async function startSignupSession(
  tenantId: string,
  payload: SignupSession,
): Promise<string> {
  const redis = getRedis();

  const previous = await redis.get(signupCurrentKey(tenantId));
  if (previous) {
    await redis.del(signupSessionKey(tenantId, previous));
  }

  const sessionId = randomUUID();
  await redis.set(
    signupSessionKey(tenantId, sessionId),
    JSON.stringify(payload),
    "EX",
    SIGNUP_SESSION_TTL_SECONDS,
  );
  await redis.set(signupCurrentKey(tenantId), sessionId, "EX", SIGNUP_SESSION_TTL_SECONDS);
  return sessionId;
}

/**
 * Read a session. Returns null for anything expired, replaced, or belonging to
 * another tenant, all of which are the same thing from the caller's side: the
 * customer must start again.
 */
export async function readSignupSession(
  tenantId: string,
  sessionId: string,
): Promise<SignupSession | null> {
  if (!sessionId) return null;
  const raw = await getRedis().get(signupSessionKey(tenantId, sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SignupSession;
    return parsed?.accessToken ? parsed : null;
  } catch {
    return null;
  }
}

/** Explicitly end a session, e.g. when the customer abandons the picker. */
export async function endSignupSession(tenantId: string, sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(signupSessionKey(tenantId, sessionId));
  const current = await redis.get(signupCurrentKey(tenantId));
  if (current === sessionId) {
    await redis.del(signupCurrentKey(tenantId));
  }
}
