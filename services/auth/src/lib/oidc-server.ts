import crypto from "crypto";

/**
 * Server-side OIDC Authorization-Code + PKCE helper for the BFF login flow
 * (migration §A5). This is the SERVER half of what used to be the browser's
 * `frontend/src/lib/oidc.ts`: it starts the flow, holds the PKCE verifier
 * server-side (in OidcLoginState), and exchanges the code server-side so no
 * token ever reaches the browser.
 *
 * Endpoints come from the issuer's discovery document, never from string-
 * concatenating the issuer (Authentik does not nest authorize/token under the
 * issuer path). Only used when SESSION_COOKIE_CREATE is enabled.
 */

const b64url = (b: Buffer) => b.toString("base64url");

export interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** Optional override for the discovery URL (e.g. internal DNS). */
  discoveryUrl?: string;
}

/** Read the server OIDC config from the environment. Throws if incomplete. */
export function oidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const issuer = (env.OIDC_ISSUER || "").replace(/\/$/, "");
  const clientId = env.OIDC_CLIENT_ID || "";
  // The callback is a BACKEND route (same host as the app, /api path) so it is
  // reached over the existing /api/auth nginx routing with no new vhost.
  const redirectUri =
    env.OIDC_SERVER_REDIRECT_URI ||
    (env.APP_ORIGIN ? `${env.APP_ORIGIN.replace(/\/$/, "")}/api/auth/callback` : "");
  if (!issuer) throw new Error("[oidc] OIDC_ISSUER is required");
  if (!clientId) throw new Error("[oidc] OIDC_CLIENT_ID is required");
  if (!redirectUri) throw new Error("[oidc] APP_ORIGIN (or OIDC_SERVER_REDIRECT_URI) is required for the callback");
  return { issuer, clientId, redirectUri, discoveryUrl: env.OIDC_DISCOVERY_URL };
}

let discoveryCache: { key: string; value: Promise<Discovery> } | null = null;

export function __resetOidcDiscoveryCache(): void {
  discoveryCache = null;
}

/** Fetch (and cache) the issuer discovery document. */
export function discover(cfg: OidcConfig, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const url = cfg.discoveryUrl || `${cfg.issuer}/.well-known/openid-configuration`;
  if (discoveryCache?.key === url) return discoveryCache.value;
  const value = fetchImpl(url)
    .then((r) => {
      if (!r.ok) throw new Error(`[oidc] discovery failed: ${r.status}`);
      return r.json() as Promise<Discovery>;
    })
    .catch((e) => {
      discoveryCache = null; // never cache a failure
      throw e;
    });
  discoveryCache = { key: url, value };
  return value;
}

/** Fresh PKCE pair (S256). The verifier stays server-side. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomState = () => b64url(crypto.randomBytes(16));
export const randomNonce = () => b64url(crypto.randomBytes(16));

/** Build the authorize URL (pure). */
export function buildAuthorizeUrl(
  disco: Discovery,
  cfg: OidcConfig,
  args: { state: string; nonce: string; challenge: string; loginHint?: string },
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile offline_access",
    code_challenge: args.challenge,
    code_challenge_method: "S256", // S256 only; never `plain`
    state: args.state,
    nonce: args.nonce,
  });
  if (args.loginHint) params.set("login_hint", args.loginHint);
  return `${disco.authorization_endpoint}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_in?: number;
  token_type?: string;
}

/** Exchange the authorization code for tokens (server-side, public client + PKCE). */
export async function exchangeCode(
  disco: Discovery,
  cfg: OidcConfig,
  args: { code: string; verifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl(disco.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      code_verifier: args.verifier,
    }),
  });
  if (!res.ok) throw new Error(`[oidc] token exchange failed: ${res.status}`);
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token || !json.id_token) throw new Error("[oidc] token response missing tokens");
  return json;
}

/** Validate a `returnTo` is a safe same-app RELATIVE path (never an open redirect). */
export function safeReturnTo(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  // Must be a root-relative path, not a scheme/host and not protocol-relative.
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) return "/";
  return input;
}
