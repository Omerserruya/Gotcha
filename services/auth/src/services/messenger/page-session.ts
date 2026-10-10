/**
 * The Facebook Pages a Messenger grant offered, between the callback and the
 * customer's choice (2026-10-09).
 *
 * Modelled on whatsapp/signup-session.ts, for the same two reasons:
 *
 *  1. **Page tokens never reach the browser.** The picker sees names and ids;
 *     the tokens stay here, ENCRYPTED, because each one can read and send a
 *     Page's messages.
 *  2. **Meta's codes are single-use.** The callback spends the code and reads
 *     every Page token once; the choice made later has to find them again.
 *
 * The session key carries `tenantId`, so an id leaked from one workspace reads
 * nothing in another, and the stored `userId` must be the caller's, so a
 * colleague cannot finish someone else's grant. The "current" pointer is per
 * person: relaunching replaces your own picker, never a colleague's.
 */

import { getRedis, encryptCredentials, decryptCredentials } from "@chatcenter/shared";
import { randomUUID } from "crypto";

/** Long enough to choose, short enough that an abandoned picker leaves no live token. */
export const PAGE_SESSION_TTL_SECONDS = 15 * 60;

export interface PageCandidate {
  id: string;
  name: string;
  category?: string | null;
  accessToken: string;
}

export interface PageSession {
  /** Whose grant this is; only they may read or finish it. */
  userId: string;
  /** The user token's expiry, carried onto every Page connected from it. ISO. */
  tokenExpiresAt: string;
  /** When this session stops being readable. ISO. */
  expiresAt: string;
  pages: PageCandidate[];
}

export function pageSessionKey(tenantId: string, sessionId: string): string {
  return `fb_pages:${tenantId}:${sessionId}`;
}

export function pageCurrentKey(tenantId: string, userId: string): string {
  return `fb_pages_current:${tenantId}:${userId}`;
}

/**
 * Begin a session, ending this person's previous one first: a relaunch is a
 * new grant, and the old Pages belong to one they walked away from.
 */
export async function startPageSession(
  tenantId: string,
  userId: string,
  payload: { tokenExpiresAt: string; pages: PageCandidate[] },
): Promise<string> {
  const redis = getRedis();

  const previous = await redis.get(pageCurrentKey(tenantId, userId));
  if (previous) {
    await redis.del(pageSessionKey(tenantId, previous));
  }

  const sessionId = randomUUID();
  const session: PageSession = {
    userId,
    tokenExpiresAt: payload.tokenExpiresAt,
    expiresAt: new Date(Date.now() + PAGE_SESSION_TTL_SECONDS * 1000).toISOString(),
    pages: payload.pages,
  };
  await redis.set(
    pageSessionKey(tenantId, sessionId),
    encryptCredentials(session as unknown as Record<string, unknown>),
    "EX",
    PAGE_SESSION_TTL_SECONDS,
  );
  await redis.set(pageCurrentKey(tenantId, userId), sessionId, "EX", PAGE_SESSION_TTL_SECONDS);
  return sessionId;
}

/**
 * Read a session. Expired, replaced, another workspace's, another person's or
 * unreadable are all null: from the caller's side each means "start again".
 */
export async function readPageSession(
  tenantId: string,
  sessionId: string,
  userId: string | undefined | null,
): Promise<PageSession | null> {
  if (!sessionId || !userId) return null;
  const raw = await getRedis().get(pageSessionKey(tenantId, sessionId));
  if (!raw) return null;
  try {
    const parsed = decryptCredentials(raw) as PageSession;
    if (!parsed || parsed.userId !== userId || !Array.isArray(parsed.pages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** End a session once its choice is made, so the same id cannot connect twice. */
export async function endPageSession(tenantId: string, sessionId: string, userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(pageSessionKey(tenantId, sessionId));
  const current = await redis.get(pageCurrentKey(tenantId, userId));
  if (current === sessionId) {
    await redis.del(pageCurrentKey(tenantId, userId));
  }
}
