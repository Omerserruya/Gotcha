/**
 * Shopify's App Events API - the usage-billing endpoint for App Pricing.
 *
 * Contract, from shopify.dev, checked 2026-08-31:
 *
 *     POST https://api.shopify.com/app/unstable/events
 *     Authorization: Bearer <JWT>
 *     { shop_id, event_handle, timestamp, idempotency_key, attributes: { value } }
 *
 * The JWT comes from an OAuth2 `client_credentials` exchange against
 * https://api.shopify.com/auth/access_token and lasts 60 minutes.
 *
 * Three properties of this contract drive the code below.
 *
 * IT IS AN APP-LEVEL CREDENTIAL, NOT A SHOP TOKEN. That is what lets this live
 * in the billing service at all: billing never touches a merchant's Admin
 * token, which belongs to services/ai, so the service-ownership boundary holds.
 *
 * `idempotency_key` IS ENFORCED PERMANENTLY. Shopify's copy of the guard and
 * the ledger's unique index therefore agree by construction. Retrying is safe;
 * changing the key on a retry is what would not be.
 *
 * `timestamp` MUST BE INSIDE THE CURRENT BILLING CYCLE (and no more than five
 * minutes ahead). A stale event cannot simply be replayed - it will be refused
 * forever, and that refusal has to be reported as permanent so the dispatcher
 * stops retrying instead of burning attempts on something that can never work.
 *
 * NOTE the `unstable` path segment. It is what Shopify's own documentation
 * gives today; it is also a stability risk worth revisiting, which is why the
 * base URL is overridable.
 */
import { isShopifyBillingMock } from "./config";
import type { UsageDispatchResult } from "../source";

const DEFAULT_BASE = "https://api.shopify.com";
const TOKEN_PATH = "/auth/access_token";
const EVENTS_PATH = "/app/unstable/events";

/** Refresh a minute early rather than discovering expiry mid-dispatch. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Test seam - the module-level cache would otherwise outlive a test's env. */
export function __resetAppEventsTokenCache(): void {
  cachedToken = null;
}

function baseUrl(): string {
  return (process.env.SHOPIFY_APP_EVENTS_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

export class AppEventsAuthError extends Error {
  readonly code = "SHOPIFY_APP_EVENTS_AUTH_FAILED";
}

/**
 * A bearer token for the App Events API, cached until shortly before expiry.
 *
 * Credentials are read at call time rather than at module load so that a test
 * or an operator changing the environment is not silently ignored.
 */
async function accessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - TOKEN_SAFETY_MARGIN_MS > now) return cachedToken.value;

  const clientId = process.env.SHOPIFY_APP_EVENTS_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_APP_EVENTS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppEventsAuthError(
      "[shopify-billing] App Events credentials are not configured (SHOPIFY_APP_EVENTS_CLIENT_ID/_SECRET)",
    );
  }

  const res = await fetch(`${baseUrl()}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    // Deliberately does NOT include the response body: a failed auth response
    // is exactly the place a credential could be echoed back at us.
    throw new AppEventsAuthError(
      `[shopify-billing] App Events token exchange failed with HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new AppEventsAuthError("[shopify-billing] token response carried no access_token");

  cachedToken = {
    value: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

export interface SendBillingEventInput {
  shopId: string;
  eventHandle: string;
  quantity: string;
  occurredAt: Date;
  idempotencyKey: string;
}

/**
 * Send one billable event.
 *
 * Never throws for a provider-level refusal - it returns a result the
 * dispatcher can record. It DOES throw for a transport failure, because "the
 * request did not complete" and "the provider said no" are different facts and
 * only one of them is safe to stop retrying on.
 */
export async function sendBillingEvent(input: SendBillingEventInput): Promise<UsageDispatchResult> {
  if (isShopifyBillingMock()) {
    // Mock reaches no network at all. Accepting here means the dispatcher's
    // own state machine can be exercised without a Shopify account, which is
    // the same bargain ICOUNT_MODE=mock strikes.
    return { accepted: true, providerEventId: `mock_${input.idempotencyKey}` };
  }

  const token = await accessToken();
  const res = await fetch(`${baseUrl()}${EVENTS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      // Shopify accepts a GID or a numeric id as a string.
      shop_id: input.shopId,
      event_handle: input.eventHandle,
      timestamp: input.occurredAt.toISOString(),
      idempotency_key: input.idempotencyKey,
      attributes: { value: input.quantity },
    }),
  });

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { id?: string; event_id?: string };
    return { accepted: true, providerEventId: body.id ?? body.event_id ?? input.idempotencyKey };
  }

  // 4xx is the provider judging the request itself: a timestamp outside the
  // cycle, an unknown meter handle, a malformed key. None of those improve by
  // being sent again. 429 is the exception - it is a 4xx that explicitly means
  // "later".
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
  const detail = await res.text().catch(() => "");
  return {
    accepted: false,
    permanent,
    failureCode: `http_${res.status}`,
    // Truncated: a provider error body is not a place to assume nothing
    // sensitive was echoed back.
    failureReason: detail.slice(0, 300) || null,
  };
}
