/**
 * Omer's urban widget test (dev 2026-10-27, 19:40-19:48Z): slow, no cards after
 * the first search, no add-ons, and the promotions answer replaced.
 *
 *   - the add-ons read the category tree (it was refused as unknown_tool);
 *   - "for a man" filters to the store's Men category;
 *   - a store price (free shipping over ₪299) is not a made-up price;
 *   - a size list in parentheses is a menu;
 *   - our own PRODUCT_n keys, a greeting, a question after "סבבה": fixed in
 *     code, no regeneration; the cards still follow the keys the draft named;
 *   - "תראה לי" asks for cards;
 *   - the turn's three judgement calls run side by side;
 *   - the memory block (its turn count grows) is out of the cached prefix, and
 *     the fixed contracts are in it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, assertPublicUrl: vi.fn(async () => undefined) };
});

import Woo from "../services/connectors/woocommerce.adapter";
import { checkReplyStyle, menuSize, fixInCode, stripProductKeys, SHOW_ME, FIXED_IN_CODE, type StyleCheckContext } from "../services/reply-style-check.service";
import { planAutoRecommendation } from "../services/recommendation-autosend.service";
import { buildAgentPrompt, stablePrefixOf } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";

const ctx = (o: Partial<StyleCheckContext> = {}): StyleCheckContext => ({
  locale: "he", isFirstReply: false, incomingMessage: "אני רוצה לקנות מעיל", productFactsAvailable: true,
  shopFloor: true, toolsOffered: ["woocommerce.list_products"], customerClosing: false, ...o,
});
const kinds = (t: string, o: Partial<StyleCheckContext> = {}) => checkReplyStyle(t, ctx(o)).map((v) => v.kind);

describe("the add-ons read the category tree", () => {
  it("declared, so the framework runs it", () => {
    expect(Woo.tools().map((t) => t.name)).toContain("woocommerce.list_product_categories");
  });
});

describe("who it is for", () => {
  const STORE = "https://shop.example.com/wp-json/wc/v3";
  const cats = [{ id: 58, name: "Men", parent: 0 }, { id: 57, name: "Women", parent: 0 }, { id: 54, name: "Jackets &amp; Coats", parent: 48 }];
  const coats = [
    { id: 364, name: "Cotton Trench Coat", categories: [{ id: 54 }, { id: 57 }] },
    { id: 329, name: "Wool Blend Overcoat", categories: [{ id: 54 }, { id: 58 }, { id: 57 }] },
  ];
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.startsWith(`${STORE}/products/categories`) ? cats : url.startsWith(`${STORE}/products?`) ? coats : [];
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const run = (args: Record<string, unknown>) =>
    Woo.execute({ toolName: "list_products", args, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://shop.example.com" } } as any);

  it("men: only what the store files under Men", async () => {
    expect(((await run({ query: "coat", audience: "men" })) as any[]).map((p) => p.id)).toEqual([329]);
  });
  it("women: both coats; no audience: the search as it was", async () => {
    expect(((await run({ query: "coat", audience: "women" })) as any[]).map((p) => p.id)).toEqual([364, 329]);
    expect(((await run({ query: "coat" })) as any[]).map((p) => p.id)).toEqual([364, 329]);
  });
  it("the model is told, and told to say so when there is none", () => {
    const def: any = Woo.tools().find((t) => t.name === "woocommerce.list_products");
    expect(def.parameters.properties.audience.enum).toEqual(["men", "women"]);
    const caps = readFileSync(join(__dirname, "../services/capabilities.ts"), "utf8");
    expect(caps).toContain("never offer the other one's products as if they fit");
  });
});

describe("a store price is grounded", () => {
  const reply = "יש קוד welcome10 - 10% הנחה להזמנה ראשונה עד 30.09.2027, משלוח חינם בישראל בקנייה מעל ₪299.";
  it("₪299 from the store's own text: no product looked up, still not made up", () => {
    expect(kinds(reply, { productFactsAvailable: false, incomingMessage: "איזה מבצעים קיימים היום?", groundingText: "משלוח חינם בישראל בהזמנות מעל ₪299" }))
      .not.toContain("ungrounded_attribute");
  });
  it("a price nowhere in it still is", () => {
    expect(kinds("המעיל עולה ₪389.", { productFactsAvailable: false, groundingText: "משלוח חינם מעל ₪299" })).toContain("ungrounded_attribute");
  });
});

describe("a size list is a menu", () => {
  it("in parentheses, or after מבין", () => {
    expect(menuSize("איזו מידה מתאימה לך (XS, S, M, L, XL)?")).toBe(5);
    expect(menuSize("איזו מידה מתאימה לך מבין XS, S, M, L, XL?")).toBe(5);
    expect(kinds("יש לנו טרנץ' קליל ומעיל צמר ארוך. איזו מידה מתאימה לך (XS, S, M, L, XL)?")).toContain("long_menu");
  });
  it("one size asked is not", () => {
    expect(menuSize("יש ב-M?")).toBe(1);
  });
});

describe("fixed in code, no regeneration", () => {
  const draft = "היי! הנה שני מעילים שמתאימים: PRODUCT_1 ו‑PRODUCT_2.  \nאיזו מידה מתאימה לך?";
  it("the keys and the greeting go; what is left passes", () => {
    const v = checkReplyStyle(draft, ctx());
    expect(v.map((x) => x.kind)).toEqual(expect.arrayContaining(["latin_titles", "greeting_after_first"]));
    const fixed = fixInCode(draft, v);
    expect(fixed).toBe("הנה שני מעילים שמתאימים.\nאיזו מידה מתאימה לך?");
    expect(checkReplyStyle(fixed, ctx())).toEqual([]);
  });
  it("keys in parentheses, and a key list with commas", () => {
    expect(stripProductKeys("הטרנץ' קליל (PRODUCT_1), המעיל ארוך (PRODUCT_2).")).toBe("הטרנץ' קליל, המעיל ארוך.");
    expect(stripProductKeys("מצאנו: PRODUCT_1, PRODUCT_2 ו-PRODUCT_3. מה מתאים?")).toBe("מצאנו. מה מתאים?");
  });
  it("a question after סבבה is dropped", () => {
    const d = "מעולה, יש מעיל צמר ארוך. רוצה לראות עוד?";
    const v = checkReplyStyle(d, ctx({ incomingMessage: "סבבה" }));
    expect(v.map((x) => x.kind)).toContain("push_after_ack");
    expect(fixInCode(d, v)).toBe("מעולה, יש מעיל צמר ארוך.");
  });
  it("English titles in the sentence are not ours to fix: the rewrite stays for them", () => {
    expect(FIXED_IN_CODE.has("ungrounded_price")).toBe(false);
    const d = "Cotton Trench Coat מתאים ליום יום; Wool Blend Overcoat ארוך ואלגנטי.";
    const v = checkReplyStyle(d, ctx({ productTitles: ["Cotton Trench Coat", "Wool Blend Overcoat"] }));
    expect(checkReplyStyle(fixInCode(d, v), ctx({ productTitles: ["Cotton Trench Coat", "Wool Blend Overcoat"] })).map((x) => x.kind)).toContain("latin_titles");
  });
});

describe("the cards follow the products the draft named", () => {
  const cand = (n: number, title: string) => ({ ref: `PRODUCT_${n}`, productId: String(300 + n), title, price: 799, currency: "ILS", available: true } as any);
  const envelope: any = { status: "ok", provider: "woocommerce", candidates: [cand(1, "Cotton Trench Coat"), cand(2, "Wool Blend Overcoat")] };
  const base = { envelope, channelSupportsCards: true, alreadyStaged: false, locale: "he" as const, budget: null, maxProducts: 4, unnamedAllowed: false };
  it("the rewrite says them in Hebrew: the draft's keys still pick them", () => {
    const plan = planAutoRecommendation({ ...base, modelText: "טרנץ' קליל ומעיל צמר ארוך ואלגנטי.", namingText: "PRODUCT_1 ו-PRODUCT_2" } as any);
    expect(plan.shouldSendStructured).toBe(true);
    expect(plan.selected.map((c: any) => c.productId)).toEqual(["301", "302"]);
  });
  it("without the draft: not named, no cards (as before)", () => {
    const plan = planAutoRecommendation({ ...base, modelText: "טרנץ' קליל ומעיל צמר ארוך ואלגנטי." } as any);
    expect(plan.skipReason).toBe("not_named");
  });
});

describe("\"תראה לי\" asks for cards", () => {
  for (const t of ["לא יודע תראה לי", "תראי לי מה יש", "show me", "אפשר להראות?"]) it(t, () => expect(SHOW_ME.test(t)).toBe(true));
  for (const t of ["המעיל מראה טוב", "סבבה", "איזה מבצעים קיימים היום?"]) it(`not: ${t}`, () => expect(SHOW_ME.test(t)).toBe(false));
});

describe("wired", () => {
  const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("the plan context, the keyed facts and the discovery extraction run side by side", () => {
    expect(bot).toContain("const planContextP = assemblePlanContext({");
    expect(bot).toContain("const [planContext, fullSessionFacts] = await Promise.all([planContextP, sessionFacts.full]);");
    expect(bot).toContain("prefetched: discoveryPrefetch,");
    expect(bot.indexOf("const discoveryPrefetch =")).toBeLessThan(bot.indexOf("const [planContext, fullSessionFacts]"));
  });
  it("the in-code fix runs before any regeneration; the naming draft reaches the cards", () => {
    expect(bot.indexOf("fixInCode(replyText, violations)")).toBeLessThan(bot.indexOf('metadata: { type: "ai_bot_style_regen"'));
    expect(bot).toContain("namingText: namingDraft,");
    expect(bot).toContain('SHOW_ME.test(opts.incomingMessage ?? "")');
  });
  it("nothing sent: the once is not spent (all three paths)", () => {
    const turn = readFileSync(join(__dirname, "../services/woo-chat-turn.service.ts"), "utf8");
    expect(turn).toContain("await releaseCrossSell(o.conversationId, o.productId);");
    expect(bot).toContain("await releaseCrossSell(opts.conversationId, anchorId);");
    expect(bot).toContain("if (!out.ok || !out.result.length) await releaseCrossSell(opts.conversationId, anchorId);");
  });
});

describe("the cached prefix", () => {
  const AGENT: any = { name: "נועה", role: "custom", tone: "friendly", style: {}, identity: { company: "Urban" }, goals: {}, toneConfig: {}, behavioral: {}, persona: {}, conversationFlow: null, customGuardrails: null, escalationRules: null, behavioralAnchors: null };
  const prompt = (turns: number) => buildAgentPrompt({
    behaviorState: computeBehaviorState({ mode: "agent", identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 }, request: { lastMessage: "אני רוצה מעיל", messageCount: turns, recentInboundTexts: ["אני רוצה מעיל"] } } as any),
    agent: AGENT,
    context: { customerBlock: "## Customer\n- Channel: webchat", memoryBlock: `## Memory\nKnown facts:\n- stated_need: "מעיל"\nTurn count: ${turns}`, locale: "he" },
    knowledge: {},
    toolFunctionNames: ["woocommerce.list_products", "escalate_to_human"],
  } as any);
  it("the memory block's turn count does not break it", () => {
    expect(stablePrefixOf(prompt(1))).toEqual(stablePrefixOf(prompt(4)));
    expect(stablePrefixOf(prompt(4))).not.toContain("Turn count");
    expect(prompt(4)).toContain("Turn count: 4");
  });
  it("the quality contract and the shop floor are in it; the style rules are still last", () => {
    const p = prompt(4);
    expect(stablePrefixOf(p)).toContain("# Response Quality Contract");
    expect(stablePrefixOf(p)).toContain("# The shop floor");
    expect(p.lastIndexOf("# Style (read last, follow exactly)")).toBeGreaterThan(p.lastIndexOf("# Knowledge"));
  });
});
