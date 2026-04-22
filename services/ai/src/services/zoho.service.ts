/**
 * Zoho CRM — OAuth token exchange + refresh helpers.
 *
 * Zoho implements standard OAuth2 with two non-standard details:
 *   1. The API host is region-specific and returned per-user at token exchange
 *      time as `api_domain` (e.g. https://www.zohoapis.com vs .eu / .in / etc.).
 *      We persist it on TenantIntegration.config.baseUrl so tool-execution can
 *      address the correct datacenter for that tenant.
 *   2. API calls expect the header `Authorization: Zoho-oauthtoken <token>`
 *      — NOT `Bearer`. That scheme is persisted on config.authScheme and read
 *      by tool-execution.service at dispatch time.
 *
 * Access tokens are short-lived (~1h). `maybeRefreshZohoToken` is called
 * before each tool dispatch; if the stored token is within 60s of expiry, it
 * issues a refresh and writes the new token back to the DB.
 *
 * Refresh tokens DO NOT expire for Server-based Applications, but Zoho caps
 * them at ~20 active per user; the "offline_access" / `access_type=offline`
 * parameter is only needed if we want Zoho to return a refresh_token in the
 * response, which we do.
 */
import { prisma } from "@chatcenter/shared";

export interface ZohoTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  api_domain: string;
  token_type: string;
  scope?: string;
}

export interface ZohoCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  scope?: string;
}

export function getZohoAccountsUrl(): string {
  return (process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com").replace(/\/$/, "");
}

/**
 * Exchange an authorization code for an access + refresh token pair.
 * Throws on non-2xx or missing access_token — caller wraps to an error response.
 */
export async function exchangeZohoCode(params: {
  code: string;
  redirectUri: string;
}): Promise<ZohoTokenResponse> {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET not configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  const res = await fetch(`${getZohoAccountsUrl()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Zoho token exchange failed (${res.status}): ${json.error || JSON.stringify(json)}`,
    );
  }
  return json as ZohoTokenResponse;
}

/**
 * Refresh an existing access token using the stored refresh_token.
 * Zoho does NOT rotate refresh tokens on refresh, so we only update
 * access_token + expires_at.
 */
export async function refreshZohoAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresIn: number;
  apiDomain?: string;
  scope?: string;
}> {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET not configured");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(`${getZohoAccountsUrl()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Zoho token refresh failed (${res.status}): ${json.error || JSON.stringify(json)}`,
    );
  }
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in ?? 3600,
    apiDomain: json.api_domain,
    scope: json.scope,
  };
}

/**
 * Ensure the stored access token has at least 60s of life remaining.
 * If expired/near-expiry, refresh and persist. Returns the fresh access
 * token so the caller can use it in-memory without re-reading the row.
 *
 * Returns null if the integration has no refreshToken (nothing to do —
 * caller should let the original token fly and surface any 401 as-is).
 */
export async function maybeRefreshZohoToken(integrationId: string): Promise<string | null> {
  const integration = await prisma.tenantIntegration.findUnique({
    where: { id: integrationId },
    select: { id: true, credentials: true },
  });
  if (!integration) return null;

  const creds = (integration.credentials as Record<string, any>) || {};
  const refreshToken: string | undefined = creds.refreshToken;
  const accessToken: string | undefined = creds.accessToken;
  const expiresAt: number | undefined = creds.expiresAt;

  if (!refreshToken) return accessToken ?? null;

  const fresh = typeof expiresAt === "number" ? expiresAt - Date.now() < 60_000 : true;
  if (!fresh && accessToken) return accessToken;

  const refreshed = await refreshZohoAccessToken(refreshToken);
  const newExpiresAt = Date.now() + refreshed.expiresIn * 1000;

  await prisma.tenantIntegration.update({
    where: { id: integration.id },
    data: {
      credentials: {
        ...creds,
        accessToken: refreshed.accessToken,
        expiresAt: newExpiresAt,
        ...(refreshed.scope ? { scope: refreshed.scope } : {}),
      },
    },
  });

  return refreshed.accessToken;
}

/**
 * Default scope bundle for Zoho CRM — read + write on Contacts, Leads,
 * Deals, plus offline_access so Zoho returns a refresh_token. Extend as
 * we add more CatalogTool rows.
 */
export const ZOHO_DEFAULT_SCOPES = [
  "ZohoCRM.modules.contacts.ALL",
  "ZohoCRM.modules.leads.ALL",
  "ZohoCRM.modules.deals.ALL",
  "ZohoCRM.users.READ",
].join(",");
