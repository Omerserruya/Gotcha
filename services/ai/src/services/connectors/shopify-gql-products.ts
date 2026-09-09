/**
 * Products and variants, on Admin GraphQL.
 *
 * Family 2 of the REST migration, and the first one with a shape worth
 * defending: `get_product` used to hand back Shopify's raw REST product, and
 * every product-shaped thing downstream - the catalogue facets, the discovery
 * profile, the exchange quote, the live-chat product card - learned to read
 * that shape. So the mappers here are the contract, and the queries are an
 * implementation detail behind them.
 *
 * ── Two field sets, because of ONE scope ──
 *
 * REST answered `inventory_management` under `read_products`. Its GraphQL
 * equivalent is `inventoryItem.tracked`, which pulls in `read_inventory`, and
 * GraphQL enforces scopes over the whole document: a single field the store did
 * not grant fails the ENTIRE query rather than omitting a key. A store that
 * granted `read_products` alone would have gone from "a product with no stock
 * fields" to "get_product is broken".
 *
 * So the inventory field appears only in the queries used by the tools that
 * already declare `read_inventory` (inventory_status, variant_information,
 * exchange_order_item), and never in the plain product read.
 *
 * ── A deprecation left in place deliberately ──
 *
 * `Product.featuredImage` and `Product.images` are deprecated in favour of
 * `featuredMedia` / `media`. Verified against 2026-07: the media fields require
 * read_files, read_images and read_themes, none of which this app requests.
 * Switching would trade a deprecation warning for no product images at all
 * until every merchant re-consents, so the deprecated fields stay and the gap
 * is reported instead.
 */
import { shopifyGraphQLRequest, paginate, toGid, escapeSearchValue, type ShopifyCtx } from "./shopify-graphql";

/** Variant fields available under `read_products` alone. */
const VARIANT_FIELDS = `
  legacyResourceId
  title
  sku
  price
  compareAtPrice
  availableForSale
  inventoryQuantity
  inventoryPolicy
  selectedOptions { name value }`;

/** Adds the one field that costs a `read_inventory` grant. */
const VARIANT_FIELDS_WITH_INVENTORY = `
  ${VARIANT_FIELDS}
  inventoryItem { tracked }`;

const productFields = (variantFields: string) => `
  legacyResourceId
  title
  handle
  status
  vendor
  productType
  tags
  featuredImage { url }
  images(first: 5) { nodes { url } }
  options { name }
  variants(first: 50) { nodes { ${variantFields} } }`;

export const PRODUCT_BY_ID = `
  query GotchaProductById($id: ID!) {
    product(id: $id) { ${productFields(VARIANT_FIELDS)} }
  }`;

export const PRODUCT_BY_ID_WITH_INVENTORY = `
  query GotchaProductByIdWithInventory($id: ID!) {
    product(id: $id) { ${productFields(VARIANT_FIELDS_WITH_INVENTORY)} }
  }`;

export const PRODUCT_BY_HANDLE = `
  query GotchaProductByHandle($identifier: ProductIdentifierInput!) {
    productByIdentifier(identifier: $identifier) { ${productFields(VARIANT_FIELDS)} }
  }`;

export const VARIANT_BY_ID = `
  query GotchaVariantById($id: ID!) {
    productVariant(id: $id) {
      ${VARIANT_FIELDS_WITH_INVENTORY}
      product { legacyResourceId title }
    }
  }`;

/**
 * Featured image for many products at once.
 *
 * Deliberately not the full product fragment: this feeds an order panel that
 * wants a thumbnail per line item, and asking for fifty variants apiece to
 * render fifty thumbnails is how a query cost limit gets hit.
 */
export const PRODUCT_IMAGES = `
  query GotchaProductImages($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        legacyResourceId
        featuredImage { url }
        images(first: 1) { nodes { url } }
      }
    }
  }`;

/** Title-only search, for picking WHICH product before reading it in full. */
export const PRODUCT_TITLE_SEARCH = `
  query GotchaProductTitleSearch($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      nodes { legacyResourceId title }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** The REST variant shape, as `/variants/{id}.json` returned it. */
export interface RestVariant {
  id: number | null;
  product_id: number | null;
  title: string | null;
  sku: string | null;
  price: string | null;
  compare_at_price: string | null;
  available: boolean;
  inventory_quantity: number | null;
  inventory_policy: string | null;
  /**
   * REST said `"shopify"` or `null`, and callers test it for null to decide
   * whether stock is tracked at all - `inventory_management == null || qty > 0`.
   * `tracked` is the same fact as a boolean, so it is translated back rather
   * than exposed, and an untracked variant keeps reading as null.
   */
  inventory_management: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

export function mapVariant(v: any, productId?: number | null): RestVariant {
  const opts: string[] = (v?.selectedOptions || []).map((o: any) => o?.value).filter(Boolean);
  return {
    id: numeric(v?.legacyResourceId),
    product_id: productId ?? numeric(v?.product?.legacyResourceId),
    title: v?.title ?? null,
    sku: v?.sku ?? null,
    price: v?.price ?? null,
    compare_at_price: v?.compareAtPrice ?? null,
    available: v?.availableForSale === true,
    inventory_quantity: v?.inventoryQuantity ?? null,
    inventory_policy: String(v?.inventoryPolicy ?? "").toLowerCase() || null,
    // Absent field (a query that did not ask, i.e. no read_inventory) is NOT
    // the same as "not tracked", but REST could not tell those apart either and
    // callers already treat null as untracked.
    inventory_management: v?.inventoryItem?.tracked === true ? "shopify" : null,
    option1: opts[0] ?? null,
    option2: opts[1] ?? null,
    option3: opts[2] ?? null,
  };
}

/** The REST product shape the whole tool surface already speaks. */
export interface RestProduct {
  id: number | null;
  title: string | null;
  handle: string | null;
  status: string;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  image: { src: string } | null;
  images: Array<{ src: string }>;
  options: Array<{ name: string }>;
  variants: RestVariant[];
}

export function mapProduct(p: any): RestProduct {
  const id = numeric(p?.legacyResourceId);
  const images = (p?.images?.nodes || []).map((i: any) => ({ src: i?.url })).filter((i: any) => i.src);
  return {
    id,
    title: p?.title ?? null,
    handle: p?.handle ?? null,
    // REST reported a lowercase status; GraphQL's enum is uppercase.
    status: String(p?.status ?? "ACTIVE").toLowerCase(),
    vendor: p?.vendor ?? null,
    product_type: p?.productType ?? null,
    tags: Array.isArray(p?.tags) ? p.tags : splitTags(p?.tags),
    image: p?.featuredImage?.url ? { src: p.featuredImage.url } : images[0] ?? null,
    images,
    options: (p?.options || []).map((o: any) => ({ name: o?.name })).filter((o: any) => o.name),
    variants: (p?.variants?.nodes || []).map((v: any) => mapVariant(v, id)),
  };
}

function numeric(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function splitTags(tags: unknown): string[] {
  return String(tags || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export async function getProductById(ctx: ShopifyCtx, id: string | number, withInventory = false): Promise<RestProduct | null> {
  const data = await shopifyGraphQLRequest(
    ctx,
    withInventory ? PRODUCT_BY_ID_WITH_INVENTORY : PRODUCT_BY_ID,
    { id: toGid("Product", id) },
    { retryable: true },
  );
  return data?.product ? mapProduct(data.product) : null;
}

export async function getProductByHandle(ctx: ShopifyCtx, handle: string): Promise<RestProduct | null> {
  const data = await shopifyGraphQLRequest(ctx, PRODUCT_BY_HANDLE, { identifier: { handle } }, { retryable: true });
  return data?.productByIdentifier ? mapProduct(data.productByIdentifier) : null;
}

export async function getVariantById(ctx: ShopifyCtx, id: string | number): Promise<RestVariant | null> {
  const data = await shopifyGraphQLRequest(ctx, VARIANT_BY_ID, { id: toGid("ProductVariant", id) }, { retryable: true });
  return data?.productVariant ? mapVariant(data.productVariant) : null;
}

/**
 * Featured image URL per product id, for the ids that have one.
 *
 * Same contract as the REST batch read it replaces: ids that do not resolve are
 * simply absent from the map rather than present with a null.
 */
export async function getProductImages(ctx: ShopifyCtx, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const data = await shopifyGraphQLRequest(
    ctx,
    PRODUCT_IMAGES,
    { ids: ids.slice(0, 50).map((id) => toGid("Product", id)) },
    { retryable: true },
  );
  const map: Record<string, string> = {};
  for (const p of data?.nodes || []) {
    const id = numeric(p?.legacyResourceId);
    const src = p?.featuredImage?.url || p?.images?.nodes?.[0]?.url || null;
    if (id != null && src) map[String(id)] = src;
  }
  return map;
}

/**
 * Find ONE product by title.
 *
 * REST could not search, so this used to read 250 products and match locally -
 * which meant a store with a larger catalogue could not answer a question about
 * its own 251st product. Shopify's `products(query:)` does a real full-text
 * search, so the read is now narrow, and the SAME ranking is applied to what
 * comes back: exact title, then prefix/containment, then the reverse. The
 * ranking is what stops a catalogue of near-identical names ("...: Liquid" vs
 * "...: Oxygen") resolving to whichever one Shopify happened to return first.
 *
 * Two steps on purpose: search on titles alone, then read the winner in full.
 * One combined query would ask for fifty variants apiece just to read a title.
 */
export async function findProductByTitle(
  ctx: ShopifyCtx,
  name: string,
  withInventory = false,
): Promise<RestProduct | null> {
  const needle = String(name ?? "").trim().toLowerCase();
  if (!needle) return null;

  const search = (query: string) =>
    paginate<{ legacyResourceId: string; title: string }>(ctx, PRODUCT_TITLE_SEARCH, { query }, "products", 50);

  const byTitle = (p: { title?: string }) => String(p?.title ?? "").trim().toLowerCase();
  const rank = (rows: Array<{ title: string }>) =>
    rows.find((p) => byTitle(p) === needle) ??
    rows.find((p) => byTitle(p).includes(needle)) ??
    rows.find((p) => needle.includes(byTitle(p))) ??
    null;

  // `title:` rather than a bare term, so a search for "Liquid" does not land on
  // a vendor of that name. Escaped, so a quote in what the customer typed
  // cannot close the term and have the rest read as query syntax.
  let hit = rank(await search(`title:${escapeSearchValue(needle)}`)) as { legacyResourceId: string } | null;

  // The phrase found nothing, which on REST did not mean the product is absent:
  // that path read the catalogue and also matched a title CONTAINED IN what the
  // customer said ("the collection snowboard liquid, the long one"). A phrase
  // search can never match that, so the words are tried separately before
  // giving up.
  if (!hit) {
    const words = needle.split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
    if (words.length) hit = rank(await search(words.map((w) => `title:${escapeSearchValue(w)}`).join(" OR "))) as any;
  }
  if (!hit) return null;

  return await getProductById(ctx, hit.legacyResourceId, withInventory);
}
