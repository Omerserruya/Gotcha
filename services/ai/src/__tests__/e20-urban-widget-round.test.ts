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
  it("a push after סבבה is dropped", () => {
    const d = "מעולה, יש מעיל צמר ארוך. להוסיף אותו לסל?";
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

// ── The rerun (dev 2026-10-27, urban-e21) ────────────────────────────────────
import { polishReply, asksToResend, sendAgainLine, choiceAckLine } from "../services/reply-style-check.service";

describe("e21: the choice is acknowledged in plain Hebrew", () => {
  it("the line, then the add-ons; the calque is a banned phrase", () => {
    expect(choiceAckLine("he")).toBe("בחירה מצוינת!");
    expect(kinds("מעולה, לקחתי נקודת התחלה: המעיל.")).toContain("banned_phrase");
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("replyText = `${choiceAckLine(replyLocale)}\\n${goesWellWithLine(replyLocale)}`;");
  });
});

describe("e21: \"סבבה\" after an open question", () => {
  const draft = "מעולה, מעדיפים את הטרנץ' הקז'ואלי או את מעיל הצמר הארוך?";
  it("asking the open thing again is the nudge, not a push", () => {
    expect(kinds(draft, { incomingMessage: "סבבה", openQuestion: true })).not.toContain("push_after_ack");
  });
  it("after an answer that asked nothing, a push to buy still is; a plain question is not (urban-e23)", () => {
    expect(kinds("מעולה. להוסיף את המעיל לסל?", { incomingMessage: "סבבה", openQuestion: false })).toContain("push_after_ack");
    expect(kinds(draft, { incomingMessage: "סבבה", openQuestion: false })).not.toContain("push_after_ack");
  });
  it("wired from our last text reply, not the cards", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("openQuestion: /[?؟]\\s*\\S{0,3}\\s*$/.test(");
  });
});

describe("e21: \"שלח לי\" sends the last cards again", () => {
  for (const t of ["שלח לי", "תשלח לי", "שלחי לי אותם", "send me"]) it(t, () => expect(asksToResend(t)).toBe(true));
  for (const t of ["שלח לי פרטים על המשלוח לאילת בבקשה", "אני מחפש מעיל", "משלוח"]) it(`not: ${t}`, () => expect(asksToResend(t)).toBe(false));
  it("the line, and wired before the add-ons", () => {
    expect(sendAgainLine("he")).toBe("הנה שוב:");
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot.indexOf("asksToResend(opts.incomingMessage)")).toBeGreaterThan(0);
    expect(bot.indexOf("asksToResend(opts.incomingMessage)")).toBeLessThan(bot.indexOf("commitsToBuy(opts.incomingMessage)) {"));
  });
});

describe("e21: with cards out, the store's titles leave the Hebrew sentence", () => {
  const titles = ["Cotton Trench Coat", "Wool Blend Overcoat"];
  const polish = (t: string) => polishReply(t, { locale: "he", productTitles: titles, cardsShown: true });
  it("after its Hebrew description", () => {
    expect(polish("מעולה, מצאתי שני מעילים שעשויים להתאים: מעיל טרנץ' קליל, Cotton Trench Coat, ומעיל תערובת צמר ארוך ואלגנטי, Wool Blend Overcoat. איזה צבע או גזרה מעניין אותך?"))
      .toBe("מעולה, מצאתי שני מעילים שעשויים להתאים: מעיל טרנץ' קליל, ומעיל תערובת צמר ארוך ואלגנטי. איזה צבע או גזרה מעניין אותך?");
  });
  it("one title inside the sentence, or leading it", () => {
    expect(polish("המעיל Wool Blend Overcoat מתאים לגברים. איזו מידה בדרך כלל מתאימה לך?")).toBe("המעיל מתאים לגברים. איזו מידה בדרך כלל מתאימה לך?");
    expect(polish("הנה אופציה שמתאימה לגברים: Wool Blend Overcoat, גזרה אלגנטית וחמימה.")).toBe("הנה אופציה שמתאימה לגברים: גזרה אלגנטית וחמימה.");
    expect(polish("Cotton Trench Coat - טרנץ' קל ליום יום.")).toBe("טרנץ' קל ליום יום.");
  });
  it("no cards: the titles stay", () => {
    expect(polishReply("המעיל Wool Blend Overcoat מתאים לגברים.", { locale: "he", productTitles: titles, cardsShown: false })).toContain("Wool Blend Overcoat");
  });
});

describe("e21: promotions", () => {
  it("each of them is the answer: three sentences, a hello not counted", () => {
    const t = "היי! יש קוד WELCOME10 שמעניק 10% הנחה (בתוקף עד 30.09.2027). בנוסף, משלוח חינם בישראל בהזמנות מעל ₪299. והחזרות חינם עד 30 יום.";
    expect(kinds(t, { isFirstReply: true, incomingMessage: "איזה מבצעים קיימים היום?", productFactsAvailable: false, groundingText: "₪299" })).not.toContain("too_long");
  });
  it("\"קיים קוד\" is said \"יש קוד\"", () => {
    expect(polishReply("קיים קוד WELCOME10, 10% הנחה.", { locale: "he" })).toBe("יש קוד WELCOME10, 10% הנחה.");
  });
  it("a one-line question that is not about promotions keeps two", () => {
    expect(kinds("משלוח בארץ 2-4 ימים ב-₪29. איסוף מהסטודיו בחינם. לחו\"ל 5-8 ימים.", { incomingMessage: "כמה עולה משלוח?" })).toContain("too_long");
  });
});

describe("e21: the knowledge retrieval overlaps the judgement calls", () => {
  it("started after them, read only later", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot.indexOf("const chunks = await retrieveRelevantChunks(")).toBeGreaterThan(bot.indexOf("discoveryPrefetch?.catch(() => undefined);"));
    expect(bot.indexOf("const chunks = await retrieveRelevantChunks(")).toBeLessThan(bot.indexOf("const [planContext, fullSessionFacts]"));
  });
});

// ── The second rerun (dev 2026-10-27, urban-e22) ─────────────────────────────
import { tidyFragments, finalizeRewrite, addsNothing } from "../services/reply-style-check.service";
import { validateActionHonesty, stripUnsupportedDelegation } from "../services/action-honesty.service";

describe("e22: what a removed title leaves behind", () => {
  it("a dangling \"למשל\" goes", () => {
    expect(tidyFragments("טוב, יש מעיל שמתאים לגבר, למשל.\nאיזו מידה מתאימה לך?")).toBe("טוב, יש מעיל שמתאים לגבר.\nאיזו מידה מתאימה לך?");
  });
  it("a sentence ending on \"את\" goes; a trailing comma goes", () => {
    expect(tidyFragments("מצאתי מעיל אחד. אפשר לראות את. איזה צבע?")).toBe("מצאתי מעיל אחד. איזה צבע?");
    expect(tidyFragments("הנה שתי אופציות,")).toBe("הנה שתי אופציות");
  });
  it("after the title strip with cards out", () => {
    expect(polishReply("טוב, יש עכשיו מעיל שמתאים לגבר, למשל Wool Blend Overcoat.", { locale: "he", productTitles: ["Wool Blend Overcoat"], cardsShown: true }))
      .toBe("טוב, יש עכשיו מעיל שמתאים לגבר.");
  });
  it("\"הראינו\" and \"נמצא שני\" are calques: rewritten", () => {
    expect(kinds("טוב, הראינו עכשיו מעיל שמתאים לגבר.")).toContain("banned_phrase");
    expect(kinds("היי, נמצא שני מעילים שמתאימים כאן.", { isFirstReply: true })).toContain("banned_phrase");
    expect(kinds("לא נמצא מעיל במידה הזאת.")).not.toContain("banned_phrase");
  });
});

describe("e22: a gendered echo question after a dash", () => {
  it("\"הי — מחפש מעיל?\" is caught", () => {
    expect(kinds("הי — מחפש מעיל? יש שתי אופציות.", { isFirstReply: true })).toContain("gendered_address");
  });
  it("kept by a rewrite: its sentence goes", () => {
    const out = finalizeRewrite("הי — מחפש מעיל? יש שתי אופציות: טרנץ' קליל או מעיל צמר חם.", ctx({ isFirstReply: true }));
    expect(out.text).toBe("יש שתי אופציות: טרנץ' קליל או מעיל צמר חם.");
    expect(out.fixed).toContain("gendered_dropped");
  });
});

describe("e22: promotions keep free shipping and the code's separator", () => {
  const reply = "כרגע יש קוד מבצע: welcome10 — 10% הנחה. בנוסף האתר מציין משלוח חינם בקנייה מעל ₪299.";
  it("\"בנוסף\" is not a claimed write (\"נוסף\" inside it)", () => {
    expect(validateActionHonesty(reply, [] as any, { hasBackgroundJob: false }).unsupported.map((c) => c.kind)).not.toContain("performed");
    expect(stripUnsupportedDelegation(reply)).toBeNull();
  });
  it("a real claimed write still is", () => {
    expect(validateActionHonesty("הפרטים נוספו להזמנה.", [] as any, { hasBackgroundJob: false }).unsupported.map((c) => c.kind)).toContain("performed");
    expect(validateActionHonesty("עדכנתי את ההזמנה.", [] as any, { hasBackgroundJob: false }).unsupported.map((c) => c.kind)).toContain("performed");
  });
  it("a code and what it gives: a colon, not a dash the outbox reads as a range", () => {
    expect(polishReply(reply, { locale: "he" })).toContain("welcome10: 10% הנחה");
  });
});

describe("e22: the binding verdict is reused when the turn adds nothing it reads", () => {
  it("an acknowledgement or an emoji adds nothing; words do", () => {
    for (const t of ["סבבה", "אוקיי", "👍", "תודה!"]) expect(addsNothing(t), t).toBe(t !== "תודה!");
    expect(addsNothing("לא יודע תראה לי")).toBe(false);
  });
  it("wired around the call, remembered only after a real evaluation", () => {
    const src = readFileSync(join(__dirname, "../services/plan-context.service.ts"), "utf8");
    expect(src).toContain("const reused = await reusableWizardFacts(input.conversationId, bindingFingerprint, inbound);");
    expect(src).toContain("reused ?? await evaluateWizardBinding({");
    expect(src).toContain("if (!(facts as any)?.evaluated) return;");
  });
});

// ── The third rerun (urban-e23): prevent, then one final gate ─────────────────
import { takeShowLine, normalizePunctuation, finalTextIssues, dropBrokenSentences, safeTurnLine, type FinalGateContext } from "../services/reply-style-check.service";
import { buildKeyedModelSummary } from "../services/product-search.service";

const gate = (o: Partial<FinalGateContext> = {}): FinalGateContext => ({ ...ctx({ shopFloor: false, isFirstReply: false }), cardsShown: true, productTitles: ["Cotton Trench Coat", "Wool Blend Overcoat"], ...o });

describe("e23: the products to show ride on a SHOW line, never in a sentence", () => {
  it("the line goes, its keys stay for the cards", () => {
    expect(takeShowLine("טרנץ' קליל ליום יום, או מעיל צמר ארוך.\nSHOW: PRODUCT_1, PRODUCT_2")).toEqual({ text: "טרנץ' קליל ליום יום, או מעיל צמר ארוך.", keys: ["PRODUCT_1", "PRODUCT_2"] });
    expect(takeShowLine("אין שורה כזאת.")).toEqual({ text: "אין שורה כזאת.", keys: [] });
  });
  it("the search result tells the model so on a card channel, and only there", () => {
    const env: any = { status: "ok", provider: "woocommerce", tool: "woocommerce.list_products", appliedFilters: [], unavailableFilters: [], safeModelSummary: "", candidates: [{ ref: "PRODUCT_1", productId: "1", title: "Cotton Trench Coat", price: 799, currency: "ILS", available: true, unknownAttributes: [], attributes: {} }] };
    expect(buildKeyedModelSummary(env, "he", true)).toContain("SHOW: PRODUCT_1, PRODUCT_2");
    expect(buildKeyedModelSummary(env, "he", true)).toContain("NEVER write a key (PRODUCT_1) or the store's title inside a sentence");
    expect(buildKeyedModelSummary(env, "he", false)).not.toContain("SHOW:");
  });
  it("wired: read at model_done and after a rewrite, the keys pick the cards", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).toContain("const showLine = takeShowLine(replyText);");
    expect(bot).toContain("const regenShow = takeShowLine(regen.content.trim());");
    expect(bot).toContain("buildKeyedModelSummary(envlp, replyLocale, cardChannel)");
  });
});

describe("e23: the punctuation removals leave behind is normalised", () => {
  for (const [a, b] of [
    ["יש שני מעילים שמתאימים כרגע לצפייה -, האחד בסגנון טרנץ' קל.", "יש שני מעילים שמתאימים כרגע לצפייה, האחד בסגנון טרנץ' קל."],
    ["שתי אופציות שמתאימות:, טרנץ׳ קלאסי, מעיל תערובת צמר.", "שתי אופציות שמתאימות: טרנץ׳ קלאסי, מעיל תערובת צמר."],
    [", מעיל צמר ארוך ,.", "מעיל צמר ארוך."],
    ["מעיל  צמר :.", "מעיל צמר."],
  ] as const) it(a, () => expect(normalizePunctuation(a)).toBe(b));
});

describe("e23: what the gate does not let through", () => {
  it("a verbless question: its sentence goes", () => {
    const t = "יש שני מעילים שמתאימים כרגע לצפייה, האחד בסגנון טרנץ' קל והשני מעיל צמר כבד. באיזו מידה בדרך כלל?";
    expect(finalTextIssues(t, gate())).toContain("verbless_question");
    expect(dropBrokenSentences(t, gate())).toBe("יש שני מעילים שמתאימים כרגע לצפייה, האחד בסגנון טרנץ' קל והשני מעיל צמר כבד.");
  });
  it("a gendered question on the final text: its sentence goes", () => {
    const t = "מעולה, יש מעיל ג'ינס קצר, מעיל קל ומעיל צמר ארוך ואלגנטי. מעדיף סגנון קז'ואל או אלגנטי?";
    expect(finalTextIssues(t, gate())).toContain("gendered");
    expect(dropBrokenSentences(t, gate())).toBe("מעולה, יש מעיל ג'ינס קצר, מעיל קל ומעיל צמר ארוך ואלגנטי.");
  });
  it("\"הנה\" over no cards; a store title or a key beside cards; a dangling word", () => {
    expect(finalTextIssues("הנה שתי אופציות שמתאימות.", gate({ cardsShown: false }))).toContain("points_at_nothing");
    expect(finalTextIssues("הנה שתי אופציות שמתאימות.", gate({ cardsShown: true }))).toEqual([]);
    expect(finalTextIssues("המעיל Wool Blend Overcoat מתאים.", gate())).toContain("title");
    expect(finalTextIssues("יש את PRODUCT_1.", gate())).toContain("key");
    expect(finalTextIssues("יש מעיל שמתאים לגבר, למשל.", gate())).toContain("dangling");
  });
  it("our own lines pass", () => {
    for (const t of ["הנה שוב:", "בחירה מצוינת!\nזה הולך מצוין עם:", "הנה כמה אפשרויות שיכולות להתאים:"]) expect(finalTextIssues(t, gate()), t).toEqual([]);
    expect(finalTextIssues("בכיף 🙂", gate({ customerClosing: true, cardsShown: false }))).toEqual([]);
  });
  it("the safe line for the turn", () => {
    expect(safeTurnLine("he", { cardsShown: true, cardCount: 2 })).toBe("הנה כמה אפשרויות שיכולות להתאים:");
    expect(safeTurnLine("he", { cardsShown: true, cardCount: 1 })).toBe("הנה אפשרות שיכולה להתאים:");
    expect(safeTurnLine("he", { cardsShown: false, cardCount: 0 })).toBe("אפשר לפרט קצת יותר מה מחפשים?");
  });
  it("wired after every transform that removes text, before the output validator", () => {
    const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    const g = bot.indexOf("const issues = finalTextIssues(replyText, gateCtx);");
    expect(g).toBeGreaterThan(bot.indexOf("const guarded = guardCustomerReply(replyText, {"));
    expect(g).toBeGreaterThan(bot.indexOf("replyText = humanizeReply(replyText);"));
    expect(g).toBeLessThan(bot.indexOf("await validateAndPersist(replyText, {"));
  });
});

describe("e23: promotions", () => {
  it("an ISO date in a Hebrew reply is written day.month.year", () => {
    expect(polishReply("בתוקף עד 2027-09-30.", { locale: "he" })).toBe("בתוקף עד 30.09.2027.");
  });
  it("the coupon block: the date as written here, and standing offers count", async () => {
    const { buildCouponPromotionsDirective } = await import("../services/product-intent.service");
    const d = buildCouponPromotionsDirective([{ code: "welcome10", amount: "10", discountType: "percent", expiresAt: "2027-09-30T00:00:00", minimumAmount: null }]);
    expect(d).toContain("welcome10: 10% off, until 30.09.2027");
    expect(d).toContain("free shipping above an amount");
  });
});
