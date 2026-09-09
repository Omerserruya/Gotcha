/**
 * Shop information, on Admin GraphQL.
 *
 * The first family migrated off REST, and deliberately the smallest: one call,
 * one caller, a flat return shape. It exists to prove the foundation end to end
 * before anything with money or customer data moves.
 *
 * The mapper is separate from the query on purpose. What the adapter returns is
 * a contract with the rest of GOTCHA - `currency`, `country_code`,
 * `myshopify_domain` are read by the commerce context panel and by prompt
 * building - so the shape is asserted against the mapper in tests, not against
 * a fixture of Shopify's response.
 */
import { shopifyGraphQLRequest, type ShopifyCtx } from "./shopify-graphql";

/**
 * `billingAddress` and `plan.displayName` are deprecated in 2026-07 (verified
 * against the schema, not remembered): `shopAddress` and `publicDisplayName`
 * replace them. Only the fields the existing return shape needs are selected.
 */
const SHOP_QUERY = /* GraphQL */ `
  query GotchaShopInfo {
    shop {
      name
      myshopifyDomain
      ianaTimezone
      currencyCode
      primaryDomain {
        host
      }
      shopAddress {
        countryCodeV2
      }
    }
  }
`;

/** Exactly what `get_shop` returned on REST. Unchanged by this migration. */
export interface ShopInfo {
  name: string | null;
  currency: string | null;
  myshopify_domain: string;
  primary_domain: string | null;
  iana_timezone: string | null;
  country_code: string | null;
}

/**
 * Map a GraphQL shop node onto the REST-era shape.
 *
 * `fallbackDomain` mirrors the old `s.myshopify_domain ?? shop` - the adapter
 * already knows the domain it connected to, and returning null there would be
 * worse than returning the value we authenticated with.
 */
export function mapShop(node: any, fallbackDomain: string): ShopInfo {
  const s = node ?? {};
  return {
    name: s.name ?? null,
    // REST sent an ISO code in `currency` (with `money_format` as a fallback);
    // `currencyCode` is the same code, so callers comparing "ILS"/"USD" are
    // unaffected.
    currency: s.currencyCode ?? null,
    myshopify_domain: s.myshopifyDomain ?? fallbackDomain,
    // REST's `domain` is the storefront's primary host, which is what
    // `primaryDomain.host` is. `primaryDomain.url` would add a scheme the old
    // callers never saw.
    primary_domain: s.primaryDomain?.host ?? null,
    iana_timezone: s.ianaTimezone ?? null,
    country_code: s.shopAddress?.countryCodeV2 ?? null,
  };
}

export async function getShop(ctx: ShopifyCtx, fallbackDomain: string): Promise<ShopInfo> {
  const data = await shopifyGraphQLRequest(ctx, SHOP_QUERY, {}, { retryable: true });
  return mapShop(data?.shop, fallbackDomain);
}

/**
 * The shop's own immutable id, and whether Shopify calls it a development
 * store.
 *
 * SEPARATE from `getShop` on purpose. That function's return shape is a
 * contract with the commerce panel and prompt building, asserted field by field
 * in tests; widening it for two values only billing cares about would make
 * every one of those callers carry fields they never read.
 *
 * `id` comes back as a GID (`gid://shopify/Shop/12345678`). The numeric tail is
 * what gets stored, because that is the form Shopify's webhooks and Partner API
 * use, and storing two spellings of one identifier is how they drift.
 *
 * `plan.partnerDevelopment` is what distinguishes a development store from a
 * real one. It is the ONLY reliable signal: a dev store's `.myshopify.com`
 * domain looks exactly like a paying merchant's.
 */
const SHOP_IDENTITY_QUERY = /* GraphQL */ `
  query GotchaShopIdentity {
    shop {
      id
      myshopifyDomain
      plan {
        partnerDevelopment
        shopifyPlus
      }
    }
  }
`;

export interface ShopIdentity {
  /** Numeric id as a string, e.g. "12345678". Never the domain. */
  shopId: string | null;
  myshopifyDomain: string | null;
  isDevelopmentStore: boolean;
}

/** Extract the numeric tail of a Shopify GID, or null if it is not one. */
export function numericIdFromGid(gid: unknown): string | null {
  if (typeof gid !== "string") return null;
  const m = gid.match(/\/(\d+)$/);
  return m ? m[1] : null;
}

export async function getShopIdentity(ctx: ShopifyCtx): Promise<ShopIdentity> {
  const data = await shopifyGraphQLRequest(ctx, SHOP_IDENTITY_QUERY, {}, { retryable: true });
  const shop = data?.shop ?? {};
  return {
    shopId: numericIdFromGid(shop.id),
    myshopifyDomain: shop.myshopifyDomain ?? null,
    // Absent means "not a dev store". Defaulting the other way would refuse
    // automatic grandfathering to real merchants whenever this field failed to
    // come back, which is the more damaging error.
    isDevelopmentStore: shop.plan?.partnerDevelopment === true,
  };
}
