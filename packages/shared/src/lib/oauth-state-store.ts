/**
 * Single-use OAuth `state` - mint and consume.
 *
 * The signature on a state token proves WE issued it. It does not prove the
 * token has not been used before: a signed JWT with a 10-minute expiry is
 * replayable for those 10 minutes by anyone who captures it (referrer logs, a
 * shared machine's history, a proxy). That was true of every provider here
 * except Airtable, and a replayed callback re-runs the token exchange and
 * re-writes the tenant's connection.
 *
 * So each state carries a `jti`, and the callback CONSUMES it: the jti is
 * recorded in Redis with `SET NX` and a TTL matching the token's lifetime.
 * The first consume wins; every later one is rejected as a replay. Redis is
 * already a hard dependency of every service that serves these callbacks.
 *
 * What must be bound INTO the state (never read from the browser at callback
 * time): tenant, the initiating user/membership, the provider, and the return
 * context. A return URL taken from a query parameter is an open redirect; a
 * tenant id taken from the frontend is a cross-tenant write.
 */

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getRedis } from "./redis";
import { getOAuthStateSecret } from "./oauth-state";

/** Default lifetime. Deliberately short - a state is used within seconds. */
const DEFAULT_TTL_SECONDS = 600;

const usedKey = (jti: string) => `oauth:state:used:${jti}`;

export interface OAuthStateClaims {
  /** Tenant the connection will be written to. Authoritative. */
  tenantId: string;
  /** Catalog slug / provider key, checked on the way back. */
  provider: string;
  /** The user who started the flow (audit + membership revalidation). */
  userId?: string;
  /** Where the user was when they started ("onboarding", "settings", …). */
  flow?: string;
  /** Provider-specific extras (aiAgentId, shop, PKCE verifier, …). */
  [key: string]: unknown;
}

export interface MintedState {
  state: string;
  jti: string;
}

/**
 * Sign a single-use state token.
 *
 * The jti is NOT written to Redis here. Recording it at mint time would let an
 * abandoned flow (user closes the tab at the provider's consent screen) leave
 * a key behind, and would make "issued" and "used" indistinguishable. The key
 * is written at consume time, which is what makes the FIRST consume the winner.
 */
export function mintOAuthState(claims: OAuthStateClaims, ttlSeconds = DEFAULT_TTL_SECONDS): MintedState {
  const jti = crypto.randomBytes(16).toString("hex");
  const state = jwt.sign({ ...claims, jti }, getOAuthStateSecret(), { expiresIn: ttlSeconds });
  return { state, jti };
}

export type ConsumeResult<T = OAuthStateClaims> =
  | { ok: true; claims: T & { jti: string } }
  | { ok: false; reason: "invalid" | "expired" | "provider_mismatch" | "replayed" };

/**
 * Verify AND consume a state token. Safe to call exactly once per callback.
 *
 * Returns a discriminated result rather than throwing so callbacks can render
 * an accurate, non-leaky error (a replay and a forged token must look the same
 * to the caller, but be distinguishable in our logs).
 */
export async function consumeOAuthState<T = OAuthStateClaims>(
  rawState: string | undefined,
  expectedProvider: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<ConsumeResult<T>> {
  if (!rawState) return { ok: false, reason: "invalid" };

  let claims: any;
  try {
    claims = jwt.verify(rawState, getOAuthStateSecret());
  } catch (err: any) {
    return { ok: false, reason: err?.name === "TokenExpiredError" ? "expired" : "invalid" };
  }
  if (claims?.provider !== expectedProvider) return { ok: false, reason: "provider_mismatch" };

  const jti: string | undefined = claims?.jti;
  // Legacy tokens minted before single-use existed carry no jti. Reject them:
  // accepting an unconsumable state would silently reopen the replay window,
  // and any such token is at most one TTL old by the time this ships.
  if (!jti) return { ok: false, reason: "invalid" };

  try {
    // SET NX = "claim it if nobody has". The TTL matches the token lifetime, so
    // the record cannot outlive the token it protects.
    const claimed = await getRedis().set(usedKey(jti), "1", "EX", ttlSeconds, "NX");
    if (claimed !== "OK") return { ok: false, reason: "replayed" };
  } catch (err: any) {
    // Redis down. FAIL CLOSED: without the store we cannot tell a first use
    // from a replay, and silently degrading to "replayable" is exactly the
    // hole this module exists to close.
    console.error("[oauth-state] replay store unavailable, rejecting callback:", err?.message);
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, claims: claims as T & { jti: string } };
}

/**
 * Where to send the user after a callback, derived ONLY from the signed state.
 *
 * Never accept a return URL from the query string: that is an open redirect,
 * and it is also how onboarding lost its place (the callback fell back to a
 * hard-coded marketplace path).
 */
export function returnPathForFlow(flow: string | undefined, provider: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query);
  if (flow === "onboarding") {
    params.set("connected", provider);
    return `/setup?${params.toString()}`;
  }
  params.set("status", "connected");
  return `/ai-studio/marketplace/${provider}?${params.toString()}`;
}
