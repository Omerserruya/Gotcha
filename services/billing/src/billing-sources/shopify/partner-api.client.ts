/**
 * The Shopify Partner API, used for one thing: finding out whether a merchant
 * actually has an active subscription.
 *
 * Under App Pricing this is the only authoritative source there is. Shopify
 * sends no subscription webhooks and returns only `plan_handle` and `shop` on
 * the redirect, and Shopify's own guidance is to confirm by querying
 * `activeSubscription(appId:, shopId:)` here.
 *
 * The credential is ORGANISATION-level, not per-shop. That is why this file can
 * live in the billing service at all - it needs no merchant Admin token, so the
 * service-ownership boundary with services/ai is preserved.
 *
 * A null answer means "Shopify has no active contract for this shop", and
 * callers must treat it as REVOKE rather than as "no news". Treating an absent
 * subscription as "leave things as they were" is precisely how a cancelled
 * merchant keeps paid access forever.
 */
import { isShopifyBillingMock } from "./config";

const DEFAULT_BASE = "https://partners.shopify.com";

export interface ActiveSubscriptionResult {
  id: string | null;
  status: string | null;
  planHandle: string | null;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtEndOfCycle: boolean;
  metadata: Record<string, unknown>;
}

export class PartnerApiError extends Error {
  readonly code = "SHOPIFY_PARTNER_API_ERROR";
  constructor(message: string, readonly status?: number) {
    super(`[shopify-billing][partner-api] ${message}`);
    this.name = "PartnerApiError";
  }
}

/**
 * Shopify's documented shape for this query.
 *
 * `items` carries the plan and its pricing; we read only the handle. Prices are
 * deliberately NOT mirrored: the Partner Dashboard is where they are defined,
 * and a copy in our database would eventually disagree with what the merchant
 * was actually shown.
 */
const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      id
      status
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle { startTime endTime }
      items { handle }
    }
  }
`;

function apiUrl(organizationId: string): string {
  const base = (process.env.SHOPIFY_PARTNER_API_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const version = process.env.SHOPIFY_PARTNER_API_VERSION || "2026-07";
  return `${base}/${encodeURIComponent(organizationId)}/api/${version}/graphql.json`;
}

function toDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Shopify wants GIDs; accept either form from callers and normalise. */
function shopGid(shopId: string): string {
  return shopId.startsWith("gid://") ? shopId : `gid://shopify/Shop/${shopId}`;
}

function appGid(appId: string): string {
  return appId.startsWith("gid://") ? appId : `gid://shopify/App/${appId}`;
}

/**
 * Read the shop's current contract for our app.
 *
 * Returns null when there is none. Throws only for a transport or
 * authorisation failure - the difference matters, because "no subscription" is
 * a fact to act on and "we could not ask" is emphatically not.
 */
export async function queryActiveSubscription(shopId: string): Promise<ActiveSubscriptionResult | null> {
  if (isShopifyBillingMock()) return null;

  const token = process.env.SHOPIFY_PARTNER_API_TOKEN;
  const organizationId = process.env.SHOPIFY_PARTNER_ORGANIZATION_ID;
  const appId = process.env.SHOPIFY_PARTNER_APP_ID;

  if (!token || !organizationId || !appId) {
    // Not a "no subscription" answer. Saying null here would silently revoke
    // every merchant's access the moment a credential went missing.
    throw new PartnerApiError(
      "not configured (SHOPIFY_PARTNER_API_TOKEN / _ORGANIZATION_ID / _APP_ID) - cannot verify, and refusing to report 'no subscription' instead",
    );
  }

  const res = await fetch(apiUrl(organizationId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({
      query: ACTIVE_SUBSCRIPTION_QUERY,
      variables: { appId: appGid(appId), shopId: shopGid(shopId) },
    }),
  });

  if (!res.ok) {
    // No response body in the message: an auth failure is exactly where a
    // token could be echoed back.
    throw new PartnerApiError(`HTTP ${res.status} querying activeSubscription`, res.status);
  }

  const body = (await res.json()) as {
    data?: { activeSubscription?: any };
    errors?: Array<{ message?: string }>;
  };

  if (body.errors?.length) {
    throw new PartnerApiError(
      `GraphQL errors: ${body.errors.map((e) => e.message ?? "unknown").join("; ").slice(0, 300)}`,
    );
  }

  const sub = body.data?.activeSubscription;
  if (!sub) return null;

  return {
    id: sub.id ?? null,
    status: sub.status ?? null,
    planHandle: Array.isArray(sub.items) && sub.items[0]?.handle ? String(sub.items[0].handle) : null,
    trialEndsAt: toDate(sub.trialEndsAt),
    currentPeriodStart: toDate(sub.currentBillingCycle?.startTime),
    currentPeriodEnd: toDate(sub.currentBillingCycle?.endTime),
    cancelAtEndOfCycle: Boolean(sub.cancelAtEndOfCycle),
    // Only non-sensitive, non-monetary fields are kept. Prices stay in the
    // Partner Dashboard where they are defined.
    metadata: { billingPeriod: sub.billingPeriod ?? null },
  };
}
