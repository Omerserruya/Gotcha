import { describe, it, expect } from "vitest";
import { mapShop } from "../services/connectors/shopify-gql-shop";

/**
 * The contract, not the protocol.
 *
 * `get_shop`'s output is read by the commerce context panel and by prompt
 * building, so what matters is that the six keys keep their REST-era names,
 * types and null behaviour after moving to GraphQL. These assert the mapper's
 * OUTPUT rather than a captured Shopify response, because a fixture would still
 * pass if the mapping quietly renamed a field.
 */
describe("shop mapping keeps the REST-era shape", () => {
  const node = {
    name: "Demo Store",
    myshopifyDomain: "demo.myshopify.com",
    ianaTimezone: "Asia/Jerusalem",
    currencyCode: "ILS",
    primaryDomain: { host: "shop.example.com" },
    shopAddress: { countryCodeV2: "IL" },
  };

  it("maps every field a caller reads", () => {
    expect(mapShop(node, "fallback.myshopify.com")).toEqual({
      name: "Demo Store",
      currency: "ILS",
      myshopify_domain: "demo.myshopify.com",
      primary_domain: "shop.example.com",
      iana_timezone: "Asia/Jerusalem",
      country_code: "IL",
    });
  });

  // REST returned an ISO code here and callers compare it to "ILS"/"USD".
  it("returns the currency CODE, not a formatted money string", () => {
    expect(mapShop(node, "x").currency).toBe("ILS");
  });

  // The old code did `s.myshopify_domain ?? shop` - returning null for a shop
  // we are authenticated against would be worse than echoing what we connected to.
  it("falls back to the connected domain when Shopify omits it", () => {
    expect(mapShop({ ...node, myshopifyDomain: null }, "fallback.myshopify.com").myshopify_domain)
      .toBe("fallback.myshopify.com");
  });

  it("nulls missing optional fields rather than throwing or inventing them", () => {
    expect(mapShop({ name: "Bare" }, "fallback.myshopify.com")).toEqual({
      name: "Bare",
      currency: null,
      myshopify_domain: "fallback.myshopify.com",
      primary_domain: null,
      iana_timezone: null,
      country_code: null,
    });
  });

  it("survives a null shop entirely", () => {
    expect(mapShop(null, "fallback.myshopify.com").name).toBeNull();
    expect(mapShop(undefined, "fallback.myshopify.com").myshopify_domain).toBe("fallback.myshopify.com");
  });

  // primaryDomain.url would carry "https://" - a scheme no previous caller saw.
  it("uses the bare host for primary_domain", () => {
    expect(mapShop({ primaryDomain: { host: "shop.example.com", url: "https://shop.example.com" } }, "x").primary_domain)
      .toBe("shop.example.com");
  });
});
