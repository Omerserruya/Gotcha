/**
 * What survives when the tool surface has to be cut.
 *
 * OpenAI hard-rejects a tools array longer than 128, so a merchant with many
 * enabled integrations always loses some. The cut used to run alphabetically
 * from the end, which is uncorrelated with usefulness. On the Urban Supply
 * store it removed exactly three tools:
 *
 *     shopify.update_order_fulfillment, shopify.validate_discount,
 *     shopify.variant_information
 *
 * so "do you have it in a 159?" and "is this coupon still valid?" had no tool
 * behind them, while `list_segments` - documented as not even supported over
 * REST - survived on the strength of its first letter. The model answered the
 * size question with a generic catalogue dump, which is what a shopper saw.
 *
 * These lock the ranking, not the specific 128 tools a tenant happens to have.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (l?: string) => l || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  assertPublicUrl: vi.fn(async () => {}),
  prisma: {},
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
}));

import ShopifyAdapter from "../services/connectors/shopify.adapter";
import { getToolPriority, registerAdapter } from "../services/connectors/integration-framework";

registerAdapter(ShopifyAdapter as any);

/** The production truncation rule, in isolation. */
function survivors(names: string[], room: number): string[] {
  return [...names]
    .sort((a, b) => {
      const pa = getToolPriority(a), pb = getToolPriority(b);
      if (pa !== pb) return pb - pa;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, room);
}

const ALL = ShopifyAdapter.tools().map((t: any) => t.name);

describe("tool priority", () => {
  it("defaults to 50 for anything the provider has not ranked", () => {
    expect(getToolPriority("shopify.get_customer_addresses")).toBe(50);
    expect(getToolPriority("shopify.not_a_real_tool")).toBe(50);
    expect(getToolPriority("no_dot_at_all")).toBe(50);
  });

  it("ranks the two commonest pre-purchase questions above the default", () => {
    expect(getToolPriority("shopify.variant_information")).toBeGreaterThan(50);
    expect(getToolPriority("shopify.inventory_status")).toBeGreaterThan(50);
  });

  it("ranks internal-only and REST-unsupported tools below the default", () => {
    expect(getToolPriority("shopify.get_product_images")).toBeLessThan(50);
    expect(getToolPriority("shopify.list_segments")).toBeLessThan(50);
  });
});

describe("truncation keeps what a shopper actually needs", () => {
  it("keeps variant_information and validate_discount when three must go", () => {
    // The exact shape of the live incident: room for all but three.
    const kept = survivors(ALL, ALL.length - 3);
    expect(kept).toContain("shopify.variant_information");
    expect(kept).toContain("shopify.validate_discount");
  });

  it("sheds the internal and unsupported tools first", () => {
    const kept = survivors(ALL, ALL.length - 3);
    expect(kept).not.toContain("shopify.get_product_images");
    expect(kept).not.toContain("shopify.list_segments");
  });

  it("is deterministic - equal priority falls back to name order", () => {
    expect(survivors(ALL, 20)).toEqual(survivors(ALL, 20));
  });

  it("keeps every ranked tool when there is room for all of them", () => {
    expect(survivors(ALL, ALL.length).sort()).toEqual([...ALL].sort());
  });
});
