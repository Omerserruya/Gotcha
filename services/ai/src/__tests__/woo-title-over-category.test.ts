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
  it("a category named for her word: her titles still come first (regression)", async () => {
    const tree = [{ id: 60, name: "בובונים ומטפחות", count: 12 }, { id: 50, name: "אקססוריז", count: 2 }];
    const prods = [...Array.from({ length: 12 }, (_, i) => ({ id: 300 + i, name: `מטפחת ${i}`, status: "publish", catalog_visibility: "visible", stock_status: "instock", categories: [{ id: 60, name: tree[0].name }] })),
      { id: 400, name: "בובון שטוח", status: "publish", catalog_visibility: "visible", stock_status: "instock", categories: [{ id: 50, name: "אקססוריז" }] }];
    const base = `https://bobbon-cat${Date.now()}.example.com`;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      let body: any = [];
      if (u.pathname.endsWith("/products/categories")) body = tree;
      else if (u.pathname.endsWith("/products")) {
        const q = u.searchParams.get("search") ?? ""; const cat = u.searchParams.get("category");
        body = cat ? prods.filter((x) => x.categories.some((c) => String(c.id) === cat)) : q ? prods.filter((x) => x.name.includes(q)) : prods;
      }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }));
    const out: any[] = await Woo.execute({ toolName: "list_products", args: { query: "בובון לקשירה נמוכה", per_page: 10 }, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as any;
    expect(out[0]?.name).toBe("בובון שטוח");
  });
  it("★ audience=women never drops a product she named that sits outside the Women category", async () => {
    const tree = [{ id: 70, name: "נשים", count: 3 }, { id: 71, name: "גברים", count: 1 }, { id: 50, name: "אקססוריז", count: 1 }];
    const prods = [
      // The scarves' copy mentions a bobbon, so a search for "בובון" brings them too (and they crowd it out).
      { id: 501, name: "מטפחת אנה", description: "נקשרת יפה עם בובון", status: "publish", catalog_visibility: "visible", stock_status: "instock", categories: [{ id: 70, name: "נשים" }] },
      { id: 502, name: "מטפחת דנה", description: "נקשרת יפה עם בובון", status: "publish", catalog_visibility: "visible", stock_status: "instock", categories: [{ id: 70, name: "נשים" }] },
      { id: 503, name: "בובון שטוח", status: "publish", catalog_visibility: "visible", stock_status: "instock", categories: [{ id: 50, name: "אקססוריז" }] },
      { id: 504, name: "בובון לגבר", status: "publish", catalog_visibility: "visible", stock_status: "instock", categories: [{ id: 71, name: "גברים" }] },
    ];
    const base = `https://bobbon-aud${Date.now()}.example.com`;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      let body: any = [];
      if (u.pathname.endsWith("/products/categories")) body = tree;
      else if (u.pathname.endsWith("/products")) {
        const q = u.searchParams.get("search") ?? ""; const cat = u.searchParams.get("category");
        // The store's search reads copy too: every product comes back (the scarves crowd the bobbon).
        body = cat ? prods.filter((x) => x.categories.some((c) => String(c.id) === cat)) : prods;
      }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }));
    // As in the trace: the model searched "מטפחת" for women; her own words ran alongside and found the bobbons.
    const out: any[] = await Woo.execute({ toolName: "list_products", args: { query: "מטפחת לקשירה נמוכה", customer_query: "היי מחפשת את הבובון לקשירה נמוכה", audience: "women", per_page: 10 }, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: base } } as any) as any;
    expect(out.map((x: any) => x.name)).toContain("בובון שטוח");
    expect(out[0]?.name).toBe("בובון שטוח");
    // Never one from the other gender's category.
    expect(out.map((x: any) => x.name)).not.toContain("בובון לגבר");
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
