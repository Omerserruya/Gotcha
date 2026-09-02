/**
 * The one place services/ai talks to billing about Shopify.
 *
 * WHY A BRIDGE AND NOT A DIRECT QUERY
 * -----------------------------------
 * Both services share a Prisma client, so reading `commerce_connections` from
 * here would compile and work. It is still wrong: the commercial meaning of a
 * connection - grandfathering, plan requirements, entitlement funding - lives
 * in billing, and a second service deciding it would mean two implementations
 * of one policy, drifting. services/ai answers "which store, which workspace",
 * because it holds the HMAC verification and the session. Billing answers "and
 * what does that cost", because it holds the money.
 *
 * EVERYTHING HERE IS BEST-EFFORT, DELIBERATELY
 * --------------------------------------------
 * These calls happen AFTER OAuth has succeeded and the store has been linked.
 * By that point the merchant has authorized the app on Shopify's side and there
 * is no honest way to un-authorize it. So a billing service that is down,
 * slow, or misconfigured must not turn a completed installation into an error
 * page: the caller falls through to the ordinary connected screen, and
 * reconciliation settles the billing state later.
 *
 * The single exception is a cross-tenant claim (409), which is surfaced,
 * because "this store belongs to another workspace" is something the merchant
 * has to be told rather than something to retry past.
 */

import { getInternalServiceKey } from "@chatcenter/shared";

const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

/**
 * Short, because this sits in the middle of an OAuth redirect.
 *
 * A merchant staring at a blank tab while we wait on an internal service is a
 * worse outcome than a billing state that resolves a minute later - the
 * reconciliation job exists precisely so that this timeout is survivable.
 */
const TIMEOUT_MS = 4000;

export interface ShopifyConnectedResult {
  connectionId: string;
  state: string;
  grandfathered: boolean;
  requiresPlanSelection: boolean;
  planSelectionUrl: string | null;
}

export class CrossTenantShopError extends Error {
  readonly code = "shop_taken";
  constructor(message: string) {
    super(message);
    this.name = "CrossTenantShopError";
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BILLING_SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": getInternalServiceKey(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tell billing a store finished OAuth, and get back what to do next.
 *
 * Returns null when billing could not answer. Null means "carry on as before":
 * the connection exists, the merchant lands on the connected screen, and the
 * billing state resolves on the next reconciliation pass.
 */
export async function notifyShopifyConnected(input: {
  tenantId: string;
  externalShopId: string;
  shopDomain?: string | null;
  acquisitionSource?: string | null;
  isDevelopmentStore?: boolean;
}): Promise<ShopifyConnectedResult | null> {
  try {
    const res = await post("/api/internal/billing/shopify/connected", input);
    if (res.status === 409) {
      const body: any = await res.json().catch(() => ({}));
      throw new CrossTenantShopError(body?.message || "This store is connected to another workspace.");
    }
    if (!res.ok) {
      console.warn(`[shopify billing bridge] connected hook returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { data: ShopifyConnectedResult };
    return body.data ?? null;
  } catch (err: any) {
    if (err instanceof CrossTenantShopError) throw err;
    // Timeout, DNS, billing down. The shop domain is deliberately not logged
    // here - it identifies a merchant, and this line is only useful for
    // knowing that the bridge failed at all.
    console.warn(`[shopify billing bridge] connected hook failed: ${err?.message}`);
    return null;
  }
}

/**
 * Tell billing a store was uninstalled.
 *
 * Fire-and-forget by design. The webhook has already been verified and
 * acknowledged; retrying it here would risk Shopify timing out and redelivering
 * a webhook we already handled. Reconciliation catches anything missed.
 */
export async function notifyShopifyUninstalled(input: {
  externalShopId?: string | null;
  shopDomain?: string | null;
}): Promise<void> {
  try {
    const res = await post("/api/internal/billing/shopify/uninstalled", input);
    if (!res.ok) {
      console.warn(`[shopify billing bridge] uninstall hook returned ${res.status}`);
    }
  } catch (err: any) {
    console.warn(`[shopify billing bridge] uninstall hook failed: ${err?.message}`);
  }
}

/**
 * Everything the OAuth callback needs to decide where to send the merchant.
 *
 * Wraps the shop-identity lookup and the billing notification together because
 * the two fail the same way and are handled the same way: if either cannot be
 * completed, the answer is "carry on to the connected screen", never an error.
 *
 * Returns null when billing had nothing to say, which the caller reads as
 * "use the ordinary post-OAuth redirect".
 */
export async function resolveShopifyBillingOutcome(input: {
  tenantId: string;
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  acquisitionSource: string;
}): Promise<ShopifyConnectedResult | null> {
  const { getShopIdentity } = await import("./connectors/shopify-gql-shop");

  let externalShopId: string | null = null;
  let isDevelopmentStore = false;
  try {
    const identity = await getShopIdentity({
      token: input.accessToken,
      base: `https://${input.shopDomain}/admin/api/${input.apiVersion}`,
    });
    externalShopId = identity.shopId;
    isDevelopmentStore = identity.isDevelopmentStore;
  } catch (err: any) {
    console.warn(`[shopify billing bridge] shop identity lookup failed: ${err?.message}`);
  }

  // No immutable id means no connection row worth writing. The domain is NOT
  // substituted: `CommerceConnection.externalShopId` is unique per platform and
  // is the thing that stops one store being claimed by two workspaces, so
  // filling it with a value a merchant can change would weaken exactly the
  // guarantee it exists to provide.
  if (!externalShopId) return null;

  return notifyShopifyConnected({
    tenantId: input.tenantId,
    externalShopId,
    shopDomain: input.shopDomain,
    acquisitionSource: input.acquisitionSource,
    isDevelopmentStore,
  });
}
