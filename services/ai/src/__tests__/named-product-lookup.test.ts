/**
 * The urban widget's stock answer (2026-10-25 proof turn): "יש את מעיל הטרנץ'
 * במידה M?" was answered with a question, because the discovery engine ran a
 * SNOWBOARD profile on a clothing store and ordered "Still missing required:
 * Budget, Riding style. Ask ONE of these, nothing else." Pinned here:
 *   (a) a stock / size / colour / price question about a NAMED product is a
 *       lookup: the decision forces the store's tool, the snapshot says "look
 *       it up now", on any turn, whatever the recommendation facts say;
 *   (b) a WooCommerce store describes itself (categories, attributes), so the
 *       snowboard facts are demoted there; a catalogue that DOES record a
 *       riding style keeps it required (the snowboard store, either platform);
 *       a disconnected Shopify row no longer shadows a connected Woo store,
 *       and Woo facets are cached in Redis, never on the integration row;
 *   (c) the product objective completes on any store's search;
 *   (d) QUALIFY's questions fit a store as well as a SaaS business.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => {
  const kv = new Map<string, string>();
  const H0 = {
    kv,
    facts: [] as any[],
    searched: 0,
    integrations: [] as any[],
    integrationUpdates: 0,
    wooProducts: [] as any[],
    scans: [] as string[],
    extracted: [] as any[],
    scan: null as any,
  } as any;
  (H0 as any).prisma = {
  discoveryFact: { findMany: async () => H0.facts },
  discoveryActionAttempt: { count: async () => H0.searched },
  tenantIntegration: {
    findFirst: async (a: any) =>
      H0.integrations.find((r: any) => r.slug === a.where.integration.slug && (!a.where.status || r.status === a.where.status)) ?? null,
    update: async () => { H0.integrationUpdates++; return {}; },
  },
};
  return H0;
});
H.scan = async ({ toolFunctionName }: any) => { H.scans.push(toolFunctionName); return { ok: true, result: H.wooProducts }; };

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({ prisma: H.prisma }));
vi.mock("@chatcenter/shared", async () => {
  const state = await vi.importActual<any>("../../../../packages/shared/src/lib/discovery-state");
  const profiles = await vi.importActual<any>("../../../../packages/shared/src/lib/discovery-profiles");
  return {
    ...state,
    ...profiles,
    getOrCreateActiveSession: async () => ({ id: "s1", tenantId: "T" }),
    applyExtractedFacts: async () => ({ written: [] }),
    markAnswered: async () => undefined,
    recordActionAttempt: async () => undefined,
    prisma: H.prisma,
    getRedis: () => ({
      get: async (k: string) => H.kv.get(k) ?? null,
      set: async (k: string, v: string) => { H.kv.set(k, v); return "OK"; },
    }),
  };
});
vi.mock("../services/intelligence-live-extract.service", () => ({ extractFieldsLive: async () => H.extracted }));
vi.mock("../services/connectors/integration-framework", () => ({ executeAdapterTool: (a: any) => H.scan(a), loadConnection: async () => null }));
vi.mock("../services/connectors/index", () => ({ executeAdapterTool: (a: any) => H.scan(a) }));
vi.mock("../services/connectors/woocommerce.adapter", () => ({ fetchWooStoreCurrency: async () => null }));
vi.mock("../services/product-search.service", () => ({ normalizeShopifyProducts: vi.fn(), normalizeWooProducts: vi.fn() }));

import { runProductDiscoveryTurn, namedProductLookup } from "../services/discovery-integration.service";
import { detectProductInquiry } from "../services/product-intent.service";
import { deriveWooFacets, deriveFacets, profileForStore, getCatalogFacets } from "../services/shopify-facets.service";
import { PRODUCT_RECOMMENDATION_PROFILE } from "@chatcenter/shared";
import { objectiveComplete as isObjectiveComplete, OBJECTIVES } from "../services/objectives";

const fact = (key: string, value: unknown) => ({ normalizedKey: key, valueJson: value, status: "active", source: "customer_explicit" });
const WOO = ["woocommerce.list_products", "woocommerce.get_product", "woocommerce.list_product_variations", "escalate_to_human"];
const coat = (id: number, name: string, o: any = {}) => ({
  id, name, price: "799", stock_status: "instock", categories: [{ id: 7, name: "Coats" }], tags: [],
  attributes: [{ name: "Size", options: ["S", "M", "L"] }, { name: "Color", options: ["Beige"] }], ...o,
});
const turn = (message: string, tools = WOO) =>
  runProductDiscoveryTurn({ tenantId: "T", conversationId: "c1", aiAgentId: "emp1", role: "sales", availableToolNames: tools, incomingMessage: message });

beforeEach(() => {
  H.kv.clear(); H.facts = []; H.searched = 0; H.integrationUpdates = 0; H.scans = []; H.extracted = [];
  H.integrations = [
    { slug: "shopify", status: "DISCONNECTED", id: "ti_s", config: {} },
    { slug: "woocommerce", status: "CONNECTED", id: "ti_w", config: {} },
  ];
  H.wooProducts = [coat(364, "Cotton Trench Coat"), coat(329, "Wool Blend Overcoat", { price: "899" })];
});

describe("(a) which messages are product questions", () => {
  it.each([
    ["יש במלאי את המעיל?", "stock"],
    ["יש את מעיל הטרנץ' במידה M?", "variant"],
    ["כמה עולה המעיל?", "price"],
    ["מה המחיר של הטרנץ'?", "price"],
    ["is the trench coat in stock?", "stock"],
    ["how much is the overcoat?", "price"],
  ])("%s -> %s", (text, kind) => {
    expect(detectProductInquiry(text)?.kind).toBe(kind);
  });

  it.each([["אני מחפש מעיל לחורף"], ["היי"], ["help me choose a jacket"]])("%s -> not a lookup", (text) => {
    expect(detectProductInquiry(text)).toBeNull();
  });
});

describe("★ (a) a named product's stock, size or price is a lookup", () => {
  it("the proof-turn message: forced woocommerce.list_products, and the snapshot says look it up, not ask", async () => {
    H.facts = [fact("product_category", "trench coat")];
    const r = await turn("יש את מעיל הטרנץ' במידה M?");
    expect(r.decision).toEqual({ kind: "lookup", tool: "woocommerce.list_products", inquiry: "variant" });
    expect(r.snapshot).toContain("Look it up NOW with woocommerce.list_products");
    expect(r.snapshot).not.toContain("nothing else");
    expect(r.snapshot).not.toMatch(/Riding style/);
  });

  it("a price question too; and after a search already ran, still a lookup", async () => {
    H.facts = [fact("product_category", "coat")];
    H.searched = 1;
    expect((await turn("כמה עולה המעיל?")).decision).toMatchObject({ kind: "lookup", inquiry: "price" });
  });

  it("no product named: stays discovery (a question back is right there)", async () => {
    const r = await turn("יש לכם משהו במלאי?");
    expect(r.decision?.kind).toBe("collect");
  });

  it("Shopify: variant_information first (it takes a name), else the search", async () => {
    H.facts = [fact("product_category", "snowboard")];
    expect(await namedProductLookup({ sessionId: "s1", message: "יש במידה 159?", availableToolNames: ["shopify.search_products", "shopify.variant_information"] }))
      .toEqual({ tool: "shopify.variant_information", inquiry: "variant" });
    expect(await namedProductLookup({ sessionId: "s1", message: "is it in stock?", availableToolNames: ["shopify.search_products"] }))
      .toEqual({ tool: "shopify.search_products", inquiry: "stock" });
    expect(await namedProductLookup({ sessionId: "s1", message: "is it in stock?", availableToolNames: ["escalate_to_human"] })).toBeNull();
  });
});

describe("★ (b) the store describes itself", () => {
  it("a connected Woo store behind a DISCONNECTED Shopify row: the Woo catalogue, cached in Redis, no integration write", async () => {
    const f = await getCatalogFacets("T");
    expect(f?.provider).toBe("woocommerce");
    expect(f?.productTypes.map((t) => t.type)).toEqual(["Coats"]);
    expect(f?.options.map((o) => o.name)).toEqual(["Size", "Color"]);
    expect(H.scans).toEqual(["woocommerce.list_products"]);
    expect(H.integrationUpdates).toBe(0);
    await getCatalogFacets("T");
    expect(H.scans).toHaveLength(1); // the cache answered
  });

  it("WooCommerce's HTML-encoded names are decoded", () => {
    const f = deriveWooFacets([coat(1, "x", { categories: [{ id: 1, name: "Jackets &amp; Coats" }], attributes: [{ name: "Fit &#038; Size", options: ["S &amp; M"] }] })]);
    expect(f.productTypes[0].type).toBe("Jackets & Coats");
    expect(f.options[0]).toMatchObject({ name: "Fit & Size", values: ["S & M"] });
  });

  it("the clothing store's interview: riding style demoted, size and colour offered as optional", () => {
    const p = profileForStore(PRODUCT_RECOMMENDATION_PROFILE, deriveWooFacets(H.wooProducts));
    const req = p.facts.filter((f) => f.required).map((f) => f.key);
    // Budget is never required in a shop (eval R1).
    expect(req).toEqual(["product_category"]);
    expect(p.facts.find((f) => f.key === "size")).toMatchObject({ required: false, enumValues: ["S", "M", "L"] });
  });

  it("★ the snowboard store keeps riding style required when its catalogue records one, on either platform", () => {
    const wooBoards = [coat(1, "Board", { categories: [{ id: 2, name: "Snowboards" }], attributes: [{ name: "Riding style", options: ["freestyle", "all mountain"] }] })];
    expect(profileForStore(PRODUCT_RECOMMENDATION_PROFILE, deriveWooFacets(wooBoards)).facts.find((f) => f.key === "riding_style")?.required).toBe(true);
    const shopifyBoards = [{ id: "b", title: "Board", product_type: "snowboard", options: [{ name: "Riding style" }], variants: [{ price: "600", available: true, option1: "freestyle" }] }];
    expect(profileForStore(PRODUCT_RECOMMENDATION_PROFILE, deriveFacets(shopifyBoards)).facts.find((f) => f.key === "riding_style")?.required).toBe(true);
    // The board store's other questions stay askable; the coat store's do not.
    expect(profileForStore(PRODUCT_RECOMMENDATION_PROFILE, deriveFacets(shopifyBoards)).facts.find((f) => f.key === "flex")?.askable).not.toBe(false);
    expect(profileForStore(PRODUCT_RECOMMENDATION_PROFILE, deriveWooFacets(H.wooProducts)).facts.find((f) => f.key === "flex")?.askable).toBe(false);
    // And with no catalogue to read, the profile is the snowboard one, with budget optional.
    const bare = profileForStore(PRODUCT_RECOMMENDATION_PROFILE, null);
    expect(bare.facts.map((f) => f.key)).toEqual(PRODUCT_RECOMMENDATION_PROFILE.facts.map((f) => f.key));
    expect(bare.facts.find((f) => f.key === "budget")?.required).toBe(false);
    expect(bare.facts.find((f) => f.key === "riding_style")?.required).toBe(true);
  });

  it("a connected Shopify store still describes itself from Shopify", async () => {
    H.integrations = [{ slug: "shopify", status: "CONNECTED", id: "ti_s", config: {} }];
    H.wooProducts = [];
    await getCatalogFacets("T");
    expect(H.scans).toEqual(["shopify.search_products"]);
  });

  it("the ready line names the store's own search, not shopify.search_products", async () => {
    H.facts = [fact("product_category", "coat"), fact("budget", { max: 800 })];
    const r = await turn("אני מחפש מעיל עד 800");
    expect(r.decision).toEqual({ kind: "execute", tool: "woocommerce.list_products" });
    expect(r.snapshot).toContain("REAL tool call: woocommerce.list_products");
  });
});

describe("(c) and (d)", () => {
  it("the product objective completes on a WooCommerce search", () => {
    const obj = OBJECTIVES.PRODUCT_RECOMMENDATION;
    expect(isObjectiveComplete(obj, "NEW_PROSPECT" as any, "", ["woocommerce.list_products"])).toBe(true);
    expect(isObjectiveComplete(obj, "NEW_PROSPECT" as any, "", ["shopify.search_products"])).toBe(true);
    expect(isObjectiveComplete(obj, "NEW_PROSPECT" as any, "", [])).toBe(false);
  });

  it("QUALIFY asks a store about use, fit and budget, and looks up a named product instead of qualifying", () => {
    const src = readFileSync(join(__dirname, "../services/behavior-strategies.ts"), "utf-8");
    expect(src).toContain("A store (products in the catalogue): what it is for, the size or fit, a budget");
    expect(src).toContain("A question about a product they named (its stock, size, colour or price) is not a moment to qualify");
  });
});

describe("★ a product the model knows by its key is called by its id", () => {
  it("PRODUCT_1 -> the first candidate's real id; anything else unchanged", async () => {
    const { resolveProductRef } = await vi.importActual<any>("../services/product-search.service");
    const env = { candidates: [{ productId: "364" }, { productId: "329" }] } as any;
    expect(resolveProductRef(env, "PRODUCT_1")).toBe("364");
    expect(resolveProductRef(env, " product_2 ")).toBe("329");
    expect(resolveProductRef(env, "PRODUCT_9")).toBe("PRODUCT_9");
    expect(resolveProductRef(env, "364")).toBe("364");
    expect(resolveProductRef(null, "PRODUCT_1")).toBe("PRODUCT_1");
  });

  it("applied before every gate in runAdapterTool", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf-8");
    const start = src.indexOf("runAdapterTool: async ({ toolFunctionName, args: rawArgs }) => {");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, start + 2500);
    expect(body.indexOf("resolveProductRef(productEnvelope")).toBeGreaterThan(0);
    expect(body.indexOf("resolveProductRef(productEnvelope")).toBeLessThan(body.indexOf("assertMatchesResolvedFlow"));
  });
});

describe("★ a lookup turn's reply is the answer, with the product attached", () => {
  const env = { status: "ok", candidates: [{ productId: "364", title: "Cotton Trench Coat", price: "799", currency: "ILS", url: "https://shop/p/364", inventoryState: "in_stock" }] } as any;
  const rendered = { message: "הנה מה שמצאתי:\n\n1. Cotton Trench Coat\nILS 799\nבמלאי\nhttps://shop/p/364", usedFallback: true };

  it("lookup + cards: the model's answer, grounded (its true price kept, no URL, no wide dash), not the introduction", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    const out = finalProductReply({
      lookup: true, cards: true, envelope: env, introduction: "הנה כמה אפשרויות:",
      modelText: "כן — PRODUCT_1 במידה M במלאי, ₪799 בלבד https://shop/p/364",
    });
    expect(out).toBe("כן - Cotton Trench Coat במידה M במלאי, ₪799 בלבד");
  });

  it("★ A02: asked the price, the store's own price stays, written ₪799, whatever form the model used", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    for (const said of ["₪799", "799 ש״ח", "799 שקל", "ILS 799", "799.00₪"]) {
      const out = finalProductReply({ lookup: true, cards: true, envelope: env, introduction: "הנה:", modelText: `PRODUCT_1 עולה ${said}.` });
      expect(out, said).toBe("Cotton Trench Coat עולה ₪799.");
    }
  });

  it("★ an amount that is not the store's price is removed", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    expect(finalProductReply({ lookup: true, cards: true, envelope: env, introduction: "הנה:", modelText: "PRODUCT_1 עולה ₪699 במבצע." }))
      .toBe("Cotton Trench Coat עולה במבצע.");
  });

  it("★ E05: an amount stated in the turn's context (policy, KB, a tool) stays as written; a near miss does not", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    const context = "Store policy (shipping): Standard delivery in Israel takes 2-4 business days for a cost of ₪29.";
    const reply = (t: string) => finalProductReply({ lookup: true, cards: true, envelope: env, introduction: "הנה:", modelText: t, context });
    expect(reply("משלוח סטנדרטי (2-4 ימי עסקים, עלות ₪29)")).toBe("משלוח סטנדרטי (2-4 ימי עסקים, עלות ₪29)");
    expect(reply("משלוח סטנדרטי עולה ₪30")).toBe("משלוח סטנדרטי עולה");
    expect(reply("משלוח סטנדרטי עולה ₪2")).toBe("משלוח סטנדרטי עולה");
    // No context: only a product price survives, as before.
    expect(finalProductReply({ lookup: true, cards: true, envelope: env, introduction: "הנה:", modelText: "משלוח עולה ₪29 והמעיל ₪799" })).toBe("משלוח עולה והמעיל ₪799");
  });

  it("★ A02: a key followed by its own title in brackets prints the name once", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    expect(finalProductReply({ lookup: true, cards: true, envelope: env, introduction: "הנה:", modelText: "כן, יש את PRODUCT_1 (Cotton Trench Coat) במידה M." }))
      .toBe("כן, יש את Cotton Trench Coat במידה M.");
  });

  it("lookup + text channel: the answer first, the product block after it", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    const out = finalProductReply({ lookup: true, cards: false, envelope: env, introduction: "", rendered, modelText: "כן, יש במידה M ובמידה L." });
    expect(out).toBe(`כן, יש במידה M ובמידה L.\n\n${rendered.message}`);
  });

  it("★ a recommendation turn is unchanged: the introduction above cards, the rendering as text", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    expect(finalProductReply({ lookup: false, cards: true, envelope: env, introduction: "הנה כמה אפשרויות:", modelText: "כן, יש" })).toBe("הנה כמה אפשרויות:");
    expect(finalProductReply({ lookup: false, cards: false, envelope: env, introduction: "", rendered, modelText: "כן, יש" })).toBe(rendered.message);
  });

  it("a lookup whose text grounds to nothing falls back as before", async () => {
    const { finalProductReply } = await vi.importActual<any>("../services/product-search.service");
    expect(finalProductReply({ lookup: true, cards: true, envelope: env, introduction: "הנה:", modelText: "₪500 https://x.y" })).toBe("הנה:");
  });

  it("Hebrew amounts are grounded too: the store's price written ₪799, any other removed", async () => {
    const { renderLookupProse } = await vi.importActual<any>("../services/product-search.service");
    expect(renderLookupProse("המחיר 799 ש״ח והוא במלאי", env)).toBe("המחיר ₪799 והוא במלאי");
    expect(renderLookupProse("המחיר 650 ש״ח והוא במלאי", env)).toBe("המחיר והוא במלאי");
  });

  it("PRODUCT_n in a variations call resolves (the proof-turn 404)", async () => {
    const { resolveProductRef } = await vi.importActual<any>("../services/product-search.service");
    expect({ per_page: 50, product_id: resolveProductRef(env, "PRODUCT_1") }).toEqual({ per_page: 50, product_id: "364" });
  });
});

describe("the model reads a compact variations result", () => {
  it("options, stock and price per variation; nothing else", async () => {
    const { compactWooVariations } = await vi.importActual<any>("../services/product-search.service");
    const raw = JSON.stringify({ ok: true, result: [
      { id: 1, attributes: [{ name: "Size", option: "M" }], stock_status: "instock", stock_quantity: 3, price: "799", description: "x".repeat(2000), image: { src: "y" } },
      { id: 2, attributes: [{ name: "Size", option: "L" }], stock_status: "outofstock", price: "799", purchasable: false },
    ] });
    const out = JSON.parse(compactWooVariations(raw));
    expect(out.result).toEqual([
      { id: 1, options: { Size: "M" }, stock_status: "instock", stock_quantity: 3, price: "799", purchasable: true },
      { id: 2, options: { Size: "L" }, stock_status: "outofstock", price: "799", purchasable: false },
    ]);
    expect(compactWooVariations('{"ok":false,"reason":"x"}')).toBe('{"ok":false,"reason":"x"}');
    expect(compactWooVariations("not json")).toBe("not json");
  });
});
