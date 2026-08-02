/**
 * Shopify catalog service — the ONLY place Shopify product truth enters
 * the Live Chat feature.
 *
 * Everything here goes through `executeAdapterTool`, which already owns
 * connection lookup, credential decryption, token refresh, per-tenant rate
 * limiting and audit logging. We add the live-chat-specific layer on top:
 *
 *   - snapshotting products into the safe, chat-sized shape we persist
 *   - store binding checks (a product must belong to the channel's shop)
 *   - authoritative re-validation before any cart action
 *
 * Nothing in this file trusts a price, a stock level, a variant id or a
 * product id that came from a browser. Those are lookup keys; the answer
 * always comes back from Shopify.
 */

import {
  buildProductSnapshot,
  normalizeShopDomain,
  type ProductSnapshot,
} from "@chatcenter/shared";
import { executeAdapterTool, loadConnection } from "./connectors/integration-framework";

const SHOPIFY_SLUG = "shopify";

// ─── Store resolution ────────────────────────────────────────

export interface ShopifyStoreBinding {
  tenantIntegrationId: string;
  shopDomain: string;
  currency: string;
}

export type StoreResolution =
  | { ok: true; store: ShopifyStoreBinding }
  | { ok: false; reason: "not_connected" | "no_shop_domain" };

/**
 * Shop metadata changes about as often as the merchant renames their
 * store, so a short in-process cache keeps every product card from
 * spending a Shopify call on `get_shop`.
 */
interface ShopMetaCacheEntry {
  currency: string;
  expiresAt: number;
}
const SHOP_META_TTL_MS = 10 * 60 * 1000;
const shopMetaCache = new Map<string, ShopMetaCacheEntry>();

/** Test-only: drop cached shop metadata. */
export function __resetShopifyCatalogCache(): void {
  shopMetaCache.clear();
}

export async function resolveShopifyStore(tenantId: string): Promise<StoreResolution> {
  const conn = await loadConnection({ tenantId, slug: SHOPIFY_SLUG });
  if (!conn) return { ok: false, reason: "not_connected" };

  const shopDomain =
    normalizeShopDomain(conn.config?.shopDomain) ?? normalizeShopDomain(conn.credentials?.shopDomain);
  if (!shopDomain) return { ok: false, reason: "no_shop_domain" };

  return {
    ok: true,
    store: {
      tenantIntegrationId: conn.tenantIntegrationId,
      shopDomain,
      currency: await resolveCurrency(tenantId, shopDomain),
    },
  };
}

async function resolveCurrency(tenantId: string, shopDomain: string): Promise<string> {
  const key = `${tenantId}:${shopDomain}`;
  const cached = shopMetaCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.currency;

  let currency = "USD";
  const r = await executeAdapterTool({
    tenantId,
    toolFunctionName: "shopify.get_shop",
    args: {},
  });
  if (r.ok) {
    const raw = (r.result as any)?.currency;
    if (typeof raw === "string" && /^[A-Za-z]{3}$/.test(raw.trim())) {
      currency = raw.trim().toUpperCase();
    }
  }
  shopMetaCache.set(key, { currency, expiresAt: Date.now() + SHOP_META_TTL_MS });
  return currency;
}

// ─── Capability probe (diagnostics) ──────────────────────────

export type ProductCapability =
  | { ok: true }
  | { ok: false; code: "not_connected" | "no_shop_domain" | "missing_scope" | "unreachable"; detail: string };

/**
 * Can this tenant actually read products right now?
 *
 * Used by the channel diagnostics panel and by the widget bootstrap to
 * decide whether product messaging is offered. A store without
 * `read_products` must still get plain text chat — the feature degrades,
 * it does not fail.
 */
export async function probeProductCapability(tenantId: string): Promise<ProductCapability> {
  const store = await resolveShopifyStore(tenantId);
  if (!store.ok) {
    return {
      ok: false,
      code: store.reason,
      detail:
        store.reason === "not_connected"
          ? "No connected Shopify store for this workspace."
          : "The connected Shopify integration has no shop domain recorded.",
    };
  }
  const r = await executeAdapterTool({
    tenantId,
    toolFunctionName: "shopify.search_products",
    args: { query: "", limit: 1 },
  });
  if (r.ok) return { ok: true };

  const reason = String((r as { reason: string }).reason || "");
  if (/403|access.?denied|scope|not approved|requires merchant approval/i.test(reason)) {
    return {
      ok: false,
      code: "missing_scope",
      detail: "The Shopify app is missing the read_products scope. Reconnect Shopify to grant it.",
    };
  }
  return { ok: false, code: "unreachable", detail: "Shopify did not answer a product read." };
}

// ─── Search / fetch ──────────────────────────────────────────

export interface CatalogSearchOptions {
  tenantId: string;
  query: string;
  limit?: number;
  /** Include DRAFT / ARCHIVED products. Off unless the channel allows it. */
  includeUnpublished?: boolean;
  /** Pre-resolved binding — saves a round trip when the caller has one. */
  store?: ShopifyStoreBinding;
}

export type CatalogResult<T> =
  | { ok: true; store: ShopifyStoreBinding; data: T }
  | { ok: false; reason: string };

export async function searchCatalog(
  opts: CatalogSearchOptions,
): Promise<CatalogResult<ProductSnapshot[]>> {
  const store = opts.store ?? (await requireStore(opts.tenantId));
  if ("reason" in store) return store;

  const limit = Math.max(1, Math.min(20, opts.limit ?? 10));
  const r = await executeAdapterTool({
    tenantId: opts.tenantId,
    toolFunctionName: "shopify.search_products",
    args: {
      query: String(opts.query ?? "").slice(0, 120),
      limit,
      status: opts.includeUnpublished ? "any" : "active",
    },
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const raw = Array.isArray(r.result) ? r.result : [];
  const snapshots = raw
    .map((p: any) =>
      buildProductSnapshot({ shopDomain: store.shopDomain, currency: store.currency, product: p }),
    )
    .filter((s): s is ProductSnapshot => !!s)
    .filter((s) => (opts.includeUnpublished ? true : s.status === "active"))
    .slice(0, limit);

  return { ok: true, store, data: snapshots };
}

export interface GetProductOptions {
  tenantId: string;
  productId?: string | null;
  handle?: string | null;
  selectedVariantId?: string | null;
  reason?: string | null;
  store?: ShopifyStoreBinding;
}

export async function getProductSnapshot(
  opts: GetProductOptions,
): Promise<CatalogResult<ProductSnapshot | null>> {
  const store = opts.store ?? (await requireStore(opts.tenantId));
  if ("reason" in store) return store;

  const args: Record<string, unknown> = {};
  if (opts.productId) args.product_id = String(opts.productId);
  else if (opts.handle) args.handle = String(opts.handle);
  else return { ok: false, reason: "product_id_or_handle_required" };

  const r = await executeAdapterTool({
    tenantId: opts.tenantId,
    toolFunctionName: "shopify.get_product",
    args,
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const snapshot = buildProductSnapshot({
    shopDomain: store.shopDomain,
    currency: store.currency,
    product: r.result as Record<string, any>,
    selectedVariantId: opts.selectedVariantId ?? null,
    reason: opts.reason ?? null,
  });
  return { ok: true, store, data: snapshot };
}

/**
 * Fetch several products by id/handle, preserving the caller's order and
 * silently dropping anything that no longer resolves. A carousel with one
 * dead product should still render the rest.
 */
export async function getProductSnapshots(
  tenantId: string,
  refs: Array<{ productId?: string | null; handle?: string | null; variantId?: string | null; reason?: string | null }>,
  store?: ShopifyStoreBinding,
): Promise<CatalogResult<ProductSnapshot[]>> {
  const resolved = store ?? (await requireStore(tenantId));
  if ("reason" in resolved) return resolved;

  const out: ProductSnapshot[] = [];
  for (const ref of refs) {
    const r = await getProductSnapshot({
      tenantId,
      productId: ref.productId ?? null,
      handle: ref.handle ?? null,
      selectedVariantId: ref.variantId ?? null,
      reason: ref.reason ?? null,
      store: resolved,
    });
    if (r.ok && r.data) out.push(r.data);
  }
  return { ok: true, store: resolved, data: out };
}

// ─── Cart validation ─────────────────────────────────────────

export interface CartValidationRequest {
  tenantId: string;
  /** The shop the CHANNEL is bound to — not one the browser supplied. */
  expectedShopDomain: string;
  productId: string;
  variantId: string;
  quantity: number;
  allowUnpublished?: boolean;
}

export type CartValidation =
  | {
      ok: true;
      variantId: string;
      quantity: number;
      /** Authoritative, straight from Shopify — never echoed from input. */
      price: string | null;
      currency: string;
      title: string;
      variantTitle: string;
      productUrl: string;
    }
  | {
      ok: false;
      code:
        | "store_mismatch"
        | "product_not_found"
        | "variant_not_found"
        | "variant_unavailable"
        | "product_unpublished"
        | "invalid_quantity"
        | "selling_plan_required"
        | "unavailable";
      detail: string;
    };

const MAX_CART_QUANTITY = 10;

/**
 * The gate every Add to Cart passes through.
 *
 * Re-resolves the product from Shopify and checks, in order: the store
 * binding, that the product exists, that the variant belongs to THAT
 * product, that it is purchasable, and that the quantity is sane. Only
 * then does the storefront bridge get a variant id to add.
 */
export async function validateCartLine(req: CartValidationRequest): Promise<CartValidation> {
  const quantity = Number(req.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CART_QUANTITY) {
    return {
      ok: false,
      code: "invalid_quantity",
      detail: `Quantity must be a whole number between 1 and ${MAX_CART_QUANTITY}.`,
    };
  }

  const store = await requireStore(req.tenantId);
  if ("reason" in store) {
    return { ok: false, code: "unavailable", detail: "Store is not reachable right now." };
  }
  // The channel is bound to one shop. If the connected integration has
  // since moved to a different store, refuse rather than add a stranger's
  // variant to this storefront's cart.
  if (store.shopDomain !== req.expectedShopDomain) {
    return {
      ok: false,
      code: "store_mismatch",
      detail: "This product belongs to a different store.",
    };
  }

  const snap = await getProductSnapshot({
    tenantId: req.tenantId,
    productId: req.productId,
    selectedVariantId: req.variantId,
    store,
  });
  if (!snap.ok || !snap.data) {
    return { ok: false, code: "product_not_found", detail: "This product is no longer available." };
  }
  const product = snap.data;

  if (product.status !== "active" && !req.allowUnpublished) {
    return {
      ok: false,
      code: "product_unpublished",
      detail: "This product is not published on the storefront.",
    };
  }

  // Variant must belong to THIS product. Checking membership (rather than
  // fetching the variant on its own) is what stops a valid-looking variant
  // id from another product being smuggled in.
  const variant = product.variants.find((v) => v.variantId === String(req.variantId));
  if (!variant) {
    return {
      ok: false,
      code: "variant_not_found",
      detail: "That option no longer exists for this product.",
    };
  }
  if (variant.requiresSellingPlan) {
    return {
      ok: false,
      code: "selling_plan_required",
      detail: "This product must be bought as a subscription on the product page.",
    };
  }
  if (!variant.available) {
    return {
      ok: false,
      code: "variant_unavailable",
      detail: "That option is out of stock.",
    };
  }

  return {
    ok: true,
    variantId: variant.variantId,
    quantity,
    price: variant.price,
    currency: product.currency,
    title: product.title,
    variantTitle: variant.title,
    productUrl: product.productUrl,
  };
}

// ─── Internal ────────────────────────────────────────────────

async function requireStore(
  tenantId: string,
): Promise<ShopifyStoreBinding | { ok: false; reason: string }> {
  const store = await resolveShopifyStore(tenantId);
  if (!store.ok) return { ok: false, reason: store.reason };
  return store.store;
}
