/**
 * Smoovee prod 2026-11-14 21:26 (cmwgwzvr): the store runs a 37% sale through
 * a discount-rules plugin, so only the product page knows the price. Five pages
 * were read at once, all five timed out at 4 s, and each was logged and cached
 * as "none": the customer was quoted ₪219 to ₪252 while the site sold them at
 * ₪137.97 to ₪158.76. A failed read is "unknown" now, never cached, retried
 * once, at most two at a time per store, and a rules store's product whose page
 * stays unknown shows no number, only "למחיר העדכני באתר".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fetchMock = vi.fn();
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, safeFetch: (...a: any[]) => fetchMock(...a) };
});

// The live block (2026-11-15): full price struck, "החל מ-", the sale price.
const page = (was: string, now: string) =>
  `<script id="awdr-main-js-extra">var awdr_params = {};</script><p class="price"><del aria-hidden="true"><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">&#8362;</span>${was}</bdi></span></del><br><ins><span class="price-from">החל מ-</span><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">&#8362;</span>${now}</bdi></span></ins></p>`;
const ok = (text: string) => ({ ok: true, status: 200, text });
const STORE = "https://smoovee-ltd.com/he/product";

async function fresh() {
  vi.resetModules();
  return import("../services/woo-rendered-price.service");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("the page price has three states", () => {
  it("the live 'החל מ-' block parses: 219 to 137.97", async () => {
    const m = await fresh();
    expect(m.parseRenderedDiscount(page("219", "137.97"))).toEqual({ was: 219, now: 137.97 });
  });

  it("a failed read on a known rules store is unknown, logged as fail, and not cached", async () => {
    const m = await fresh();
    fetchMock.mockResolvedValueOnce(ok(page("252", "158.76"))); // learns the store uses rules
    expect(await m.pagePriceFor({}, `${STORE}/ariel/`)).toEqual({ state: "discount", discount: { was: 252, now: 158.76 } });
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect(await m.pagePriceFor({}, `${STORE}/christina/`)).toEqual({ state: "unknown" });
    const lines = (console.log as any).mock.calls.flat().map(String);
    expect(lines).toContain("[woo-discount] /he/product/christina/ fail");
    expect(lines.some((l: string) => l.includes("christina/ none"))).toBe(false);
    // Not cached: the next ask reads the page again and gets the sale price.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok(page("219", "137.97")));
    expect(await m.pagePriceFor({}, `${STORE}/christina/`)).toEqual({ state: "discount", discount: { was: 219, now: 137.97 } });
  });

  it("one retry: a timeout then a good read is the sale price", async () => {
    const m = await fresh();
    fetchMock.mockResolvedValueOnce(ok(page("252", "158.76")));
    await m.pagePriceFor({}, `${STORE}/ariel/`);
    fetchMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(ok(page("227", "143.01")));
    expect(await m.pagePriceFor({}, `${STORE}/alexa/`)).toEqual({ state: "discount", discount: { was: 227, now: 143.01 } });
  });

  it("a page read and showing no discount is none, as before", async () => {
    const m = await fresh();
    fetchMock.mockResolvedValueOnce(ok(page("252", "158.76")));
    await m.pagePriceFor({}, `${STORE}/ariel/`);
    fetchMock.mockResolvedValue(ok(`<script id="awdr-main-js-extra"></script><p class="price"><bdi>&#8362;99</bdi></p>`));
    expect(await m.pagePriceFor({}, `${STORE}/gift/`)).toEqual({ state: "none" });
  });

  it("a store never read and unreadable now: none, the API price stands (a plain store is not punished)", async () => {
    const m = await fresh();
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await m.pagePriceFor({ on_sale: false }, "https://plain.example.com/p/a/")).toEqual({ state: "none" });
  });

  it("an API-marked hidden sale whose page cannot be read is unknown on any store", async () => {
    const m = await fresh();
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await m.pagePriceFor({ on_sale: true, regular_price: "262", sale_price: "262" }, "https://plain.example.com/p/a/")).toEqual({ state: "unknown" });
  });

  it("five pages at once: never more than two reads in flight per store, timeout 8 s", async () => {
    const m = await fresh();
    expect(m.PAGE_CONCURRENCY).toBe(2);
    expect(m.PAGE_TIMEOUT_MS).toBe(8000);
    fetchMock.mockResolvedValueOnce(ok(page("252", "158.76")));
    await m.pagePriceFor({}, `${STORE}/ariel/`);
    let inFlight = 0, peak = 0;
    fetchMock.mockImplementation(async (_url: string, opts: any) => {
      expect(opts.timeoutMs).toBe(8000);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok(page("219", "137.97"));
    });
    const names = ["christina", "adam", "alexa", "alice", "monica"];
    const got = await Promise.all(names.map((n) => m.pagePriceFor({}, `${STORE}/${n}/`)));
    expect(got.every((g) => g.state === "discount")).toBe(true);
    expect(peak).toBe(2);
  });
});

describe("a rules store's product with no trusted price shows no number", () => {
  it("the WhatsApp list and the grounded fallback say 'למחיר העדכני באתר', the model is told never to state a price", async () => {
    const ps = await import("../services/product-search.service");
    const env = ps.normalizeWooProducts([
      { id: 614, name: "סמובי כריסטינה", status: "publish", price: "219", stock_status: "instock", permalink: `${STORE}/christina/` },
      { id: 4068, name: "סמובי מוניקה", status: "publish", price: "199", stock_status: "instock", permalink: `${STORE}/monica/` },
    ], { storeUrl: "https://smoovee-ltd.com", storeCurrency: "ILS" });
    env.candidates = [ps.priceOnSiteOnly(env.candidates[0]), ps.applyDiscount(env.candidates[1], "199", "125.37")];
    // The API number is gone from the candidate itself, for any other reader of it.
    expect(env.candidates[0].price).toBeUndefined();
    expect(env.candidates[0].discount).toBeUndefined();
    expect(ps.priceOnSiteOnly(ps.applyDiscount(env.candidates[1], "199", "125.37")).discount).toBeUndefined();

    const list = ps.renderCandidatesForWhatsApp(env, "he");
    expect(list).toContain("סמובי כריסטינה\nלמחיר העדכני באתר");
    expect(list).not.toContain("219");
    expect(list).toContain("125.37");

    const grounded = ps.renderGroundedProductReply("", env, "he").message;
    expect(grounded).toContain("למחיר העדכני באתר");
    expect(grounded).not.toContain("219");
    expect(grounded).not.toMatch(/מעט מעל התקציב/);

    const summary = ps.buildKeyedModelSummary(env, "he", true);
    expect(summary).toMatch(/PRODUCT_1: "סמובי כריסטינה" \| price: NOT KNOWN/);
    expect(summary).not.toMatch(/PRODUCT_1[^\n]*219/);
    expect(ps.renderCandidatesForWhatsApp(env, "en")).toContain("Current price on the site");
  });
});

describe("a product its own page sells below its price says so (Omer 2026-11-15)", () => {
  const STORE_URL = "https://smoovee-ltd.com";
  it("'עכשיו במבצע: ₪137.97 במקום ₪219 (37% הנחה)', per product, only from its page", async () => {
    const ps = await import("../services/product-search.service");
    const env = ps.normalizeWooProducts([
      { id: 614, name: "סמובי כריסטינה", status: "publish", price: "219", stock_status: "instock", permalink: `${STORE}/christina/` },
      { id: 4068, name: "סמובי מוניקה", status: "publish", price: "199", stock_status: "instock", permalink: `${STORE}/monica/` },
      { id: 2183, name: "סמובי אדם", status: "publish", price: "227", stock_status: "instock", permalink: `${STORE}/adam/` },
    ], { storeUrl: STORE_URL, storeCurrency: "ILS" });
    env.candidates = [
      ps.applyDiscount(env.candidates[0], "219", "137.97"),   // its page: del 219, ins 137.97
      env.candidates[1],                                        // its page: no discount
      ps.priceOnSiteOnly(env.candidates[2]),                    // its page: unreadable
    ];
    const he = ps.renderCandidatesForWhatsApp(env, "he");
    expect(he).toContain("סמובי כריסטינה\nעכשיו במבצע: ₪137.97 במקום ₪219 (37% הנחה)");
    // No sale claim for a product whose page shows none, and none for an unknown one.
    expect(he).toMatch(/סמובי מוניקה\n(?:ILS|₪) ?199/);
    expect(he.split("סמובי מוניקה")[1].split("\n\n")[0]).not.toMatch(/מבצע/);
    expect(he).toContain("סמובי אדם\nלמחיר העדכני באתר");
    expect(he.split("סמובי אדם")[1]).not.toMatch(/מבצע|227/);
    expect(ps.renderGroundedProductReply("", env, "he").message).toContain("עכשיו במבצע: ₪137.97 במקום ₪219 (37% הנחה)");
    expect(ps.renderCandidatesForWhatsApp(env, "en")).toContain("On sale now: ₪137.97 instead of ₪219 (37% off)");
  });

  it("a cut that is not a whole percent shows the prices without a percent", async () => {
    const ps = await import("../services/product-search.service");
    const env = ps.normalizeWooProducts([{ id: 1, name: "X", status: "publish", price: "227", stock_status: "instock", permalink: `${STORE}/x/` }], { storeUrl: STORE_URL, storeCurrency: "ILS" });
    const c = ps.applyDiscount(env.candidates[0], "227", "217");
    expect(ps.salePriceLine(c, "he")).toBe("עכשיו במבצע: ₪217 במקום ₪227");
    expect(ps.salePriceLine(env.candidates[0], "he")).toBeNull();
    expect(ps.salePriceLine(ps.priceOnSiteOnly(c), "he")).toBeNull();
  });
});

describe("the web chat card: a rules store's product whose page could not be read", () => {
  it("carries no number and priceOnSite, on the card and every variant", () => {
    const w = readFileSync(join(__dirname, "../services/woo-chat-turn.service.ts"), "utf8");
    expect(w).toContain('const page = await pagePriceFor(raw, card.productUrl).catch(() => ({ state: "none" as const }));');
    const block = w.slice(w.indexOf('if (page.state === "unknown") {'), w.indexOf("return card;", w.indexOf('if (page.state === "unknown") {')));
    expect(block).toContain("card.price = null;");
    expect(block).toContain("card.compareAtPrice = null;");
    expect(block).toContain("card.priceOnSite = true;");
    expect(block).toContain("price: null, compareAtPrice: null");
  });
});
