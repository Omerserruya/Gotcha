/**
 * Rating d7782dd2 (Tehila, 2026-11-18): "בובון לקשירה נמוכה" routed to a scarves category by "קשירה", whose
 * products filled the page before "בובון שטוח", a title holding the customer's own word. A title holding a
 * word the category does not account for now comes before the category's other products.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});
import Woo from "../services/connectors/woocommerce.adapter";

const TREE = [{ id: 40, name: "מטפחות קשירה", count: 12 }, { id: 50, name: "אקססוריז", count: 2 }];
const p = (id: number, name: string, cats: number[]) => ({ id, name, status: "publish", catalog_visibility: "visible", stock_status: "instock", categories: cats.map((c) => ({ id: c, name: TREE.find((t) => t.id === c)?.name })) });
const PRODUCTS = [
  ...Array.from({ length: 12 }, (_, i) => p(100 + i, `מטפחת ${["אנה", "דנה", "רות", "מאיה", "נועה", "תמר", "שירה", "יעל", "לאה", "הדר", "גלי", "מור"][i]}`, [40])),
  p(200, "בובון שטוח", [50]), p(201, "בובון חצי שטוח", [50]),
];
let n = 0;
function store() {
  const base = `https://bobbon${++n}.example.com`;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(url);
    let body: any = [];
    if (u.pathname.endsWith("/products/categories")) body = TREE;
    else if (u.pathname.endsWith("/products")) {
      const q = u.searchParams.get("search") ?? "";
      const cat = u.searchParams.get("category");
      body = cat ? PRODUCTS.filter((x) => x.categories.some((c) => String(c.id) === cat)) : q ? PRODUCTS.filter((x) => x.name.includes(q)) : PRODUCTS;
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  return (args: Record<string, unknown>) => Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as Promise<any[]>;
}
afterEach(() => vi.unstubAllGlobals());

describe("a title of the customer's own word before the category", () => {
  it("★ 'בובון לקשירה נמוכה' finds the bobbons first, not ten scarves", async () => {
    const run = store();
    const out = await run({ query: "בובון לקשירה נמוכה", per_page: 10 });
    expect(out.slice(0, 2).map((x: any) => x.name).sort()).toEqual(["בובון חצי שטוח", "בובון שטוח"]);
  });
  it("★ the model swapped her word for another ('מטפחת'): her own words still run, and her bobbons come first", async () => {
    const run = store();
    const out = await run({ query: "מטפחת לקשירה נמוכה", customer_query: "בובון לקשירה נמוכה", per_page: 10 });
    expect(out.slice(0, 2).map((x: any) => x.name).sort()).toEqual(["בובון חצי שטוח", "בובון שטוח"]);
  });
  it("★ a category word with a title word: the title holding her word comes before the category's other products", async () => {
    const run = store();
    const out = await run({ query: "בובון מטפחות קשירה", per_page: 10 });
    expect(out.slice(0, 2).map((x: any) => x.name).sort()).toEqual(["בובון חצי שטוח", "בובון שטוח"]);
  });
  it("the words the model dropped", async () => {
    const { droppedCustomerWords } = await import("../services/connectors/woocommerce.adapter");
    expect(droppedCustomerWords("בובון לקשירה נמוכה", "מטפחת לקשירה נמוכה")).toEqual(["בובון"]);
    expect(droppedCustomerWords("מטפחות חגיגיות", "מטפחת חגיגית")).toEqual([]);
  });
  it("a plain category ask still lists the category", async () => {
    const run = store();
    const out = await run({ query: "מטפחות קשירה", per_page: 10 });
    expect(out.every((x: any) => x.name.startsWith("מטפחת"))).toBe(true);
  });
});
