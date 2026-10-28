/**
 * After urban-e33 (2026-10-28).
 *
 *   The cart replay's T4 "אוקי ויש מעיל לגברים ?" searched "Jacket" for men and
 *   the Wool Blend Overcoat was ranked out. "מעיל" is the whole Jackets & Coats
 *   category, with the audience, ranked by "coat".
 *   U1 asked the size again after the customer let it pass.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo from "../services/connectors/woocommerce.adapter";
import { broadKind } from "../services/woo-chat-turn.service";
import { dropIgnoredSizeQuestion } from "../services/reply-style-check.service";

describe("\"מעיל\" is the category", () => {
  it.each([
    ["אוקי ויש מעיל לגברים ?", "Jacket", { kind: "coats", rank: "coat" }],
    ["אני מחפש מעיל", "coat", { kind: "coats", rank: "coat" }],
    ["יש מעילים חמים?", "wool coats", { kind: "coats", rank: "wool coat" }],
  ])("%s / %s", (msg, q, want) => expect(broadKind(msg, q)).toEqual(want));
  it.each([
    ["יש טרנץ' בבז'?", "trench coat"],
    ["יש מעיל טרנץ'?", "coat"],
    ["יש סוודר?", "sweater"],
    ["ויש ז'קט ג'ינס?", "denim jacket"],
  ])("not: %s / %s", (msg, q) => expect(broadKind(msg, q)).toBeNull());

  // The urban store's Jackets & Coats as on dev (read-only SELECT).
  const TREE = [
    { id: 48, name: "Clothing", parent: 0, count: 0 }, { id: 54, name: "Jackets &amp; Coats", parent: 48, count: 5 },
    { id: 57, name: "Women", parent: 0, count: 26 }, { id: 58, name: "Men", parent: 0, count: 25 },
  ];
  const p = (id: number, name: string, cats: number[]) => ({ id, name, status: "publish", catalog_visibility: "visible", categories: cats.map((id) => ({ id })) });
  // The store's own order: the jackets come first.
  const COATS = [
    p(343, "Denim Trucker Jacket", [54, 57, 58]), p(352, "Quilted Liner Jacket", [54, 58]),
    p(372, "Chore Jacket", [54, 58]), p(364, "Cotton Trench Coat", [54, 57]), p(329, "Wool Blend Overcoat", [54, 57, 58]),
  ];
  afterEach(() => vi.unstubAllGlobals());
  it("T4: for men, the overcoat first, then the men's jackets; never the women's trench", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = new URL(url);
      let body: any = [];
      if (u.pathname.endsWith("/products/categories")) body = TREE;
      else if (u.searchParams.get("category") === "54") body = COATS;
      else if (u.searchParams.get("search")) body = COATS.filter((x) => x.name.toLowerCase().includes(u.searchParams.get("search")!.toLowerCase()));
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }));
    const got: any[] = await Woo.execute({
      toolName: "list_products",
      args: { query: "Jacket", audience: "men", in_stock: true, per_page: 10, kind: "coats", rank: "coat" },
      credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://coats.example.com" },
    } as any) as any;
    expect(got.map((x) => x.id)).toEqual([329, 343, 352, 372]);
  });
  it("wired: the model's search gets the kind", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("const broad = broadKind(opts.incomingMessage, modelQuery);");
  });
});

describe("U1: the size is not asked again after the customer let it pass", () => {
  const T1 = "היי! הנה שני מעילים שמתאימים, טרנץ' קל וקלאסי, ומעיל צמר ארוך ומחמם. יש צבע או מידה מועדפים?";
  it("T2 \"בשבילי לגבר\": the size question goes, the rest stays", () => {
    expect(dropIgnoredSizeQuestion("מעיל צמר ארוך, חם וקלאסי שמתאים לגבר. איזה מידה מתאימה לך?", [T1], "בשבילי לגבר"))
      .toBe("מעיל צמר ארוך, חם וקלאסי שמתאים לגבר.");
  });
  it("unchanged: the customer gave a size, the last reply asked none, or nothing would be left", () => {
    const reply = "מעיל צמר ארוך וחם. איזו מידה מתאימה לך?";
    expect(dropIgnoredSizeQuestion(reply, [T1], "M בבקשה")).toBe(reply);
    expect(dropIgnoredSizeQuestion(reply, [T1], "במידה 48")).toBe(reply);
    expect(dropIgnoredSizeQuestion(reply, ["הנה שני מעילים. איזה צבע?"], "בשבילי לגבר")).toBe(reply);
    expect(dropIgnoredSizeQuestion("איזו מידה מתאימה?", [T1], "בשבילי")).toBe("איזו מידה מתאימה?");
  });
  it("wired before the final gate", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("const unasked = dropIgnoredSizeQuestion(replyText, gateCtx.previousReplies ?? [], opts.incomingMessage ?? \"\");");
  });
});
