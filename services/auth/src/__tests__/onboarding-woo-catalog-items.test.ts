/**
 * Smoovee (prod 2026-11-08): the onboarding "המוצרים שלנו" doc was 682
 * characters (a count, the categories, 8 English names with prices), so no
 * product's short description ("מתאים ל: תמי 4 באבלס") reached the knowledge
 * base, and the store is WPML: the Store API answers English unless asked for
 * lang=he, though her customers read /he/.
 *
 * The fixture is her public Store API (2026-11-08), both languages.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, prisma: {} };
});

import { harvestWoo, plainDetails, ITEMS_MAX, type Fetcher } from "../services/onboarding-discover/harvest";
import { productsDoc, SECTION_BREAK } from "../services/onboarding-discover/learn";

const API: { he: any[]; en: any[] } = JSON.parse(readFileSync(join(__dirname, "fixtures/smoovee-store-api.json"), "utf8"));
const O = "https://smoovee-ltd.com";

function store(he = API.he, en = API.en) {
  const urls: string[] = [];
  const f: Fetcher = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const list = u.searchParams.get("lang") === "he" ? he : en;
    const page = Number(u.searchParams.get("page") ?? 1), per = Number(u.searchParams.get("per_page") ?? 10);
    return { ok: true, status: 200, text: JSON.stringify(list.slice((page - 1) * per, page * per)) };
  };
  return { f, urls };
}

describe("the onboarding read of a WPML Woo store", () => {
  it("a Hebrew site reads the Hebrew catalogue", async () => {
    const s = store();
    const h = await harvestWoo(O, s.f, "he");
    expect(s.urls[0]).toMatch(/lang=he/);
    expect(h.products!.highlights[0]!.title).toMatch(/[א-ת]/);
  });
  it("no language: the request as before (other tests pin its exact URL)", async () => {
    const s = store();
    await harvestWoo(O, s.f);
    expect(s.urls[0]).toBe(`${O}/wp-json/wc/store/v1/products?per_page=100&page=1`);
  });
  it("every product of a small catalogue, with what it fits", async () => {
    const h = await harvestWoo(O, store().f, "he");
    const items = h.products!.items!;
    expect(items).toHaveLength(30);
    const alexa = items.find((i) => i.title === "סמובי אלכסה – משטח הזזה 35*28 ס”מ" || /^סמובי אלכסה/.test(i.title))!;
    expect(alexa.details).toMatch(/מתאים ל: · תמי 4 באבלס · תמי 4 אדג/);
    expect(alexa.details).not.toMatch(/<|&#/);
    expect(alexa.details.length).toBeLessThanOrEqual(401);
    expect(alexa.price).toBeGreaterThan(0);
    expect(alexa.url).toMatch(/^https:\/\//);
    expect(alexa.categories.length).toBeGreaterThan(0);
  });
  it("a catalogue over 200 keeps the summary only", async () => {
    const many = Array.from({ length: ITEMS_MAX + 1 }, (_, i) => ({ ...API.he[0], id: i + 1 }));
    const h = await harvestWoo(O, store(many, many).f, "he");
    expect(h.products!.count).toBe(ITEMS_MAX + 1);
    expect(h.products!.items).toBeUndefined();
  });
});

describe("the products document", () => {
  it("one section per product, each its own chunk, the Alexa's holding \"תמי 4\"", async () => {
    const h = await harvestWoo(O, store().f, "he");
    const doc = productsDoc(h.products!, null, "he");
    const sections = doc.content.split(`\n${SECTION_BREAK}\n`);
    expect(sections).toHaveLength(31); // the summary, then 30 products
    expect(sections[0]).toMatch(/מספר מוצרים: 30/);
    const alexa = sections.find((s) => /^סמובי אלכסה/.test(s))!;
    expect(alexa).toMatch(/תמי 4 באבלס/);
    expect(alexa).toMatch(/מחיר: \d/);
    expect(alexa).toMatch(/קישור: https:\/\//);
    // Only the Alexa sections hold "תמי 4"; the AI service's chunker cuts at the
    // same break (ai e22-smoovee-description-search: chunkDocument).
    expect(sections.filter((s) => /תמי 4/.test(s)).every((s) => /אלכסה/.test(s))).toBe(true);
    expect(SECTION_BREAK).toBe("\f");
  });
  it("a summary with no items is the document as before", () => {
    const doc = productsDoc({ count: 2, more: false, categories: ["Kitchen"], priceRange: null, inStock: 2, highlights: [], source: "woo_store_api" }, null, "en");
    expect(doc.content).not.toContain(SECTION_BREAK);
  });
  it("HTML copy as one line", () => {
    expect(plainDetails("<p><strong>Suitable for:</strong></p><ul><li>Tami 4&#8217;s</li><li>Ninja</li></ul>")).toBe("Suitable for: · Tami 4’s · Ninja");
  });
});
