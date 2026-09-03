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
/**
 * The fields `ActiveSubscription` ACTUALLY has.
 *
 * Verified by introspecting the live Partner API, not from documentation. The
 * previous version of this query asked for `id` and `status`; neither exists,
 * so every verification failed with "Field 'id' doesn't exist on type
 * 'ActiveSubscription'" the first time a merchant approved a plan. It had
 * never been executed against the real API - which is exactly why the
 * capability table marked App Pricing `verifySubscription: "unverified"`.
 *
 * THERE IS NO `status` FIELD, and that is not an omission on Shopify's part.
 * `activeSubscription` returns a subscription ONLY while one is active; the
 * absence of a result IS "not subscribed". Modelling a status here would be
 * inventing a value the API never sends - see `deriveStatus` below.
 *
 * The full field set, for anyone tempted to add one:
 *   app, billingPeriod, cancelAtEndOfCycle, currentBillingCycle,
 *   items, legacySubscriptionId, pendingUpdate, shop, trialEndsAt
 */
const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      legacySubscriptionId
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle { startTime endTime }
      items { handle description }
    }
  }
`;

/**
 * Every field this query selects, so a test can assert we ask for nothing the
 * schema does not have. Kept beside the query deliberately: the failure mode
 * being defended against is the two drifting apart.
 */
export const ACTIVE_SUBSCRIPTION_FIELDS = [
  "legacySubscriptionId",
  "billingPeriod",
  "cancelAtEndOfCycle",
  "trialEndsAt",
  "currentBillingCycle",
  "items",
] as const;

/**
 * Turn "a subscription exists" into a status, since the API sends none.
 *
 * TRIALING when Shopify reports a trial end in the future, ACTIVE otherwise.
 * Both grant access, so a wrong choice between them costs a label rather than
 * a capability - but the merchant sees "trial until…" instead of "active",
 * and being wrong about that is the kind of small lie that erodes trust in
 * every other number on the page.
 */
export function deriveStatus(trialEndsAt: Date | null, now: Date = new Date()): "ACTIVE" | "TRIALING" {
  return trialEndsAt && trialEndsAt.getTime() > now.getTime() ? "TRIALING" : "ACTIVE";
}

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

  const trialEndsAt = toDate(sub.trialEndsAt);
  return {
    // `legacySubscriptionId` comes back as a GID
    // (`gid://shopify/AppSubscription/40080539962`). Stored verbatim: it is
    // what Shopify calls the subscription, and normalising it to the numeric
    // tail would leave us holding an identifier Shopify does not use.
    id: sub.legacySubscriptionId ?? null,
    // Derived, because the API has no status field. Recorded as the raw value
    // too, so `providerStatusRaw` still says where it came from rather than
    // implying Shopify sent it.
    status: deriveStatus(trialEndsAt),
    planHandle: Array.isArray(sub.items) && sub.items[0]?.handle ? String(sub.items[0].handle) : null,
    trialEndsAt,
    currentPeriodStart: toDate(sub.currentBillingCycle?.startTime),
    currentPeriodEnd: toDate(sub.currentBillingCycle?.endTime),
    cancelAtEndOfCycle: Boolean(sub.cancelAtEndOfCycle),
    // Only non-sensitive, non-monetary fields are kept. Prices stay in the
    // Partner Dashboard where they are defined.
    metadata: { billingPeriod: sub.billingPeriod ?? null },
  };
}
