/**
 * The web chat's "suggest complementary products" from the WooCommerce store
 * (2026-10-24). Pinned:
 *   - the setting is off by default and needs product cards on;
 *   - the tool has no CatalogTool row, so the gate has its own branch: allowed
 *     with no approval, never routed to the catalog lookup, and denied for an
 *     employee kept off WooCommerce;
 *   - the add-ons are the store's own cross-sells and upsells first, in the
 *     merchant's order, then in-stock products from the same category; never
 *     the anchor itself, nothing hidden, out of stock or unpublished;
 *   - the result is grounded like a search (cards), Shopify's cross-sell is
 *     hidden on a Woo turn, and a Woo catalogue read counts as "shown".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => ({
  access: ["woocommerce"] as string[],
  products: {} as Record<string, any>,
  reads: [] as Array<{ tool: string; args: any }>,
}));

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    tenantTool: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    tenantToolPermission: { findUnique: vi.fn(async () => null) },
    agentToolPermission: { findFirst: vi.fn(async () => null) },
    aIAgent: { findFirst: vi.fn(async () => ({ integrationAccess: H.access })) },
  },
}));
vi.mock("../services/connectors/integration-framework", () => ({
  loadConnection: vi.fn(),
  executeAdapterTool: async ({ toolFunctionName, args }: any) => {
    H.reads.push({ tool: toolFunctionName, args });
    if (toolFunctionName === "woocommerce.get_product") {
      const p = H.products[String(args.product_id)];
      return p ? { ok: true, result: p } : { ok: false, reason: "woocommerce_404" };
    }
    if (toolFunctionName === "woocommerce.list_products") {
      let list = Object.values(H.products);
      if (args.include) list = list.filter((p: any) => args.include.includes(String(p.id)));
      if (args.category) list = list.filter((p: any) => p.categories.some((c: any) => String(c.id) === String(args.category)));
      if (args.exclude) list = list.filter((p: any) => !args.exclude.includes(String(p.id)));
      if (args.in_stock) list = list.filter((p: any) => p.stock_status === "instock");
      return { ok: true, result: list.slice(0, args.per_page ?? 10) };
    }
    return { ok: false, reason: "unknown" };
  },
}));
vi.mock("../services/website-widget.service", () => ({ connectedWooStore: vi.fn() }));
vi.mock("../services/widget-promotions.service", () => ({ listActivePromotions: vi.fn() }));
vi.mock("../services/discovery-integration.service", () => ({ resolveWooCurrency: vi.fn() }));

import { evaluatePolicies, normalizeWebchatCommerce, WOO_COMPLEMENTARY_TOOL_NAME, prisma } from "@chatcenter/shared";
import { wooComplementaryProducts, WOO_COMPLEMENTARY_TOOL, WOO_TURN_HIDDEN_TOOLS } from "../services/woo-chat-turn.service";

const product = (id: number, o: any = {}) => ({
  id, name: `P${id}`, status: "publish", catalog_visibility: "visible", stock_status: "instock", purchasable: true,
  categories: [{ id: 7 }], cross_sell_ids: [], upsell_ids: [], ...o,
});

beforeEach(() => { H.access = ["woocommerce"]; H.reads = []; H.products = {}; });

describe("the setting", () => {
  it("off by default; on only with product cards on", () => {
    expect(normalizeWebchatCommerce({}).suggestComplementary).toBe(false);
    expect(normalizeWebchatCommerce({ productMessagingEnabled: true, suggestComplementary: true }).suggestComplementary).toBe(true);
    expect(normalizeWebchatCommerce({ productMessagingEnabled: false, suggestComplementary: true }).suggestComplementary).toBe(false);
    expect(normalizeWebchatCommerce({ productMessagingEnabled: true, suggestComplementary: "yes" }).suggestComplementary).toBe(false);
  });
});

describe("★ the gate (no CatalogTool row by design)", () => {
  it("allowed with no approval, never routed to the catalog lookup", async () => {
    const r = await evaluatePolicies({ tenantId: "T", toolName: WOO_COMPLEMENTARY_TOOL_NAME, aiAgentId: "emp1" });
    expect(r.decision).toBe("ALLOW");
    expect((prisma as any).tenantTool.findFirst).not.toHaveBeenCalled();
  });

  it("denied for an employee kept off WooCommerce", async () => {
    H.access = ["hubspot"];
    const r = await evaluatePolicies({ tenantId: "T", toolName: WOO_COMPLEMENTARY_TOOL_NAME, aiAgentId: "emp1" });
    expect(r.decision).toBe("DENY");
  });

  it("the tool name is the gate's constant", () => {
    expect(WOO_COMPLEMENTARY_TOOL.function.name).toBe(WOO_COMPLEMENTARY_TOOL_NAME);
    expect(WOO_COMPLEMENTARY_TOOL_NAME).toBe("woocommerce.complementary_products");
  });
});

describe("★ what goes with the chosen product", () => {
  it("cross-sells then upsells, in the merchant's order, then the same category to fill", async () => {
    H.products = {
      1: product(1, { cross_sell_ids: [5, 3], upsell_ids: [4] }),
      3: product(3), 4: product(4), 5: product(5),
      6: product(6), 9: product(9, { categories: [{ id: 8 }] }),
    };
    const r = await wooComplementaryProducts("T", "1");
    expect(r.ok && r.result.map((p: any) => p.id)).toEqual([5, 3, 4, 6]);
    expect(r.ok && r.sources).toEqual({ linked: 3, sameCategory: 1 });
    const fill = H.reads.find((x) => x.tool === "woocommerce.list_products" && x.args.category);
    expect(fill!.args).toMatchObject({ category: "7", exclude: ["1", "5", "3", "4"], in_stock: true });
  });

  it("never the anchor, nothing hidden, out of stock or unpublished", async () => {
    H.products = {
      1: product(1, { cross_sell_ids: [1, 2, 3, 4] }),
      2: product(2, { stock_status: "outofstock" }),
      3: product(3, { catalog_visibility: "hidden" }),
      4: product(4, { status: "draft" }),
      5: product(5, { stock_status: "outofstock" }),
    };
    const r = await wooComplementaryProducts("T", "1");
    expect(r.ok && r.result).toEqual([]);
  });

  it("no links: the same category, without the anchor; no category, no add-ons", async () => {
    H.products = { 1: product(1), 2: product(2), 3: product(3, { categories: [] }) };
    expect((await wooComplementaryProducts("T", "1") as any).result.map((p: any) => p.id)).toEqual([2]);
    expect((await wooComplementaryProducts("T", "3") as any).result).toEqual([]);
  });

  it("a non-numeric id or a product not in the store is refused, without a list read", async () => {
    expect((await wooComplementaryProducts("T", "abc")).ok).toBe(false);
    expect((await wooComplementaryProducts("T", "404")).ok).toBe(false);
    expect(H.reads.some((x) => x.tool === "woocommerce.list_products")).toBe(false);
  });
});

describe("the surface around it", () => {
  it("Shopify's catalogue, cross-sell included, is not the Woo store's", () => {
    expect(WOO_TURN_HIDDEN_TOOLS.has("shopify.complementary_products")).toBe(true);
  });

  it("its result is grounded like a search, and Woo reads count as shown", () => {
    // Source checks: the module pulls in every adapter at import.
    const src = readFileSync(join(__dirname, "../services/discovery-integration.service.ts"), "utf-8");
    const provider = src.slice(src.indexOf("export function productSearchProviderOf"), src.indexOf("export function isProductSearchTool"));
    expect(provider).toMatch(/case "woocommerce\.complementary_products":\s*return "woocommerce";/);
    const recorder = src.slice(src.indexOf("export async function recordDiscoverySearchOutcome"));
    expect(recorder).toContain('t.tool === "woocommerce.list_products" || t.tool === "woocommerce.get_product"');
    expect(src).toMatch(/\/\(\^\|\\\.\)complementary_products\$\//);
  });
});
