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
 * This record DOES hold an access token, so the window is a real cost and was
 * deliberately short. Fifteen minutes turned out to be wrong, and Shopify App
 * Store review 132211 is the evidence.
 *
 * A merchant who installs from Shopify with no GOTCHA session has to sign in
 * BEFORE they can claim the store. That is not a fifteen-minute task for
 * somebody meeting the product for the first time: they may have to find
 * credentials, reset a password, or complete an IdP flow. The reviewer
 * installed at 21:17 and this record expired at 21:32; Shopify recorded their
 * plan approval at 21:33. The store they had authorized was already
 * unreachable by the time they finished.
 *
 * Two hours is long enough to survive a real sign-in and short enough that an
 * abandoned install stops being a secret we are storing overnight.
 * Configurable so it can be tightened without a deploy, and clamped so a typo
 * cannot make it unbounded.
 */
export const PENDING_CONNECTION_TTL_SECONDS = (() => {
  const raw = Number(process.env.SHOPIFY_PENDING_INSTALL_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 2 * 60 * 60;
  return Math.min(Math.max(Math.floor(raw), 5 * 60), 24 * 60 * 60);
})();

/** Cookie carrying the intent handle across the Shopify round trip. */
export const INSTALL_INTENT_COOKIE = "gotcha_shopify_intent";

/**
 * Cookie carrying the PENDING handle from the OAuth callback to the claim.
 *
 * The handle used to exist only in the redirect's query string, which made it
 * the single reference to an authorized store - and anything that navigated
 * away destroyed it. The signed-out login bounce did exactly that, so a
 * Shopify-originated install could not be completed at all: the merchant
 * signed in, landed on the dashboard, and the store they had just authorized
 * was unreachable with no way to ask for it back.
 *
 * Holding it in an HttpOnly cookie as well means the claim screen can find the
 * installation after any number of redirects, including a full OIDC round
 * trip. It proves the same thing the URL handle proved - that THIS browser
 * completed the Shopify authorization - and proves it without putting the
 * value somewhere JavaScript, a referrer header or a log can read it.
 *
 * It is not authorization on its own. The claim still requires an
 * authenticated user with permission to manage integrations, and the shop is
 * still read from the server-side record rather than from anything the browser
 * sent.
 */
export const PENDING_INSTALL_COOKIE = "gotcha_shopify_pending";

/**
 * Minimal shape of the Express response this module needs.
 *
 * Typed structurally rather than importing Express, so this service stays a
 * plain module that the route layer happens to call. Both the OAuth callback
 * and the claim route use these helpers so the cookie flags cannot drift apart
 * between the place that sets the cookie and the place that clears it - which
 * is exactly how a cookie ends up surviving a claim it should not survive.
 */
export interface CookieCarrier {
  cookie(name: string, value: string, opts: Record<string, unknown>): unknown;
  clearCookie(name: string, opts: Record<string, unknown>): unknown;
}

/**
 * Hold the pending-install handle for this browser.
 *
 * HttpOnly so no script can read it, and SameSite=Lax so it survives the
 * top-level GET navigations of the Shopify redirect and the OIDC round trip
 * while staying absent from cross-site POSTs and subresource loads. Secure in
 * production only: a dev stack on plain HTTP would drop a Secure cookie and
 * lose the installation silently, which is the failure this exists to prevent.
 */
export function setPendingInstallCookie(res: CookieCarrier, handle: string): void {
  res.cookie(PENDING_INSTALL_COOKIE, handle, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: PENDING_CONNECTION_TTL_SECONDS * 1000,
    path: "/",
  });
}

/** Drop it. Called once the installation is claimed, or found to be gone. */
export function clearPendingInstallCookie(res: CookieCarrier): void {
  res.clearCookie(PENDING_INSTALL_COOKIE, { path: "/" });
}

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
