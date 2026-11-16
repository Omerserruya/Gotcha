/**
 * Reply engine v2: the pure parts (respond parsing, state merge, Gate 3, the
 * turn envelope's key numbering, the switch).
 */
import { describe, it, expect, afterEach } from "vitest";
import { parseRespond, resolveKeysInText, conversationLocale, stripLaterOpener, resolveProductId } from "../services/reply-engine/engine";
import { needlessHandoff } from "../services/reply-engine/gates";
import { readErrored, outcomeOf } from "../services/reply-engine/tools";
import { mergeState, emptyState, renderState } from "../services/reply-engine/state";
import { gate3, unknownProductKeys, correctionNote, safeFallback, groundedProductFallback, unreadProduct } from "../services/reply-engine/gates";
import { mergeEnvelope, newTurnTools } from "../services/reply-engine/tools";
import { replyEngineMode, engineConfig } from "../services/reply-engine/flags";

const baseG3 = {
  claims: [],
  cards: [] as string[],
  candidateCount: 0,
  tools: [],
  grounding: "",
  locale: "he" as const,
  incomingMessage: "יש לכם תיק בד?",
  isFirstReply: false,
  employeeGender: null,
  employeeName: "נועה",
  toolsOffered: ["woocommerce.list_products", "respond"],
  shopFloor: true,
  handedOff: false,
  approvalPending: false,
};

describe("parseRespond", () => {
  it("reads reply, state, claims, handoff and cards", () => {
    const o = parseRespond(JSON.stringify({
      reply: "יש!",
      state_update: { stage: "choosing", intent: "תיק בד", facts: { budget: 100 }, pending: [] },
      claims: [{ kind: "price", text: "₪79", source: "call_1" }, { kind: "weird", text: "x" }, { nope: 1 }],
      handoff: null,
      cards: ["PRODUCT_1", 3],
    }));
    expect(o?.reply).toBe("יש!");
    expect(o?.stateUpdate.facts).toEqual({ budget: 100 });
    expect(o?.claims.map((c) => c.kind)).toEqual(["price", "fact"]);
    expect(o?.handoff).toBeNull();
    expect(o?.cards).toEqual(["PRODUCT_1"]);
  });
  it("is null without a reply string or on bad JSON", () => {
    expect(parseRespond("{}")).toBeNull();
    expect(parseRespond("not json")).toBeNull();
  });
  it("a blank handoff is no handoff", () => {
    expect(parseRespond(JSON.stringify({ reply: "x", handoff: "  " }))?.handoff).toBeNull();
  });
});

describe("keys and language", () => {
  it("never lets PRODUCT_n reach the customer", () => {
    expect(resolveKeysInText("יש PRODUCT_1 ו-PRODUCT_2, וגם PRODUCT_9", [{ title: "Canvas Tote" }, { title: "Leather Bag" }]))
      .toBe("יש Canvas Tote ו-Leather Bag, וגם PRODUCT_9");
  });
  it("follows the customer's own recent words", () => {
    expect(conversationLocale(["hi", "יש לכם?"])).toBe("he");
    expect(conversationLocale(["שלום", "a", "b", "c", "do you ship?"])).toBe("en");
  });
});

describe("later openers (eval lint: \"כן, ...\" after the first reply)", () => {
  it("strips a filler opener after our first reply, keeps it on the first", () => {
    expect(stripLaterOpener("כן, יש במלאי במידה M.", true)).toBe("יש במלאי במידה M.");
    expect(stripLaterOpener("בטח! מה מספר ההזמנה?", true)).toBe("מה מספר ההזמנה?");
    expect(stripLaterOpener("היי! מה מחפשים?", false)).toBe("היי! מה מחפשים?");
    expect(stripLaterOpener("כן.", true)).toBe("כן.");
    expect(stripLaterOpener("כנראה שכן", true)).toBe("כנראה שכן");
  });
});

describe("product_id resolution (eval: titles and stale keys reached the store as 404s)", () => {
  const env = { candidates: [{ title: "Canvas Tote", productId: "101" }, { title: "Zip Hoodie", productId: "102" }] };
  const offered = [{ title: "Chunky Cardigan", productId: "77" }, { title: "Linen Midi Dress", productId: "88" }];
  it("ids pass, this turn's keys and titles resolve, earlier products resolve by title", () => {
    expect(resolveProductId("555", env, offered)).toBe("555");
    expect(resolveProductId("PRODUCT_2", env, offered)).toBe("102");
    expect(resolveProductId("zip hoodie", env, offered)).toBe("102");
    expect(resolveProductId("Linen Midi Dress", null, offered)).toBe("88");
  });
  it("a stale key or an unknown name is null (the caller searches; never sent to the store as an id)", () => {
    expect(resolveProductId("PRODUCT_7", env, offered)).toBeNull();
    expect(resolveProductId("Merino Crew Knit", env, offered)).toBeNull();
  });
});

describe("handoffs only when called for", () => {
  it("an explicit ask, a damaged item, a late order or a strong complaint allow one", () => {
    expect(needlessHandoff("x", ["אפשר לדבר עם נציג?"], false)).toBe(false);
    expect(needlessHandoff("x", ["המעיל הגיע קרוע"], false)).toBe(false);
    expect(needlessHandoff("x", ["ההזמנה עדיין לא הגיעה"], false)).toBe(false);
    expect(needlessHandoff("x", ["I want to talk to a human"], false)).toBe(false);
  });
  it("a discount, instalments, care, \"are you a bot\" or a failed tool do not", () => {
    expect(needlessHandoff("x", ["יש הנחה?"], false)).toBe(true);
    expect(needlessHandoff("x", ["אפשר לשלם בתשלומים?"], false)).toBe(true);
    expect(needlessHandoff("x", ["את בוט?"], false)).toBe(true);
    expect(needlessHandoff(null, ["יש הנחה?"], false)).toBe(false);
    expect(needlessHandoff("x", ["יש הנחה?"], true)).toBe(false);
  });
});

describe("tool outcomes", () => {
  it("errors, empties and plain results", () => {
    expect(readErrored("PRODUCT_SEARCH_FAILED: the live catalog could not be read")).toBe(true);
    expect(readErrored('{"ok":false,"failure":"errored","reason":"woocommerce_404"}')).toBe(true);
    expect(readErrored("PRODUCT_SEARCH_RESULTS: 0 products matched.")).toBe(false);
    expect(outcomeOf("allow", "PRODUCT_SEARCH_RESULTS: 0 products matched.", 0)).toBe("empty");
    expect(outcomeOf("allow", "PRODUCT_1 ...", 3)).toBe("ok");
    expect(outcomeOf("deny", "")).toBe("denied");
  });
});

describe("mergeState", () => {
  it("adds, keeps and removes facts; replaces pending; bounds sizes", () => {
    const prev = { ...emptyState(), facts: { size: "M", name: "דנה" }, stage: "browsing" };
    const next = mergeState(prev, { facts: { size: null, budget: 300 }, pending: [{ kind: "promise", text: "לבדוק מלאי", tool: null as any }] });
    expect(next.facts).toEqual({ name: "דנה", budget: 300 });
    expect(next.stage).toBe("browsing");
    expect(next.pending).toHaveLength(1);
    expect(next.turnCount).toBe(1);
  });
  it("an absent stage keeps the old one, a null clears it", () => {
    const prev = { ...emptyState(), stage: "choosing" };
    expect(mergeState(prev, {}).stage).toBe("choosing");
    expect(mergeState(prev, { stage: null }).stage).toBeNull();
  });
  it("offered items: one per product, a re-show moves it last", () => {
    const at = "2026-11-16T00:00:00Z";
    let s = mergeState(emptyState(), {}, { offered: [{ ref: "a", title: "A", productId: "1", at }, { ref: "b", title: "B", productId: "2", at }] });
    s = mergeState(s, {}, { offered: [{ ref: "a", title: "A", productId: "1", at }] });
    expect(s.offeredItems.map((o) => o.title)).toEqual(["B", "A"]);
  });
  it("an approval stays open until the model restates the list", () => {
    const s = mergeState(emptyState(), {}, { approvals: [{ kind: "approval", text: "waiting", tool: "refund", at: "x" }] });
    expect(s.pending.map((p) => p.kind)).toEqual(["approval"]);
  });
  it("renders a first turn plainly", () => {
    expect(renderState(emptyState())).toMatch(/first turn/);
  });
});

describe("Gate 3", () => {
  it("passes a grounded, neutral reply", () => {
    const v = gate3({ ...baseG3, reply: "יש תיק בד קנבס ב‑₪79, מתאים לך?", grounding: "Canvas Tote price ILS 79 ₪79" });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });
  it("fails a price no tool gave", () => {
    const v = gate3({ ...baseG3, reply: "התיק עולה ₪120.", grounding: "Canvas Tote ₪79" });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.kind === "ungrounded_price")).toBe(true);
  });
  it("an em dash is not a rewrite reason (humanizeReply fixes it before send)", () => {
    const v = gate3({ ...baseG3, reply: "יש במלאי \u2014 מתאים לך?", grounding: "" });
    expect(v.problems.filter((p) => p.kind === "style")).toEqual([]);
  });
  it("fails a gendered address to the customer", () => {
    const v = gate3({ ...baseG3, reply: "את רוצה שאבדוק?", grounding: "" });
    expect(v.ok).toBe(false);
  });
  it("fails an empty reply", () => {
    expect(gate3({ ...baseG3, reply: "  " }).ok).toBe(false);
  });
  it("products are checked by KEY, never by name (eval 2026-11-16: Hebrew names for English titles)", () => {
    expect(unknownProductKeys([{ kind: "product", text: "PRODUCT_4" }], [], 3)).toEqual(["PRODUCT_4"]);
    expect(unknownProductKeys([{ kind: "product", text: "PRODUCT_2" }], ["PRODUCT_3"], 3)).toEqual([]);
    expect(unknownProductKeys([], ["PRODUCT_9"], 3)).toEqual(["PRODUCT_9"]);
    // A translated name is not a fact to verify on its own.
    expect(unknownProductKeys([{ kind: "product", text: "טרנץ' כותנה דוחה מים" }], [], 2)).toEqual([]);
    const v = gate3({ ...baseG3, reply: "יש טרנץ' כותנה דוחה מים, מתאים לך?", claims: [{ kind: "product", text: "טרנץ' כותנה דוחה מים" }], candidateCount: 2 });
    expect(v.ok).toBe(true);
  });
  it("the product fallback is the turn's own products with store prices, in stock only", () => {
    const c = [{ title: "Canvas Tote", price: 79, currency: "ILS", inventoryState: "in_stock" }, { title: "Old Bag", price: 50, inventoryState: "out_of_stock" }];
    const text = groundedProductFallback(c, "he", false)!;
    expect(text).toContain("Canvas Tote, ₪79");
    expect(text).not.toContain("Old Bag");
    expect(groundedProductFallback(c, "he", true)).toBe("הנה מה שיש לנו שמתאים.");
    expect(groundedProductFallback([], "he", false)).toBeNull();
    expect(gate3({ ...baseG3, reply: groundedProductFallback(c, "he", true)!, grounding: "" }).ok).toBe(true);
  });
  it("the correction names each problem; the fallback is neutral and dashless", () => {
    const note = correctionNote([{ kind: "ungrounded_price", prices: ["120"] }, { kind: "unknown_product", names: ["PRODUCT_7"] }], "he");
    expect(note).toMatch(/120/);
    expect(note).toMatch(/PRODUCT_7/);
    expect(safeFallback("he")).not.toMatch(/[–—]/);
    expect(gate3({ ...baseG3, reply: safeFallback("he") }).problems.filter((p) => p.kind === "style")).toEqual([]);
  });
});

describe("legacy phrasing rules, ported (eval 2026-11-16)", () => {
  const codes = (reply: string) => (gate3({ ...baseG3, reply, grounding: "" }).problems.find((p) => p.kind === "style") as any)?.codes ?? [];
  it("search narration fails; an honest not-found does not", () => {
    expect(codes("מצאתי ג׳ינס כחול, מתאים לך?")).toContain("found_narration");
    expect(codes("לא מצאתי את זה בשם הזה, אפשר לנסות לפי סוג?")).not.toContain("found_narration");
  });
  it("card narration fails", () => {
    expect(codes("הכרטיס שלו מופיע כאן, מתאים לך?").length).toBeGreaterThan(0);
  });
  it("\"שים לב\" and \"מעדיף\" fail", () => {
    expect(codes("שים לב שזה במבצע")).toContain("imperative_notice");
    expect(codes("מה מעדיף, שחור או אפור?")).toContain("gendered_prefers");
  });
});

describe("an attribute question reads the product first (eval A08: \"הסוודר מרינו מגרד?\")", () => {
  const offered = ["woocommerce.get_product", "respond"];
  it("\"no info\" without reading the product fails", () => {
    expect(unreadProduct("אין לי כאן מידע על זה, אפשר לבדוק מול הצוות", "הסוודר מרינו מגרד?", [], offered)).toBe(true);
  });
  it("after a read, or with no product tool, or on a non-attribute question, it passes", () => {
    const read = [{ callId: "c", tool: "woocommerce.get_product", args: {}, decision: "allow" as const, content: "", ms: 1 }];
    expect(unreadProduct("אין לי כאן מידע על זה", "הסוודר מרינו מגרד?", read, offered)).toBe(false);
    expect(unreadProduct("אין לי כאן מידע על זה", "הסוודר מרינו מגרד?", [], ["respond"])).toBe(false);
    expect(unreadProduct("אין לי כאן מידע על זה", "מתי אתם פתוחים?", [], offered)).toBe(false);
  });
});

describe("the turn envelope", () => {
  const env = (titles: string[]) => ({
    provider: "woocommerce", tool: "woocommerce_product_search", status: "ok",
    candidates: titles.map((t, i) => ({ title: t, productId: String(100 + i), inventoryState: "in_stock", url: "u", attributes: {}, unknownAttributes: [] })),
    appliedFilters: [], unavailableFilters: [], safeModelSummary: "",
  }) as any;
  it("a second search's keys continue after the first's", () => {
    const turn = newTurnTools();
    mergeEnvelope(turn, env(["A", "B"]), "en", false);
    const second = mergeEnvelope(turn, env(["C"]), "en", false);
    expect(second).toContain("PRODUCT_3");
    expect(second).not.toContain("PRODUCT_1");
    expect(turn.envelope?.candidates.map((c: any) => c.title)).toEqual(["A", "B", "C"]);
  });
});

describe("the switch", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it("is off by default and for an unknown value", () => {
    delete process.env.REPLY_ENGINE_MODE;
    expect(replyEngineMode("t1")).toBe("off");
    process.env.REPLY_ENGINE_MODE = "on";
    expect(replyEngineMode("t1")).toBe("off");
  });
  it("is per tenant", () => {
    process.env.REPLY_ENGINE_MODE = "autonomous";
    process.env.REPLY_ENGINE_TENANTS = "t1,t2";
    expect(replyEngineMode("t1")).toBe("autonomous");
    expect(replyEngineMode("t3")).toBe("off");
    process.env.REPLY_ENGINE_TENANTS = "*";
    expect(replyEngineMode("t3")).toBe("autonomous");
  });
  it("clamps its numbers", () => {
    process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS = "5";
    expect(engineConfig().toolTimeoutMs).toBe(8000);
  });
});
