/**
 * Shopify install: connection intent + pending connection.
 *
 * Two short-lived, server-side records that make a Shopify-OWNED install
 * land in the RIGHT GOTCHA workspace without ever trusting the browser for
 * the answer.
 *
 * The problem
 * -----------
 * OAuth must happen first - Shopify identifies the store, and no GOTCHA
 * screen may appear before the merchant authorizes. But "which workspace
 * does this store belong to?" is a GOTCHA question, and the only honest
 * answer comes from an authenticated GOTCHA session. Those two facts pull in
 * opposite directions, and the tempting resolutions are all holes:
 *
 *   • a `tenantId` query parameter        → anyone can write to any tenant
 *   • a workspace id in the OAuth `state` → same, once the state is minted
 *                                           from an unauthenticated request
 *   • matching on the shop name           → whoever installs first owns it
 *
 * The resolution used here has two paths, and neither reads a workspace from
 * the browser:
 *
 *   INTENT  The merchant clicked "Connect Shopify" while signed in. We mint
 *           an intent server-side from `req.tenantId` (already validated by
 *           auth + tenant middleware) and hand the browser only an opaque
 *           handle in an HttpOnly cookie. The handle is a lookup key, not a
 *           claim: it cannot be edited into a different workspace because
 *           the workspace was never in it.
 *
 *   PENDING The install began on Shopify with no GOTCHA session (App Store
 *           listing, incognito, a different browser). There is no workspace
 *           to bind, so the verified installation - including its access
 *           token, encrypted - is parked and the merchant is asked to sign
 *           in. The claim then happens against THEIR validated session and
 *           their own permission check.
 *
 * Why Redis and not a table
 * -------------------------
 * Both records are single-use and expire in minutes. Redis gives the TTL and
 * the atomic single-use consume (`GETDEL`) natively, and it is already a
 * hard dependency of every service that serves an OAuth callback (the
 * single-use `state` store depends on it too). A table would need a
 * migration plus a sweeper to get the same two properties, and would keep
 * an access token on disk for longer than the minutes it is needed.
 *
 * The cost is honest and bounded: a Redis flush between the callback and the
 * claim loses a pending install, and the merchant reinstalls. That is the
 * same recovery an expired pending record already has.
 */

import crypto from "crypto";
import { getRedis, encryptCredentials, decryptCredentials } from "@chatcenter/shared";

/**
 * How long the merchant has to finish on Shopify after clicking Connect.
 *
 * Generous, because the middle of this window is Shopify's own store-picker
 * and consent screen and a merchant may stop to read the scopes. The intent
 * carries no token, so a long window costs little.
 */
export const INSTALL_INTENT_TTL_SECONDS = 30 * 60;

/**
 * How long a verified-but-unclaimed installation is held.
 *
 * Shorter than the intent, because this record DOES hold an access token.
 * Long enough to sign in (including a password reset), short enough that an
 * abandoned install stops being a secret we are storing.
 */
export const PENDING_CONNECTION_TTL_SECONDS = 15 * 60;

/** Cookie carrying the intent handle across the Shopify round trip. */
export const INSTALL_INTENT_COOKIE = "gotcha_shopify_intent";

const intentKey = (handle: string) => `shopify:install:intent:${handle}`;
const pendingKey = (handle: string) => `shopify:install:pending:${handle}`;

/** 256 bits of opaque handle. Never derived from anything guessable. */
function newHandle(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Handles only ever come from `newHandle`, so anything else is not one. */
function isHandle(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}

// ─── Connection intent ───────────────────────────────────────

export interface InstallIntent {
  tenantId: string;
  /** Who started it. Re-checked at link time, never trusted on its own. */
  userId?: string;
  /** Where the merchant was, so the callback can return them there. */
  flow?: string;
  createdAt: number;
}

/**
 * Record "this signed-in user, in this workspace, is about to install".
 *
 * `tenantId` MUST come from validated middleware (`req.tenantId`), never
 * from a body or query. This function cannot enforce that, which is why
 * every call site is in an authenticated, tenant-scoped route.
 */
export async function createInstallIntent(input: {
  tenantId: string;
  userId?: string;
  flow?: string;
}): Promise<string> {
  const handle = newHandle();
  const payload: InstallIntent = {
    tenantId: input.tenantId,
    userId: input.userId,
    flow: input.flow,
    createdAt: Date.now(),
  };
  await getRedis().set(
    intentKey(handle),
    JSON.stringify(payload),
    "EX",
    INSTALL_INTENT_TTL_SECONDS,
  );
  return handle;
}

/**
 * Read an intent WITHOUT consuming it.
 *
 * The install entry point reads rather than consumes: the merchant can still
 * abandon the flow on Shopify's consent screen, and burning the intent there
 * would make the back button a dead end. The consume happens in the callback,
 * where the round trip actually completed.
 */
export async function readInstallIntent(handle: unknown): Promise<InstallIntent | null> {
  if (!isHandle(handle)) return null;
  try {
    const raw = await getRedis().get(intentKey(handle));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.tenantId === "string" ? (parsed as InstallIntent) : null;
  } catch {
    // A malformed or unreachable record is "no intent", which degrades to the
    // pending-connection path. It must never degrade to "some other tenant".
    return null;
  }
}

/** Read and delete atomically. The first caller wins; a replay gets null. */
export async function consumeInstallIntent(handle: unknown): Promise<InstallIntent | null> {
  if (!isHandle(handle)) return null;
  try {
    const redis: any = getRedis();
    // GETDEL is Redis >= 6.2. Fall back to GET+DEL, which is not atomic but is
    // still single-use in practice - and the state token is the real replay
    // guard, so this is belt to that braces.
    const raw =
      typeof redis.getdel === "function"
        ? await redis.getdel(intentKey(handle))
        : await (async () => {
            const v = await redis.get(intentKey(handle));
            if (v) await redis.del(intentKey(handle));
            return v;
          })();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.tenantId === "string" ? (parsed as InstallIntent) : null;
  } catch {
    return null;
  }
}

export async function discardInstallIntent(handle: unknown): Promise<void> {
  if (!isHandle(handle)) return;
  try {
    await getRedis().del(intentKey(handle));
  } catch {
    /* best effort - it expires on its own */
  }
}

// ─── Pending connection ──────────────────────────────────────

export interface PendingConnection {
  shopDomain: string;
  /** Encrypted credential blob. NEVER the raw token, and never sent to a browser. */
  credentialsBlob: string;
  scope?: string;
  flow?: string;
  createdAt: number;
}

/** What the claim UI may safely see. Deliberately excludes the credentials. */
export interface PendingConnectionSummary {
  shopDomain: string;
  createdAt: number;
}

/**
 * Park a verified installation that has no workspace yet.
 *
 * The token is encrypted before it reaches Redis with the same helper that
 * protects it in the database, so the pending record is not a softer copy of
 * a credential we otherwise guard.
 */
export async function createPendingConnection(input: {
  shopDomain: string;
  credentials: Record<string, unknown>;
  scope?: string;
  flow?: string;
}): Promise<string> {
  const handle = newHandle();
  const payload: PendingConnection = {
    shopDomain: input.shopDomain,
    credentialsBlob: encryptCredentials(input.credentials as any),
    scope: input.scope,
    flow: input.flow,
    createdAt: Date.now(),
  };
  await getRedis().set(
    pendingKey(handle),
    JSON.stringify(payload),
    "EX",
    PENDING_CONNECTION_TTL_SECONDS,
  );
  return handle;
}

/**
 * What the "finish connecting" screen renders: the shop name and nothing else.
 *
 * Separate from `consumePendingConnection` so the page can be drawn without
 * burning the one-shot claim - a merchant who reloads the page must not lose
 * their install.
 */
export async function peekPendingConnection(
  handle: unknown,
): Promise<PendingConnectionSummary | null> {
  if (!isHandle(handle)) return null;
  try {
    const raw = await getRedis().get(pendingKey(handle));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingConnection;
    if (typeof parsed?.shopDomain !== "string") return null;
    return { shopDomain: parsed.shopDomain, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

/**
 * Claim the pending installation. Exactly once.
 *
 * Returns the decrypted credentials for immediate persistence into the
 * tenant's connection. The caller must not log, return, or otherwise move
 * this value anywhere but `upsertConnection`.
 */
export async function consumePendingConnection(handle: unknown): Promise<{
  shopDomain: string;
  credentials: Record<string, any>;
  scope?: string;
  flow?: string;
} | null> {
  if (!isHandle(handle)) return null;
  let raw: string | null = null;
  try {
    const redis: any = getRedis();
    raw =
      typeof redis.getdel === "function"
        ? await redis.getdel(pendingKey(handle))
        : await (async () => {
            const v = await redis.get(pendingKey(handle));
            if (v) await redis.del(pendingKey(handle));
            return v;
          })();
  } catch (err: any) {
    // FAIL CLOSED. Without the store we cannot tell a first claim from a
    // second, and a token that gets written twice is a token that can be
    // written into two different workspaces.
    console.error("[shopify-install] pending store unavailable:", err?.message);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingConnection;
    if (typeof parsed?.shopDomain !== "string" || !parsed.credentialsBlob) return null;
    return {
      shopDomain: parsed.shopDomain,
      credentials: decryptCredentials(parsed.credentialsBlob) as Record<string, any>,
      scope: parsed.scope,
      flow: parsed.flow,
    };
  } catch {
    return null;
  }
}
