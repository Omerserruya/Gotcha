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
 *
 * ── Why the "current" pointer is scoped to the PERSON, not the workspace ──
 *
 * Replacing the previous session is deliberate, and the reasoning below holds
 * for ONE person relaunching. It does not hold for two.
 *
 * With a per-tenant pointer, two admins connecting at the same time collided:
 * the second one's `/inspect` silently destroyed the first one's session. The
 * first then pressed Connect and got a failure with nothing to explain it -
 * from their side they did nothing wrong and nothing visible happened. Meta's
 * authorization codes being single-use means they could not retry the same
 * authorization either; they had to go back through the popup without being
 * told why.
 *
 * ★ THE SESSION KEY IS UNCHANGED and still carries `tenantId`, so the
 * cross-workspace property does not depend on this pointer at all. The pointer
 * exists only to find the previous session to delete, and "the previous one" is
 * a fact about a PERSON's relaunch. Scoping it per user keeps the original
 * intent exactly and lets two grants coexist.
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

/**
 * Points at one PERSON's live session, so their previous one can be killed
 * without touching a colleague's in-flight flow.
 *
 * `userId` is optional because the caller reads it from the request and it is
 * typed optional there. A missing user falls back to a tenant-wide pointer,
 * which is the old behaviour: worse, but never worse than losing the ability to
 * replace a session at all.
 */
export function signupCurrentKey(tenantId: string, userId?: string | null): string {
  return userId ? `wa_signup_current:${tenantId}:${userId}` : `wa_signup_current:${tenantId}`;
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
 * One live session per PERSON. Two admins in one workspace can connect at the
 * same time; the same admin relaunching replaces their own.
 */
export async function startSignupSession(
  tenantId: string,
  payload: SignupSession,
  userId?: string | null,
): Promise<string> {
  const redis = getRedis();

  const previous = await redis.get(signupCurrentKey(tenantId, userId));
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
  await redis.set(signupCurrentKey(tenantId, userId), sessionId, "EX", SIGNUP_SESSION_TTL_SECONDS);
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

/**
 * Explicitly end a session, e.g. when the customer abandons the picker.
 *
 * ⚠ NOTHING CALLS THIS. Grepped repo-wide excluding tests: the only references
 * are its own definition and the test that exercises it. Kept rather than
 * deleted because abandonment IS a real state the picker should report, and
 * leaving the credential to expire on its own is the thing this would improve.
 * Recorded here so the next reader does not assume it is load-bearing.
 */
export async function endSignupSession(
  tenantId: string,
  sessionId: string,
  userId?: string | null,
): Promise<void> {
  const redis = getRedis();
  await redis.del(signupSessionKey(tenantId, sessionId));
  const current = await redis.get(signupCurrentKey(tenantId, userId));
  if (current === sessionId) {
    await redis.del(signupCurrentKey(tenantId, userId));
  }
}
