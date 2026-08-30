/**
 * Binding a VERIFIED Shopify store to a GOTCHA workspace.
 *
 * Every path that finishes a Shopify install ends here, and this is the only
 * module that writes the connection. There are three such paths and they
 * differ only in HOW the workspace was established:
 *
 *   1. callback with an intent  - the merchant was signed in when they
 *                                 clicked Connect; the workspace came from
 *                                 their validated session before Shopify was
 *                                 ever involved.
 *   2. deferred claim           - the install began on Shopify; the merchant
 *                                 signed in afterwards and the workspace came
 *                                 from THAT validated session.
 *   3. reauthorization          - the workspace already owns this shop and is
 *                                 re-granting scopes.
 *
 * What is identical across all three, and is enforced here rather than at
 * each call site:
 *
 *   • the shop is already verified (Shopify signed it) - this module does not
 *     re-derive trust, it refuses to run without it;
 *   • a shop connected to ANOTHER workspace is never silently moved;
 *   • reconnecting the same shop to the same workspace updates one row and
 *     creates no second one.
 */

import {
  prisma,
  withCrossTenantAccess,
  normalizeShopifyShopDomain,
  encryptCredentials,
} from "@chatcenter/shared";
import { findCatalog, upsertConnection } from "./connector-connection.service";
import { refreshCapabilityState } from "./connectors/integration-framework";
import { reconcileAgentToolPermissions } from "./tool-permission-reconcile.service";

/**
 * The scopes GOTCHA requests, in the ONE place that decides them.
 *
 * Moved out of the OAuth init route because two entry points now build an
 * authorize URL, and a scope list that lives at one of them is a list the
 * other silently disagrees with. The commentary below is the history of what
 * happens when this set is wrong - each entry was added after a live failure.
 *
 * Discount tools are on the GraphQL Discounts API, gated on read_discounts /
 * write_discounts. The price-rule scopes are kept for connections granted
 * before the REST->GraphQL migration: dropping a scope from the request does
 * not remove it from an existing grant, and keeping them costs nothing while
 * every store re-consents at its own pace.
 *
 * FULFILLMENT ORDERS, INVENTORY and CUSTOMER WRITES were once missing here.
 * A store connected through this flow read every order as unfulfilled,
 * answered "nothing has shipped" for orders in fulfillment, and offered to
 * cancel orders Shopify would refuse.
 *
 * `write_returns` and `write_order_edits` were on the not-requested list with
 * the note "no tool creates an RMA / edits an order". Both tools now exist,
 * and the note outliving the fact is how an exchange reached a live store and
 * failed at orderEditBegin with "Requires `write_order_edits` access scope" -
 * after eligibility passed, after the price was quoted, after a human
 * approved it. A scope list that is a comment about the past rather than a
 * statement about the tool surface fails exactly this way: silently, and only
 * at the last step.
 *
 * Deliberately NOT requested: write_fulfillments (no tool creates a
 * fulfillment), write_draft_orders and read_draft_orders (no draft-order tool
 * exists), and the third-party fulfillment-order scopes (only meaningful for
 * merchants using a 3PL - read_assigned_fulfillment_orders is requested for
 * that case, and a merchant without one loses nothing by granting it).
 */
export const SHOPIFY_OAUTH_SCOPES = [
  "read_orders", "write_orders",
  // Orders older than 60 days are invisible to read_orders alone, and a
  // customer asking about last season's order is an ordinary request.
  "read_all_orders",
  "read_customers", "write_customers",
  "read_merchant_managed_fulfillment_orders",
  "read_assigned_fulfillment_orders",
  "read_inventory",
  "read_price_rules", "write_price_rules",
  "write_discounts",
  "read_products",
  "read_returns", "write_returns",
  "write_order_edits",
].join(",");

export type LinkRefusal =
  | "catalog_missing"
  | "shop_taken"
  | "shop_invalid";

export type LinkResult =
  | { ok: true; connectionId: string; reconnected: boolean }
  | { ok: false; reason: LinkRefusal; conflictingTenantId?: string };

/**
 * Which tenant, if any, already holds this shop.
 *
 * Reads across tenants deliberately and returns only ids - this is an
 * ownership question, not a data read, and the answer must never widen into
 * "here is the other workspace's connection".
 *
 * DISCONNECTED rows are included on purpose. An uninstall marks the row
 * DISCONNECTED and clears the token but keeps tenant ownership, which is what
 * makes a reinstall land back in the same workspace. Ignoring those rows here
 * would let a second workspace claim a store the moment the first one
 * uninstalled.
 */
export async function findShopOwner(shopDomain: string): Promise<{
  tenantId: string;
  connectionId: string;
  status: string;
} | null> {
  const shop = normalizeShopifyShopDomain(shopDomain);
  if (!shop) return null;
  // Cross-tenant by necessity: "does any workspace already hold this shop?"
  // cannot be answered inside one tenant's scope. Same escape hatch the
  // app/uninstalled webhook uses to find the shop's owner.
  const rows = await withCrossTenantAccess(async () =>
    (prisma as any).tenantIntegration.findMany({
      where: { integration: { slug: "shopify" } },
      select: { id: true, tenantId: true, status: true, config: true },
    }),
  );
  const match = rows.find(
    (r: any) => normalizeShopifyShopDomain((r.config as any)?.shopDomain) === shop,
  );
  if (!match) return null;
  return { tenantId: match.tenantId, connectionId: match.id, status: match.status };
}

/**
 * Write the verified installation into a workspace.
 *
 * `tenantId` must come from a validated session or a server-side intent.
 * There is no code path in which it is read from a query string, a body, or
 * the Shopify request - the shop identifies the STORE, never the workspace.
 */
export async function linkShopifyShopToTenant(input: {
  tenantId: string;
  shopDomain: string;
  credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    scope?: string;
  };
  connectedBy?: string;
}): Promise<LinkResult> {
  const shop = normalizeShopifyShopDomain(input.shopDomain);
  if (!shop) return { ok: false, reason: "shop_invalid" };

  const cat = await findCatalog("shopify");
  if (!cat) return { ok: false, reason: "catalog_missing" };

  // Ownership check BEFORE the write. A store that belongs to another
  // workspace is not moved and not merged: the two workspaces may be two
  // different companies, and silently re-pointing a storefront's assistant is
  // not a decision this code gets to make. The merchant disconnects from the
  // owning workspace, or an operator resolves it explicitly.
  const owner = await findShopOwner(shop);
  if (owner && owner.tenantId !== input.tenantId) {
    return { ok: false, reason: "shop_taken", conflictingTenantId: owner.tenantId };
  }

  const row = await upsertConnection({
    tenantId: input.tenantId,
    catalogId: cat.id,
    status: "CONNECTED",
    credentialsBlob: encryptCredentials({
      accessToken: input.credentials.accessToken,
      refreshToken: input.credentials.refreshToken,
      expiresAt: input.credentials.expiresAt,
      scope: input.credentials.scope,
      shopDomain: shop,
    }),
    config: { shopDomain: shop },
    connectedBy: input.connectedBy,
  });

  // Proactive capability discovery: enumerate granted scopes NOW, so a store
  // connected with missing merchant approvals never exposes an unusable write
  // tool for even one turn before the first failure. Fire-and-forget - the
  // redirect must not wait on a Shopify roundtrip.
  void refreshCapabilityState({ tenantId: input.tenantId, slug: "shopify" })
    .then((r) => {
      if (r.missingScopes.length) {
        console.warn(`[shopify install] connected with missing scopes: ${r.missingScopes.join(",")}`);
      }
    })
    .catch((e: any) => console.warn("[shopify install] capability probe failed:", e?.message));

  // Reconcile existing AI employees' desired tool permissions: employees hired
  // BEFORE Shopify was connected were frozen with a partial tool set and never
  // re-granted this integration's tools. Additive/idempotent. Fire-and-forget.
  void reconcileAgentToolPermissions({ tenantId: input.tenantId, integrationSlug: "shopify" })
    .then((r) => {
      if (r.added.length) {
        console.log(`[shopify install] reconciled ${r.added.length} agent tool grant(s)`);
      }
    })
    .catch((e: any) => console.warn("[shopify install] tool-permission reconcile failed:", e?.message));

  return {
    ok: true,
    connectionId: row.id,
    reconnected: Boolean(owner && owner.tenantId === input.tenantId),
  };
}

/**
 * Exchange an authorization code for an access token.
 *
 * `expiring: "1"` requests Shopify's expiring offline token (access token +
 * refresh token). Non-expiring tokens are rejected by the Admin API now; the
 * adapter's refreshTokens() keeps the pair rotated.
 *
 * The response is returned, never logged: an access token in a log line is a
 * token in every downstream log sink.
 */
export async function exchangeShopifyCode(input: {
  shop: string;
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
} | null> {
  const res = await fetch(`https://${input.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      expiring: "1",
    }),
  });
  if (!res.ok) return null;
  const j: any = await res.json().catch(() => null);
  if (!j?.access_token) return null;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in
      ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString()
      : undefined,
    scope: j.scope,
  };
}
