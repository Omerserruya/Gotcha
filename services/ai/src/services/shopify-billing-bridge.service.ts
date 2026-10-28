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
 * Throws when billing did not take it (split billing 2026-10-28): the
 * app/uninstalled webhook now answers only after its work, so a failure here
 * is a 500 and Shopify redelivers, instead of the Shopify-funded access
 * surviving an uninstall until reconciliation. Billing's handler is idempotent.
 */
export async function notifyShopifyUninstalled(input: {
  externalShopId?: string | null;
  shopDomain?: string | null;
}): Promise<void> {
  const res = await post("/api/internal/billing/shopify/uninstalled", input);
  if (!res.ok) throw new Error(`billing uninstall hook returned ${res.status}`);
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

/** The Connector's verdict as the integration and tool screens show it. */
export interface ShopifyConnectorSummary {
  scope: "shopify_connector";
  billedBy: "shopify";
  grantsAccess: boolean;
  status: string;
  capabilities: Record<string, boolean>;
}

/** Billing unreachable: no access claimed, and the screen says so rather than "Connected". */
const UNKNOWN_CONNECTOR: ShopifyConnectorSummary = {
  scope: "shopify_connector",
  billedBy: "shopify",
  grantsAccess: false,
  status: "error",
  capabilities: { shopify_catalog_sync: false, shopify_order_read: false, shopify_order_actions: false, shopify_storefront_widget: false },
};

/**
 * The same verdict GET /api/billing/shopify/state returns, read from billing
 * (split billing 2026-10-28): the integrations list and the tool count take
 * Shopify's status from here, never from the OAuth row being CONNECTED.
 * Fails closed.
 */
export async function getShopifyConnectorSummary(tenantId: string): Promise<ShopifyConnectorSummary> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/shopify/state/${encodeURIComponent(tenantId)}`, {
      headers: { "X-Internal-Key": getInternalServiceKey() },
      signal: controller.signal,
    });
    if (!res.ok) return UNKNOWN_CONNECTOR;
    const data = ((await res.json()) as any)?.data;
    if (!data || typeof data.grantsAccess !== "boolean") return UNKNOWN_CONNECTOR;
    return {
      scope: "shopify_connector",
      billedBy: "shopify",
      grantsAccess: data.grantsAccess,
      status: String(data.connector?.status ?? "error"),
      capabilities: { ...UNKNOWN_CONNECTOR.capabilities, ...(data.capabilities ?? {}) },
    };
  } catch (err: any) {
    console.warn(`[shopify billing bridge] connector state failed: ${err?.message}`);
    return UNKNOWN_CONNECTOR;
  } finally {
    clearTimeout(timer);
  }
}
