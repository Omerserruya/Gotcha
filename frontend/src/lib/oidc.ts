/**
 * OIDC Authorization Code + PKCE client.
 *
 * GOTCHA's frontend is a browser SPA, so it is registered with Authentik as a
 * PUBLIC client: it holds no client secret (one shipped to a browser is not a
 * secret). Proof-of-possession comes from PKCE instead - we generate a random
 * verifier, send only its SHA-256 hash to start the flow, and present the
 * verifier at token exchange. An attacker who steals the authorization code
 * off the redirect cannot redeem it without the verifier.
 */

const ISSUER = (process.env.NEXT_PUBLIC_OIDC_ISSUER || "").replace(/\/$/, "");
const CLIENT_ID = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID || "gotcha-app";

/**
 * Endpoints come from the discovery document, never from string-concatenating
 * the issuer. Authentik does not nest them all under the issuer path (the
 * issuer is /application/o/gotcha/ but authorize lives at /application/o/
 * authorize/), so guessing produces 404s. Discovery is also what makes this a
 * standards-compliant client rather than one hard-coded to today's Authentik.
 */
interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint: string;
  code_challenge_methods_supported?: string[];
}

let discoveryCache: Promise<Discovery> | null = null;

function discover(): Promise<Discovery> {
  if (!ISSUER) throw new Error("NEXT_PUBLIC_OIDC_ISSUER is not configured");
  if (!discoveryCache) {
    discoveryCache = fetch(`${ISSUER}/.well-known/openid-configuration`)
      .then((r) => {
        if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
        return r.json();
      })
      .catch((e) => {
        discoveryCache = null; // never cache a failure
        throw e;
      });
  }
  return discoveryCache;
}

const VERIFIER_KEY = "oidc:verifier";
const STATE_KEY = "oidc:state";
const RETURN_KEY = "oidc:return_to";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

function redirectUri(): string {
  return (
    process.env.NEXT_PUBLIC_OIDC_REDIRECT_URI ||
    `${window.location.origin}/auth/callback`
  );
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  // Indexed loop rather than for..of: this file compiles under an ES5-ish
  // target where iterating a Uint8Array needs downlevelIteration.
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * Send the browser to Authentik to authenticate.
 *
 * The verifier and state are held in sessionStorage: they are single-use,
 * scoped to this tab, and must not outlive the redirect round-trip.
 */
export async function beginLogin(returnTo?: string, loginHint?: string): Promise<void> {
  const config = await discover();
  const verifier = randomString();
  const state = randomString(16);

  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(RETURN_KEY, returnTo || window.location.pathname + window.location.search);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile offline_access",
    code_challenge: await challengeFor(verifier),
    // S256 only. Authentik also advertises `plain`, which would send the
    // verifier in the clear and defeat the point.
    code_challenge_method: "S256",
    state,
  });
  // Prefill hint only - the identifier the user actually authenticates with is
  // still whatever Authentik's identification stage accepts.
  if (loginHint) params.set("login_hint", loginHint);

  window.location.assign(`${config.authorization_endpoint}?${params}`);
}

/**
 * Complete the flow on the callback route.
 *
 * Verifies `state` before touching the code: that is the CSRF defence for the
 * redirect, ensuring the response belongs to a flow this tab started.
 */
export async function completeLogin(search: string): Promise<{ tokens: TokenSet; returnTo: string }> {
  const params = new URLSearchParams(search);

  const error = params.get("error");
  if (error) throw new Error(params.get("error_description") || error);

  const code = params.get("code");
  const state = params.get("state");
  if (!code) throw new Error("No authorization code in callback");

  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!expectedState || state !== expectedState) {
    throw new Error("State mismatch - possible CSRF, refusing to continue");
  }

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("Missing PKCE verifier - restart login");

  const returnTo = sessionStorage.getItem(RETURN_KEY) || "/";
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(RETURN_KEY);

  const config = await discover();
  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const json = await res.json();

  return { tokens: toTokenSet(json), returnTo };
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const config = await discover();
  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error("Refresh failed");
  return toTokenSet(await res.json());
}

function toTokenSet(json: any): TokenSet {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 1800) * 1000,
  };
}

/**
 * End the Authentik session, not just the local one.
 *
 * Clearing local tokens alone would leave the IdP session intact, so the next
 * login would silently re-authenticate and the user would not experience
 * having logged out at all.
 */
export async function logoutUrl(): Promise<string> {
  const config = await discover();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    post_logout_redirect_uri: window.location.origin + "/",
  });
  return `${config.end_session_endpoint}?${params}`;
}

/**
 * Where a user manages their own password, MFA, and passkeys.
 *
 * Authentik's user portal, derived from the issuer origin - GOTCHA has no
 * account-security screens of its own to link to any more.
 */
export function accountSettingsUrl(): string {
  return `${new URL(ISSUER).origin}/if/user/#/settings`;
}

/** Public origin of Authentik, as the browser reaches it. */
export function authentikOrigin(): string {
  return new URL(ISSUER).origin;
}

/**
 * The page an embedded flow lands on when it FINISHES. It posts a message to
 * the parent window so the modal/gate can close or advance. Without a `next`,
 * Authentik would redirect the finished flow to its own user dashboard - which,
 * inside our iframe, looked like "the app appeared in the popup".
 */
export function flowDoneUrl(): string {
  return `${window.location.origin}/auth/flow-done`;
}

/**
 * URL of a specific Authentik FLOW, for embedding in an in-app modal iframe.
 * The gateway allows framing from *.gotcha.co.il (CSP frame-ancestors), and the
 * user's Authentik session cookie is same-site, so the flow runs authenticated
 * inside GOTCHA - MFA / passkey / recovery-code setup without leaving the app.
 *
 * We always pass `?next=<flow-done page>` so a completed flow redirects to our
 * tiny signalling page instead of Authentik's dashboard.
 */
export function authentikFlowUrl(slug: string): string {
  const next = encodeURIComponent(flowDoneUrl());
  return `${authentikOrigin()}/if/flow/${slug}/?next=${next}`;
}

/** Message type posted by /auth/flow-done to the window that opened the flow. */
export const FLOW_DONE_MESSAGE = "gotcha-flow-done";

/** Well-known enrolment flow slugs (bound in scripts/authentik/bootstrap.mjs). */
export const AUTHENTIK_FLOWS = {
  totp: "default-authenticator-totp-setup",
  passkey: "default-authenticator-webauthn-setup",
  recoveryCodes: "default-authenticator-static-setup",
} as const;
