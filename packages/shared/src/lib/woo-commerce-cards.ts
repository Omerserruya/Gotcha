/**
 * WooCommerce product cards on the website widget (W9 phase b, 2026-10-14).
 *
 * The cards are built server-side from the store's own answer (the model only
 * ever names an id), stored on the message as `metadata.commerce`, and given
 * to the visitor in the SAME shape the widget already draws Shopify cards
 * from, so one renderer serves both.
 *
 * A card is bound to the store and the widget it was made for; the projection
 * refuses a payload from another store or another widget (a store swapped on
 * the workspace must not keep showing the old store's products).
 */

export const WOO_MESSAGE_TYPES = {
  PRODUCT: "woo_product",
  PRODUCT_CAROUSEL: "woo_product_carousel",
} as const;

export const MAX_WOO_VARIANTS = 30;

export interface WooCardVariant {
  /** The variation id; for a simple product, the product's own id. */
  variantId: string;
  title: string;
  price: string | null;
  compareAtPrice: string | null;
  available: boolean;
  options: string[];
  requiresSellingPlan: false;
}

export interface WooProductCard {
  productId: string;
  /** The product's slug. */
  handle: string;
  title: string;
  imageUrl: string | null;
  productUrl: string;
  currency: string | null;
  price: string | null;
  compareAtPrice: string | null;
  available: boolean;
  published: true;
  selectedVariantId: string | null;
  optionNames: string[];
  reason: string | null;
  variants: WooCardVariant[];
}

export interface WooCommercePayload {
  kind: "woo_commerce";
  storeUrl: string;
  channelAccountId: string;
  products: WooProductCard[];
  addToCartEnabled: boolean;
  source: "ai" | "agent";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const purchasable = (p: any) => p?.purchasable !== false && p?.stock_status !== "outofstock";

/**
 * One card from a Woo product (REST v3) and, for a variable product, its
 * variations. Null when the store would not sell it on its own page:
 * not published, hidden, or a type the widget cannot put in a cart
 * (grouped, external).
 */
export function buildWooProductCard(
  raw: any,
  variations: any[] | null,
  opts: { storeUrl: string; currency: string | null; reason?: string | null },
): WooProductCard | null {
  if (!raw || raw.status !== "publish" || raw.catalog_visibility === "hidden") return null;
  const type = String(raw.type ?? "simple");
  if (type !== "simple" && type !== "variable") return null;
  const productId = str(raw.id);
  if (!productId) return null;
  const base = opts.storeUrl.replace(/\/+$/, "");
  const link = httpsUrl(raw.permalink);
  const productUrl = link && hostOf(link) === hostOf(base) ? link : `${base}/?p=${encodeURIComponent(productId)}`;
  const onSale = !!str(raw.sale_price) && str(raw.regular_price) !== str(raw.sale_price);

  let variants: WooCardVariant[];
  let optionNames: string[] = [];
  if (type === "variable") {
    optionNames = (Array.isArray(raw.attributes) ? raw.attributes : [])
      .filter((a: any) => a?.variation && typeof a?.name === "string")
      .map((a: any) => a.name);
    variants = (Array.isArray(variations) ? variations : [])
      .filter((v) => v && (v.status === undefined || v.status === "publish"))
      .slice(0, MAX_WOO_VARIANTS)
      .map((v) => {
        const options = (Array.isArray(v.attributes) ? v.attributes : []).map((a: any) => String(a?.option ?? "")).filter(Boolean);
        const vSale = !!str(v.sale_price) && str(v.regular_price) !== str(v.sale_price);
        return {
          variantId: String(v.id),
          title: options.join(" / ") || String(raw.name ?? ""),
          price: str(v.price),
          compareAtPrice: vSale ? str(v.regular_price) : null,
          available: purchasable(v),
          options,
          requiresSellingPlan: false as const,
        };
      });
  } else {
    variants = [{
      variantId: productId,
      title: String(raw.name ?? ""),
      price: str(raw.price),
      compareAtPrice: onSale ? str(raw.regular_price) : null,
      available: purchasable(raw),
      options: [],
      requiresSellingPlan: false,
    }];
  }
  const available = type === "variable" ? variants.some((v) => v.available) : purchasable(raw);
  return {
    productId,
    handle: String(raw.slug ?? ""),
    title: String(raw.name ?? ""),
    imageUrl: Array.isArray(raw.images) ? httpsUrl(raw.images[0]?.src) : null,
    productUrl,
    currency: opts.currency,
    price: str(raw.price),
    compareAtPrice: onSale ? str(raw.regular_price) : null,
    available,
    published: true,
    selectedVariantId: type === "simple" ? productId : null,
    optionNames,
    reason: opts.reason ? String(opts.reason).slice(0, 200) : null,
    variants,
  };
}

/** The visitor's view of a Woo card payload, or null when it is not this store's and this widget's. */
export function projectWooCommerce(
  meta: unknown,
  ctx: { storeUrl: string | null; channelAccountId: string },
): { addToCartEnabled: boolean; products: Array<Record<string, unknown>> } | null {
  const p = (meta as any)?.commerce as WooCommercePayload | undefined;
  if (!p || p.kind !== "woo_commerce" || !ctx.storeUrl) return null;
  if (hostOf(p.storeUrl) !== hostOf(ctx.storeUrl) || p.channelAccountId !== ctx.channelAccountId) return null;
  if (!Array.isArray(p.products) || !p.products.length) return null;
  return {
    addToCartEnabled: p.addToCartEnabled === true,
    products: p.products.map((c) => ({
      productId: c.productId, handle: c.handle, title: c.title, imageUrl: c.imageUrl, productUrl: c.productUrl,
      currency: c.currency, price: c.price, compareAtPrice: c.compareAtPrice, available: c.available, published: true,
      selectedVariantId: c.selectedVariantId, optionNames: c.optionNames, reason: c.reason,
      variants: (c.variants ?? []).map((v) => ({
        variantId: v.variantId, title: v.title, price: v.price, compareAtPrice: v.compareAtPrice,
        available: v.available, options: v.options, requiresSellingPlan: false,
      })),
    })),
  };
}

/** The plain-text line a card message carries (inbox, notifications, channels without cards). */
export function summarizeWooCards(cards: WooProductCard[]): string {
  return cards.map((c) => [c.title, c.price ? `${c.price}${c.currency ? ` ${c.currency}` : ""}` : null].filter(Boolean).join(" - ")).join("\n");
}
