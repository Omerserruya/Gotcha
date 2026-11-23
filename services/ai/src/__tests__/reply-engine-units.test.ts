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
    // Prod replay 2: photos and a number after Hebrew words are not English.
    expect(conversationLocale(["הכיסא הגיע שבור", "[Image]", "[Image]", "[Image]", "12345"])).toBe("he");
    expect(conversationLocale(["[Image]", "4417"], ["שלום, איך אפשר לעזור?"])).toBe("he");
    expect(conversationLocale(["[Image]", "ok"])).toBe("en");
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
    expect(groundedProductFallback(c, "he", true)).toBe("הנה כמה אפשרויות.");
    expect(groundedProductFallback([], "he", false)).toBeNull();
    // The card form goes out WITH its cards; without them it would name nothing (nameless_products).
    expect(gate3({ ...baseG3, reply: groundedProductFallback(c, "he", true)!, grounding: "", cards: ["PRODUCT_1"], candidateCount: 1 }).ok).toBe(true);
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
  it("a callback promise fails; the honest team line passes (eval arm5 C02, D01, E03)", () => {
    expect(codes("נחזור אליך עם תשובה בהקדם")).toContain("callback_promise");
    expect(codes("הצוות יחזרו אליך מחר")).toContain("callback_promise");
    expect(codes("אבדוק עם הצוות ונחזור אליך")).toContain("callback_promise");
    expect(codes("העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.")).toEqual([]);
    expect(codes(safeFallback("he"))).toEqual([]);
  });
  it("a gendered first person fails (eval K02 \"הייתי הולכת על\")", () => {
    expect(codes("הייתי הולכת על השחור")).toContain("self_gendered");
    expect(codes("אני ממליצה על המעיל")).toContain("self_gendered");
    expect(codes("הכי מתאים לך כאן השחור")).not.toContain("self_gendered");
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
  // A store id per product: the same product found again is not a new one (replay-e-fixes.test.ts).
  const env = (titles: string[]) => ({
    provider: "woocommerce", tool: "woocommerce_product_search", status: "ok",
    candidates: titles.map((t) => ({ title: t, productId: `id-${t}`, inventoryState: "in_stock", url: "u", attributes: {}, unknownAttributes: [] })),
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

// ── Prod replay 2026-11-16 (Smoovee + Tehila, 150 turns): three defect classes ──
import { simulationLeak, repeatedTeamLine, unreadOrder, unreadKnowledge } from "../services/reply-engine/gates";
import { openTeamQuestions, sameIssue } from "../services/reply-engine/engine";
import { asLiveResult, errorKindOf } from "../services/reply-engine/tools";

describe("damage is a legitimate handoff (the detector read the Hebrew)", () => {
  const damaged = [
    "הכיסא הגיע והרגליים לא מחוברות",
    "החלקים לא מחוברים אחד לשני",
    "המוצר הגיע מפורק",
    "הידית נשברה",
    "חסר בורג בקופסה",
    "חסרים שני חלקים בהזמנה",
    "הגיע הרוס לגמרי",
    "המנורה לא עובדת",
    "the lamp arrived cracked",
    "it came apart on day one",
  ];
  for (const m of damaged) {
    it(`"${m}" -> a handoff is allowed`, () => {
      expect(needlessHandoff("damaged item", [m], false)).toBe(false);
    });
  }
  it("photos sent right after the words do not push them out of the window", () => {
    expect(needlessHandoff("damaged item", ["הכיסא הגיע מפורק", "[Image]", "[Image]", "[Image]", "[Image]"], false)).toBe(false);
  });
  it("controls: stock and plain questions are still not a reason", () => {
    expect(needlessHandoff("x", ["זה חסר במלאי?"], false)).toBe(true);
    expect(needlessHandoff("x", ["אפשר לשלם בתשלומים?"], false)).toBe(true);
    expect(needlessHandoff("x", ["מה חסר לך כדי להחליט?"], false)).toBe(true);
  });
});

describe("no simulation note ever reaches a reply", () => {
  it("the leaked replay wording and its variants are caught", () => {
    for (const r of ["השליחה לא בוצעה בפועל בסביבת הבדיקה", "זו סימולציה", "This is a test conversation, so nothing was sent", "the action was simulated", "sandbox mode"]) {
      expect(simulationLeak(r)).toBe(true);
    }
    expect(simulationLeak("ההזמנה נשלחה היום, והיא אמורה להגיע עד יום חמישי.")).toBe(false);
    expect(simulationLeak("בדקתי את ההזמנה")).toBe(false);
  });
  it("gate3 flags it as style in every lane, and the correction says why", () => {
    const v = gate3({ reply: "הקופון לא נוצר בפועל בסביבת הבדיקה.", claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "יש קופון?", isFirstReply: false, employeeGender: null, employeeName: null, toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false });
    const style = v.problems.find((p: any) => p.kind === "style") as any;
    expect(style.codes).toContain("simulation_leak");
    expect(correctionNote(v.problems, "he")).toMatch(/Never mention a test/);
  });
  it("a simulated write is shown to the model as a live result: done, no note", () => {
    const shared = JSON.stringify({ ok: true, simulated: true, executed: false, tool: "send_whatsapp", note: "SIMULATION: this is a test conversation, so the action was not performed." });
    const out = asLiveResult("send_whatsapp", shared);
    expect(JSON.parse(out)).toEqual({ ok: true, tool: "send_whatsapp", status: "done" });
    expect(out).not.toMatch(/simulat|test|sandbox/i);
    expect(asLiveResult("x", "plain text: Simulated, nothing changed")).not.toMatch(/simulat/i);
    // A real result passes through untouched.
    expect(asLiveResult("x", JSON.stringify({ ok: true, id: 5 }))).toBe(JSON.stringify({ ok: true, id: 5 }));
  });
});

describe("one team question per open issue", () => {
  const state = { pending: [{ kind: "promise", text: "checking with the team: הלקוח מדווח שהכיסא הגיע פגום ושחסר בורג" }, { kind: "approval", text: "waiting for approval: x" }] };
  it("open team questions are read from the state's promises only", () => {
    expect(openTeamQuestions(state as any)).toEqual(["הלקוח מדווח שהכיסא הגיע פגום ושחסר בורג"]);
    expect(openTeamQuestions({ pending: [] } as any)).toEqual([]);
    expect(openTeamQuestions(null)).toEqual([]);
  });
  it("a reworded repeat is the same issue; a different question is not", () => {
    expect(sameIssue("הלקוח מדווח שהכיסא הגיע פגום ושחסר בורג", "הכיסא הגיע פגום וחסר בורג, הלקוח מחכה")).toBe(true);
    expect(sameIssue("הלקוח מדווח שהכיסא הגיע פגום ושחסר בורג", "הלקוח מדווח שהכיסא הגיע פגום ושחסר בורג")).toBe(true);
    expect(sameIssue("הלקוח מדווח שהכיסא הגיע פגום ושחסר בורג", "האם אפשר לשלם בתשלומים?")).toBe(false);
    // The model's shared frame is not one issue.
    expect(sameIssue("הלקוח שואל אם יש משלוח לאילת", "הלקוח שואל אם אפשר לשלם בתשלומים")).toBe(false);
    // Overlap without containment: six words each, two shared.
    expect(sameIssue("כיסא אלכסה שחור רגל שבורה תמונות", "החלפה כיסא אלכסה מתי מגיע שליח")).toBe(true);
  });
  it("saying again that it went to the team is flagged, unless the customer asks for news or it is a new question", () => {
    const line = "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.";
    expect(repeatedTeamLine(line, "ומה עם הצבע השני?", true, false)).toBe(true);
    expect(repeatedTeamLine("הצוות יבדוק את זה ויעדכן כאן.", "תודה", true, false)).toBe(true);
    expect(repeatedTeamLine(line, "יש עדכון?", true, false)).toBe(false);
    expect(repeatedTeamLine(line, "ומה עם הצבע השני?", true, true)).toBe(false);
    expect(repeatedTeamLine(line, "ומה עם הצבע השני?", false, false)).toBe(false);
    expect(repeatedTeamLine("יש לנו את זה גם בכחול.", "ומה עם הצבע השני?", true, false)).toBe(false);
  });
  it("the fallback does not announce a second hand-off", () => {
    expect(safeFallback("he", true)).not.toMatch(/העברתי/);
    expect(safeFallback("he", true)).toMatch(/כבר אצל הצוות/);
    expect(safeFallback("he")).toMatch(/העברתי/);
  });
});

describe("look before asking the team", () => {
  const offered = ["woocommerce.get_product", "woocommerce.list_products", "woocommerce.get_order", "search_knowledge"];
  const rec = (tool: string) => ({ callId: "c", tool, args: {}, decision: "allow", content: "{}", ms: 1 }) as any;
  it("colours of a product line, sent to the team without reading it -> unread_product", () => {
    expect(unreadProduct("העברתי לצוות", "באילו צבעים זה מגיע?", [], offered, true)).toBe(true);
    expect(unreadProduct("העברתי לצוות", "באילו צבעים זה מגיע?", [rec("woocommerce.get_product")], offered, true)).toBe(false);
  });
  it("a delivery date, sent to the team without the order tool -> unread_order", () => {
    expect(unreadOrder("העברתי לצוות", "מתי יגיע המשלוח?", [], offered, true)).toBe(true);
    expect(unreadOrder("העברתי לצוות", "מתי יגיע המשלוח?", [rec("woocommerce.get_order")], offered, true)).toBe(false);
    expect(unreadOrder("העברתי לצוות", "מתי יגיע המשלוח?", [], ["woocommerce.get_product"], true)).toBe(false);
    expect(unreadOrder("ההזמנה יצאה אתמול.", "מתי יגיע המשלוח?", [], offered, false)).toBe(false);
  });
  it("where to enter a coupon, sent to the team without the knowledge -> unread_knowledge", () => {
    expect(unreadKnowledge("איפה מזינים את הקופון?", [], offered, true)).toBe(true);
    expect(unreadKnowledge("איפה מזינים את הקופון?", [rec("search_knowledge")], offered, true)).toBe(false);
    expect(unreadKnowledge("איפה מזינים את הקופון?", [], offered, false)).toBe(false);
  });
  it("gate3 picks the right kind and the correction names the tool", () => {
    const base = { claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he" as const, isFirstReply: false, employeeGender: null, employeeName: null, toolsOffered: offered, shopFloor: true, handedOff: false, approvalPending: true, teamQuestion: true };
    const v = gate3({ ...base, reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", incomingMessage: "מתי יגיע המשלוח שלי?" });
    expect(v.problems.map((p: any) => p.kind)).toContain("unread_order");
    expect(correctionNote(v.problems, "he")).toMatch(/order or tracking tool/);
  });
});

describe("tool error kinds are codes, never text", () => {
  it("reads the result's code field", () => {
    expect(errorKindOf(JSON.stringify({ ok: false, failure: "errored", reason: "woocommerce_500" }))).toBe("woocommerce_500");
    expect(errorKindOf(JSON.stringify({ ok: false, code: "ORDER_NOT_FOUND" }))).toBe("order_not_found");
    expect(errorKindOf("PRODUCT_SEARCH_FAILED: x")).toBe("product_search_failed");
    expect(errorKindOf(JSON.stringify({ ok: false, statusCode: 401 }))).toBe("http_401");
  });
  it("free text (it may hold a customer's words) is never a kind", () => {
    expect(errorKindOf(JSON.stringify({ ok: false, error: "Order 1234 for Dana Levi not found" }))).toBe("error");
    expect(errorKindOf("not json at all")).toBe("error");
  });
});

describe("open team questions are the engine's, not the model's", () => {
  const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const prev = (pending: any[]) => ({ ...emptyState(), pending });
  it("the model's pending list cannot drop or re-stamp an open team question", () => {
    const open = { kind: "promise", text: "checking with the team: פגום וחסר בורג", at: at(5) };
    const next = mergeState(prev([open, { kind: "pending", text: "size", at: at(5) }]) as any, { pending: [{ kind: "promise", text: "checking with the team: פגום וחסר בורג" }, { kind: "pending", text: "colour" }] } as any);
    const team = next.pending.filter((p: any) => p.text.startsWith("checking with the team: "));
    expect(team).toHaveLength(1);
    expect(team[0].at).toBe(open.at);
    expect(next.pending.map((p: any) => p.text)).toContain("colour");
    expect(next.pending.map((p: any) => p.text)).not.toContain("size");
    expect(mergeState(prev([open]) as any, { pending: [] } as any).pending).toHaveLength(1);
  });
  it("after 72 hours it is no longer open", () => {
    const old = { kind: "promise", text: "checking with the team: x", at: at(73) };
    expect(mergeState(prev([old]) as any, { pending: [] } as any).pending).toHaveLength(0);
    expect(openTeamQuestions(prev([old]) as any)).toEqual([]);
    expect(openTeamQuestions(prev([{ ...old, at: at(71) }]) as any)).toEqual(["x"]);
  });
});

describe("tool errors from the prod replay", () => {
  it("a guard refusal's reason gives its leading code, never the text after it", () => {
    expect(errorKindOf(JSON.stringify({ ok: false, failure: "refused", reason: "access_denied: requester identity could not be resolved for this conversation" }))).toBe("access_denied");
    expect(errorKindOf(JSON.stringify({ ok: false, failure: "refused", reason: "selector_phone_not_owned:05*****12" }))).toBe("selector_phone_not_owned");
    expect(errorKindOf(JSON.stringify({ ok: false, failure: "refused", reason: "Dana Levi: no such order" }))).toBe("refused");
  });
  // Since 2026-11-18 one order's read IS retried once on a timeout (Smoovee 376b13); every other read is not.
  it("a read that timed out is not retried, except one order's own read (2 x 8s on Smoovee searches)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../services/reply-engine/tools.ts"), "utf8");
    const retry = src.slice(src.indexOf("let first: any = await attempt();"), src.indexOf("let first: any = await attempt();") + 600);
    expect(retry).toMatch(/if \(isRead && \(\(first === TIMEOUT && singleOrder\) \|\| \(first !== TIMEOUT && \("thrown" in first \|\| readErrored\(first\.r\?\.content\)\)\)\)\)/);
  });
});

describe("prod replay 2: what may stop a reply, and the cleanup", () => {
  it("only a price, a product or an action no tool backs is a FACT problem", async () => {
    const { factualProblems, FACTUAL_KINDS } = await import("../services/reply-engine/gates");
    expect([...FACTUAL_KINDS].sort()).toEqual(["card_reference", "claims_attachment", "dangling_reference", "derived_measure", "device_mismatch", "echoed_size", "inactive_order_unlabelled", "option_without_variation", "order_state_unread", "owner_never", "price_against_store", "price_of_other_product", "ungrounded_absence", "ungrounded_attribute", "ungrounded_negative_fit", "ungrounded_number", "ungrounded_payment", "ungrounded_positive_fit", "ungrounded_price", "ungrounded_source", "unknown_product", "unsafe_tip", "unsupported_action"]);
    expect(factualProblems([{ kind: "style", codes: ["found_narration"] }, { kind: "unread_product" }, { kind: "needless_handoff" }] as any)).toEqual([]);
  });
  it("cleanStyle fixes what code can fix and keeps the rest", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    expect(cleanStyle("מצאתי כמה תיקים. לא מצאתי אדום.", ["found_narration"])).toBe("יש כמה תיקים. לא מצאתי אדום.");
    expect(cleanStyle("אנחנו פתוחים עד 18:00. העברתי את השאלה לצוות.", ["repeated_team_line"])).toBe("אנחנו פתוחים עד 18:00.");
    expect(cleanStyle("ההזמנה נשלחה. זה לא בוצע בפועל בסביבת הבדיקה.", ["simulation_leak"])).toBe("ההזמנה נשלחה.");
    expect(cleanStyle("העברתי את השאלה לצוות.", ["repeated_team_line"])).toBe("");
    // A code not listed is not touched.
    expect(cleanStyle("מצאתי תיק", [])).toBe("מצאתי תיק");
  });
  it("isCannedTeamLine knows both forms in both languages, and nothing else", async () => {
    const { isCannedTeamLine, safeFallback } = await import("../services/reply-engine/gates");
    for (const l of ["he", "en"] as const) for (const open of [false, true]) expect(isCannedTeamLine(safeFallback(l, open))).toBe(true);
    expect(isCannedTeamLine("העברתי את השאלה לצוות.")).toBe(false);
  });
  it("engine facts (\"_\") are neither written by the model, trimmed, nor rendered", async () => {
    const { mergeState, emptyState, renderState } = await import("../services/reply-engine/state");
    const prev = { ...emptyState(), facts: { _cannedTeamLineAt: "t" } };
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, "v"]));
    const s = mergeState(prev, { facts: { ...many, _cannedTeamLineAt: null, _x: "model" } as any });
    expect(s.facts._cannedTeamLineAt).toBe("t");
    expect(s.facts._x).toBeUndefined();
    expect(renderState(s)).not.toContain("_canned");
    expect(mergeState(emptyState(), {}, { engineFacts: { _cannedTeamLineAt: "n" } }).facts._cannedTeamLineAt).toBe("n");
  });
});

describe("prod replay 3 (2026-11-16)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ the employee's gendered first person is caught, feelings included", async () => {
    for (const r of ["שמחה שהסתדרת!", "אני שמחה לעזור", "מצטערת על העיכוב", "שמח לשמוע", "מצטער, אין במלאי.", "אני בטוחה שזה יתאים"]) {
      expect(styleCodes(await g3(r)), r).toContain("self_gendered");
    }
    for (const r of ["חג שמח לכולם", "בשמחה!", "שמחים שהסתדר", "מצטערים על העיכוב", "לשמחתנו זה במלאי"]) {
      expect(styleCodes(await g3(r)), r).not.toContain("self_gendered");
    }
  });

  it("★ and cleaned into the team's plural", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    expect(cleanStyle("שמחה שהסתדרת!", ["self_gendered"])).toBe("שמחים שהסתדרת!");
    expect(cleanStyle("אני שמחה לעזור", ["self_gendered"])).toBe("אנחנו שמחים לעזור");
    expect(cleanStyle("מצטערת על העיכוב.", ["self_gendered"])).toBe("מצטערים על העיכוב.");
    expect(cleanStyle("חג שמח לכולם", ["self_gendered"])).toBe("חג שמח לכולם");
  });

  it("★ a business fact said to be unavailable without searching the knowledge -> unread_knowledge", async () => {
    const { unreadBusinessInfo } = await import("../services/reply-engine/gates");
    const offered = ["search_knowledge", "woocommerce.get_order"];
    const rec = (tool: string) => ({ tool, decision: "allow" } as any);
    expect(unreadBusinessInfo("הכתובת המדויקת לא זמינה כרגע.", "איפה הסטודיו?", [], offered)).toBe(true);
    expect(unreadBusinessInfo("אין לי את הכתובת.", "מה הכתובת שלכם?", [], offered)).toBe(true);
    expect(unreadBusinessInfo("שאלה טובה", "יש איסוף עצמי?", [], offered, true)).toBe(true);
    expect(unreadBusinessInfo("כמה עולה המשלוח לא מופיע אצלי.", "כמה עולה משלוח?", [], offered)).toBe(true);
    expect(unreadBusinessInfo("אין לי מידע על זה.", "מה שעות הפתיחה?", [], offered)).toBe(true);
    expect(unreadBusinessInfo("אין לי מידע על זה.", "מה שעות פתיחה?", [], offered)).toBe(true);
    // Searched, answered, not offered, or about one order of theirs: not this check.
    expect(unreadBusinessInfo("הכתובת לא זמינה.", "איפה הסטודיו?", [rec("search_knowledge")], offered)).toBe(false);
    expect(unreadBusinessInfo("אנחנו ברחוב הרצל 5.", "איפה הסטודיו?", [], offered)).toBe(false);
    expect(unreadBusinessInfo("הכתובת לא זמינה.", "איפה הסטודיו?", [], ["woocommerce.get_order"])).toBe(false);
    expect(unreadBusinessInfo("לא זמין.", "מתי תגיע ההזמנה שלי?", [], offered)).toBe(false);
    // Through gate3, before the order check.
    expect((await g3("הכתובת המדויקת לא זמינה כרגע.", { incomingMessage: "איפה הסטודיו?", toolsOffered: offered })).map((p) => p.kind)).toContain("unread_knowledge");
  });

  it("★ a product search timed out and the reply gives up -> gave_up_search; not when something else was found", async () => {
    const { gaveUpSearch } = await import("../services/reply-engine/gates");
    const t = (tool: string, outcome: string) => ({ tool, decision: "allow", outcome } as any);
    expect(gaveUpSearch("לא הצלחתי לבדוק את זה כרגע.", [t("woocommerce.list_products", "timeout")])).toBe(true);
    expect(gaveUpSearch("I couldn't check the store right now.", [t("woocommerce.list_products", "timeout")])).toBe(true);
    expect(gaveUpSearch("לא הצלחתי לבדוק.", [t("woocommerce.list_products", "timeout"), t("woocommerce.list_products", "ok")])).toBe(false);
    expect(gaveUpSearch("לא הצלחתי לבדוק.", [t("woocommerce.get_order", "timeout")])).toBe(false);
    expect(gaveUpSearch("יש לנו משטחים בכמה גדלים, לאיזה מכשיר?", [t("woocommerce.list_products", "timeout")])).toBe(false);
    expect((await g3("לא הצלחתי לבדוק את זה כרגע.", { tools: [t("woocommerce.list_products", "timeout")] })).map((p) => p.kind)).toContain("gave_up_search");
  });
});

describe("prod replay 4 (2026-11-16)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);
  const search = (query: string, outcome: string, content = "") => ({ tool: "woocommerce.list_products", args: { query }, decision: "allow", outcome, content } as any);

  it("★ \"we don't sell X\" needs a search for X this turn that did not return it", async () => {
    const { ungroundedAbsence } = await import("../services/reply-engine/gates");
    const claim = "משטחי במבוק אנחנו לא מוכרים.";
    expect(ungroundedAbsence(claim, [])).toHaveLength(1);
    expect(ungroundedAbsence(claim, [search("משטח עץ", "empty")])).toHaveLength(1);
    expect(ungroundedAbsence(claim, [search("משטח במבוק", "empty")])).toEqual([]);
    // The search returned bamboo: the claim is contradicted.
    expect(ungroundedAbsence(claim, [search("במבוק", "ok", "PRODUCT_1: משטח במבוק כהה")])).toHaveLength(1);
    // No words to check: any product search this turn grounds it.
    expect(ungroundedAbsence("אין לנו כזה, אבל יש דומה.", [search("x", "ok")])).toEqual([]);
    expect(ungroundedAbsence("We don't sell bamboo pads.", [])).toHaveLength(1);
    // "No info" is not an absence claim, and a plain answer is not one either.
    expect(ungroundedAbsence("אין לנו מידע על זה כרגע.", [])).toEqual([]);
    expect(ungroundedAbsence("יש משטח במבוק בשני גוונים.", [])).toEqual([]);
    expect(kinds(await g3(claim))).toContain("ungrounded_absence");
  });

  it("★ \"passed to the team\" or \"we'll update you\" with nothing carrying it is unsupported", async () => {
    const { unbackedPromises } = await import("../services/reply-engine/gates");
    const none = { teamQuestion: false, handedOff: false, teamAlreadyOpen: false, approvalPending: false };
    expect(unbackedPromises("המידות הועברו לצוות.", none)).toHaveLength(1);
    expect(unbackedPromises("לא נשלח לפני שנעדכן אותך.", none).length).toBeGreaterThan(0);
    expect(unbackedPromises("נעדכן אותך כשזה יגיע.", none)).toHaveLength(1);
    expect(unbackedPromises("המידות הועברו לצוות.", { ...none, teamQuestion: true })).toEqual([]);
    expect(unbackedPromises("נעדכן אותך כאן.", { ...none, teamAlreadyOpen: true })).toEqual([]);
    expect(unbackedPromises("המשלוח יוצא מחר.", none)).toEqual([]);
    expect(kinds(await g3("המידות הועברו לצוות."))).toContain("unsupported_action");
    // A promise the legacy honesty check does not know, through gate3.
    expect(kinds(await g3("נעדכן אותך כשזה יגיע."))).toContain("unsupported_action");
  });

  it("★ more of the employee's gendered first person, and two grammar slips, caught and cleaned", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    for (const r of ["מבינה, זה מתסכל.", "לא הייתי צריכה לשלוח את זה.", "מבינה את התסכול"]) expect(styleCodes(await g3(r)), r).toContain("self_gendered");
    for (const r of ["את מבינה?", "מבינים לגמרי.", "אם הוא מבין את ההוראות"]) expect(styleCodes(await g3(r)), r).not.toContain("self_gendered");
    expect(styleCodes(await g3("מה אפשר לעזור?"))).toContain("help_grammar");
    expect(styleCodes(await g3("ביקשתם ממך את המידות"))).toContain("mixed_person");
    expect(cleanStyle("מבינה, זה מתסכל.", ["self_gendered"])).toBe("מבינים, זה מתסכל.");
    expect(cleanStyle("לא הייתי צריכה לשלוח.", ["self_gendered"])).toBe("לא היה צריך לשלוח.");
    expect(cleanStyle("מה אפשר לעזור?", ["help_grammar"])).toBe("במה אפשר לעזור?");
    expect(cleanStyle("ביקשתם ממך את המידות.", ["mixed_person"])).toBe("ביקשנו ממך את המידות.");
  });

  it("★ strong frustration after a long wait keeps its handoff", async () => {
    const { needlessHandoff } = await import("../services/reply-engine/gates");
    expect(needlessHandoff("frustrated", ["כבר שבוע שאתם לא מתקדמים עם זה"], false)).toBe(false);
    expect(needlessHandoff("frustrated", ["אף אחד לא עונה לי"], false)).toBe(false);
    expect(needlessHandoff("frustrated", ["כבר שבוע ואין כלום"], false)).toBe(false);
    expect(needlessHandoff("x", ["אפשר לשלם בתשלומים?"], false)).toBe(true);
  });

  it("★ a product ask answered with no product and no question is thin", async () => {
    const { tooThin } = await import("../services/reply-engine/gates");
    const ask = "מחפשת צעיף חגיגי בגוון כחול";
    expect(tooThin("ברור, דווקא חגיגית ובגווני כחול.", "ברור, דווקא חגיגית ובגווני כחול.", ask)).toBe(true);
    expect(tooThin("יש כמה חגיגיים בכחול.", "x", ask, { cards: ["PRODUCT_1"] })).toBe(false);
    expect(tooThin("יש את צעיף אנה בכחול.", "x", ask, { titles: ["צעיף אנה"] })).toBe(false);
    expect(tooThin("ברור, לאיזה אירוע?", "x", ask)).toBe(false);
    expect(tooThin("אנחנו פתוחים עד 18:00.", "אנחנו פתוחים עד 18:00.", "מה שעות הפתיחה?")).toBe(false);
  });

  it("★ a SHOW line is never in the reply: its keys become cards", async () => {
    const o = parseRespond(JSON.stringify({ reply: "יש שני צעיפים כחולים שיתאימו.\nSHOW: PRODUCT_1, PRODUCT_2", cards: ["PRODUCT_1"] }))!;
    expect(o.reply).toBe("יש שני צעיפים כחולים שיתאימו.");
    expect(o.cards).toEqual(["PRODUCT_1", "PRODUCT_2"]);
    expect(parseRespond(JSON.stringify({ reply: "זה יתאים לך. SHOW: PRODUCT_3" }))!.reply).toBe("זה יתאים לך.");
  });

  it("★ a person's message is marked as a person's, from the inbox or the phone", async () => {
    const { historyToChat } = await import("../services/reply-engine/engine");
    const chat = historyToChat([
      { direction: "INBOUND", body: "יש במבוק?" },
      { direction: "OUTBOUND", body: "כן, בהיר וכהה.", senderName: "dana@shop.co.il" },
      { direction: "OUTBOUND", body: "שלחתי תמונות", senderName: "Smoovee", metadata: { source: "whatsapp_business_app" } },
      { direction: "OUTBOUND", body: "בשמחה!", senderName: "AI Bot" },
    ]);
    expect(chat[1]).toEqual({ role: "user", content: "[Human team member Dana, not you, wrote to the customer]: כן, בהיר וכהה." });
    expect(chat[2].content).toMatch(/^\[The business owner \(from the phone\), not you, wrote to the customer\]/);
    expect(chat[3]).toEqual({ role: "assistant", content: "בשמחה!" });
  });
});

describe("prod replay 5 (2026-11-16)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);
  const STORE = ["woocommerce.list_products", "search_knowledge"];

  it("★ \"we can't call you\" is an absence claim: only the business's own words ground it", async () => {
    const { ungroundedAbsence } = await import("../services/reply-engine/gates");
    const claim = "אנחנו לא יכולים לקבוע שיחת טלפון.";
    expect(ungroundedAbsence(claim, [], "")).toHaveLength(1);
    expect(ungroundedAbsence(claim, [], "השירות שלנו בוואטסאפ בלבד, אין מענה טלפוני.")).toEqual([]);
    expect(ungroundedAbsence("We can't arrange a phone call.", [], "")).toHaveLength(1);
    // A bare "not possible" with nothing named is not a claim to check.
    expect(ungroundedAbsence("לצערנו אי אפשר.", [], "")).toEqual([]);
    expect(kinds(await g3(claim))).toContain("ungrounded_absence");
  });

  it("★ a photo asked for instead of a search -> no_search; asked again -> repeated_ask", async () => {
    const { photoInsteadOfSearch, repeatedAsk } = await import("../services/reply-engine/gates");
    expect(photoInsteadOfSearch("אפשר לשלוח תמונה של מה שמחפשים?", "מחפשת משטח בצבע אפור", [], STORE)).toBe(true);
    expect(photoInsteadOfSearch("אפשר לשלוח תמונה?", "מחפשת משטח בצבע אפור", [{ tool: "woocommerce.list_products" } as any], STORE)).toBe(false);
    expect(photoInsteadOfSearch("אפשר לשלוח תמונה?", "הגיע שבור", [], STORE)).toBe(false);
    expect(repeatedAsk("אפשר לשלוח תמונה?", ["היי! אפשר תמונה של המכשיר?"])).toBe(true);
    expect(repeatedAsk("אפשר לשלוח תמונה?", ["היי! מה מחפשים?"])).toBe(false);
    expect(repeatedAsk("לאיזה מכשיר זה מיועד?", ["תודה. לאיזה מכשיר זה מיועד?"])).toBe(true);
    expect(styleCodes(await g3("אפשר תמונה?", { previousBotReplies: ["אפשר תמונה של המכשיר?"] }))).toContain("repeated_ask");
    expect(kinds(await g3("אפשר לשלוח תמונה?", { incomingMessage: "מחפשת משטח בצבע אפור", toolsOffered: STORE }))).toContain("no_search");
  });

  it("★ \"yes\" to the employee's own offer of a person, not acted on -> ignored_yes", async () => {
    const { ignoredYes } = await import("../services/reply-engine/gates");
    const offer = "זה דחוף? אם כן אעביר לנציג שימשיך כאן.";
    expect(ignoredYes("כן", offer, false, false)).toBe(true);
    expect(ignoredYes("כן דחוף", offer, false, false)).toBe(true);
    expect(ignoredYes("כן", offer, true, false)).toBe(false);
    expect(ignoredYes("כן", "רוצה לראות עוד צבעים?", false, false)).toBe(false);
    expect(ignoredYes("לא, תודה", offer, false, false)).toBe(false);
    expect(kinds(await g3("בסדר.", { incomingMessage: "כן", previousBotReplies: [offer] }))).toContain("ignored_yes");
  });

  it("★ another alphabet inside a word, and internal jargon, are style problems; the script is stripped", async () => {
    const { stripForeignScript, cleanStyle } = await import("../services/reply-engine/gates");
    expect(styleCodes(await g3("כשמ折לים את המשטח"))).toContain("foreign_script");
    expect(styleCodes(await g3("שמחים לעזור 🙂 במחיר ₪120, 30×40 ס\"מ!"))).not.toContain("foreign_script");
    expect(stripForeignScript("כשמ折לים")).toBe("כשמלים");
    expect(styleCodes(await g3("המספר מקושר לפרטי הקשר שלך."))).toContain("internal_jargon");
    expect(cleanStyle("יש לנו את ההזמנה. המספר מקושר לפרטי הקשר שלך.", ["internal_jargon"])).toBe("יש לנו את ההזמנה.");
  });

  it("★ a FACT problem loses its sentence, the rest stays", async () => {
    const { stripFactProblems } = await import("../services/reply-engine/gates");
    expect(stripFactProblems("יש לנו משטחים בכמה גדלים. במבוק אנחנו לא מוכרים.", [{ kind: "ungrounded_absence", claims: ["במבוק אנחנו לא מוכרים."] }] as any)).toBe("יש לנו משטחים בכמה גדלים.");
    expect(stripFactProblems("נעדכן אותך כשזה יגיע. המשלוח יוצא מחר.", [{ kind: "unsupported_action", claims: ["נעדכן"] }] as any)).toBe("המשלוח יוצא מחר.");
    expect(stripFactProblems("התיק עולה ₪120, מתאים?", [{ kind: "ungrounded_price", prices: ["120"] }] as any)).not.toMatch(/120/);
    // The whole sentence goes, never "התיק עולה." (prod replay 9).
    expect(stripFactProblems("התיק עולה ₪120. מתאים לך?", [{ kind: "ungrounded_price", prices: ["120"] }] as any)).toBe("מתאים לך?");
  });

  it("★ the engine's own lookups for a rewrite: the customer's words, two at most, none it cannot make", async () => {
    const { autoLookups } = await import("../services/reply-engine/gates");
    const a = autoLookups([{ kind: "ungrounded_absence", claims: ["x"] }, { kind: "unread_knowledge" }] as any, "יש משטחי במבוק?", STORE, []);
    expect(a.map((c) => [c.function.name, JSON.parse(c.function.arguments).query])).toEqual([["woocommerce.list_products", "משטחי במבוק"], ["search_knowledge", "יש משטחי במבוק?"]]);
    const narrow = autoLookups([{ kind: "gave_up_search" }] as any, "תיקים", STORE, [{ tool: "woocommerce.list_products", outcome: "timeout", args: { query: "תיקי בד לחוף קיץ" } } as any]);
    expect(JSON.parse(narrow[0].function.arguments)).toEqual({ query: "תיקי בד", per_page: 5 });
    // An order read needs the model; a product question with no product word of hers and none in focus gets the knowledge only.
    expect(autoLookups([{ kind: "unread_order" }] as any, "x", STORE, [])).toEqual([]);
    expect(autoLookups([{ kind: "unread_product" }, { kind: "unread_order" }] as any, "x", STORE, []).map((c) => c.function.name)).toEqual(["search_knowledge"]);
    expect(autoLookups([{ kind: "no_search" }] as any, "x", ["search_knowledge"], [])).toEqual([]);
  });

  it("★ the keyword fallback finds the chunk that says it, by the ask's own words first", async () => {
    const { lexicalTerms, lexicalKnowledge, mergeKnowledge, KNOWLEDGE_GAP_SCORE } = await import("../services/knowledge.service");
    expect(lexicalTerms("איסוף מנשר").own).toEqual(expect.arrayContaining(["איסוף", "מנשר", "נשר"]));
    expect(lexicalTerms("איפה הסטודיו").expanded).toEqual(expect.arrayContaining(["כתובת", "רחוב"]));
    const rows = [
      { content: "משלוחים לכל הארץ תוך 3 ימים", chunkIndex: 0, documentId: "d1", document: { title: "משלוח" } },
      { content: "נקודת איסוף בנשר: רחוב הארזים 4", chunkIndex: 1, documentId: "d1", document: { title: "משלוח" } },
    ];
    let where: any;
    const db = { knowledgeChunk: { findMany: async (a: any) => { where = a.where; return rows; } } };
    const hits = await lexicalKnowledge("t1", "איסוף מנשר", 5, null, { db, kbIds: ["kb1"] });
    expect(hits[0].content).toMatch(/נשר/);
    expect(hits[0].score).toBeGreaterThanOrEqual(KNOWLEDGE_GAP_SCORE);
    expect(where).toMatchObject({ tenantId: "t1", document: { knowledgeBaseId: { in: ["kb1"] } } });
    // No readable base: nothing, and no query.
    expect(await lexicalKnowledge("t1", "איסוף", 5, null, { db: { knowledgeChunk: { findMany: async () => { throw new Error("must not query"); } } }, kbIds: [] })).toEqual([]);
    const strong = { content: "s", score: 0.6, documentTitle: "a", chunkIndex: 0, documentId: "x" };
    const weak = { content: "w", score: 0.1, documentTitle: "b", chunkIndex: 0, documentId: "y" };
    expect(mergeKnowledge([weak, strong], hits, 5).map((c) => c.content)).toEqual(["s", hits[0].content, ...hits.slice(1).map((h) => h.content), "w"].slice(0, 5));
  });

  it("★ every store search carries the customer's sizes, one per appliance, from their last messages", async () => {
    const { withCustomerSearchFacts } = await import("../services/reply-engine/engine");
    const history = [
      { direction: "INBOUND", body: "יש לי מג'ימיקס 21x24 ס\"מ" },
      { direction: "OUTBOUND", body: "ומה עוד?" },
      { direction: "INBOUND", body: "וגם מיקסר 22 על 35" },
    ];
    const out = withCustomerSearchFacts({ query: "משטח" }, history, "מה מתאים לשניהם?");
    expect(out.fits_cm_all).toEqual([[21, 24], [22, 35]]);
    expect(out.fits_cm).toEqual([21, 24]);
    // The model's own sizes stand.
    expect(withCustomerSearchFacts({ query: "משטח", fits_cm: [10, 10] }, history, "x").fits_cm_all).toBeUndefined();
  });

  it("★ my orders: a phone or an email the model passes is dropped, the guard supplies the customer's own", async () => {
    const { scrubOrderSelectors } = await import("../services/reply-engine/engine");
    expect(scrubOrderSelectors("woocommerce.list_customer_orders", { phone: "0501234567", email: "a@b.c", per_page: 5 })).toEqual({ per_page: 5 });
    expect(scrubOrderSelectors("woocommerce.get_order", { order_id: "123" })).toEqual({ order_id: "123" });
  });
});

describe("prod replay 6 (2026-11-16)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ a reply that says a person will continue is a promise of a handoff", async () => {
    const { promisesPerson } = await import("../services/reply-engine/gates");
    for (const r of ["נציג מהצוות ימשיך איתך כאן.", "מעבירים אותך לנציג.", "הצוות יחזור אליך בהקדם.", "A team member will take over here."]) expect(promisesPerson(r), r).toBe(true);
    for (const r of ["אפשר לבחור צבע.", "הנציגים שלנו עובדים א עד ה.", "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט."]) expect(promisesPerson(r), r).toBe(false);
  });

  it("★ a search that timed out never grounds \"not found\"", async () => {
    const { ungroundedAbsence } = await import("../services/reply-engine/gates");
    const claim = "לא מצאתי פריט בשם בנדנה מרובעת.";
    const rec = (outcome: string) => ({ tool: "woocommerce.list_products", args: { query: "בנדנה מרובעת" }, decision: "allow", outcome, content: "" } as any);
    expect(ungroundedAbsence(claim, [rec("timeout")])).toHaveLength(1);
    expect(ungroundedAbsence(claim, [rec("error")])).toHaveLength(1);
    expect(ungroundedAbsence(claim, [rec("empty")])).toEqual([]);
    expect(ungroundedAbsence("I didn't find a square bandana.", [])).toHaveLength(1);
  });

  it("★ products presented with no name, price or card -> nameless_products", async () => {
    const { namelessProducts } = await import("../services/reply-engine/gates");
    const ask = "מחפשת בנדנה מרובעת";
    expect(namelessProducts("הנה בנדנות מרובעות.", ask, [], [])).toBe(true);
    expect(namelessProducts("הנה בנדנות מרובעות.", ask, ["PRODUCT_1"], [])).toBe(false);
    expect(namelessProducts("הנה בנדנה אנה, ₪89.", ask, [], [])).toBe(false);
    expect(namelessProducts("יש לנו את בנדנה אנה.", ask, [], ["בנדנה אנה"])).toBe(false);
    expect(namelessProducts("יש לנו כמה, באיזה צבע?", ask, [], [])).toBe(false);
    expect(kinds(await g3("הנה בנדנות מרובעות.", { incomingMessage: ask }))).toContain("nameless_products");
  });

  it("★ the same paragraph as one of the last five replies -> near_duplicate", async () => {
    const { nearDuplicate } = await import("../services/reply-engine/gates");
    const para = "כדי לבדוק את ההזמנה צריך את מספר ההזמנה, והטלפון ששמור עליה לא תואם למספר שממנו כותבים.";
    expect(nearDuplicate(para, ["שלום", para])).toBe(true);
    expect(nearDuplicate("כדי לבדוק את ההזמנה צריך את מספר ההזמנה, והטלפון השמור עליה לא תואם למספר שממנו כותבים כרגע.", [para])).toBe(true);
    expect(nearDuplicate("יש לנו משטחי במבוק בשני גוונים, בהיר וכהה.", [para])).toBe(false);
    expect(nearDuplicate(para, [para, "1", "2", "3", "4", "5"])).toBe(false);
    expect(styleCodes(await g3(para, { previousBotReplies: [para] }))).toContain("near_duplicate");
  });

  it("★ a colour or occasion ask sent to the team without a search -> no_search", async () => {
    const { photoInsteadOfSearch } = await import("../services/reply-engine/gates");
    const offered = ["woocommerce.list_products"];
    expect(photoInsteadOfSearch("העברתי לצוות.", "יש משהו חגיגי לחתונה?", [], offered, true)).toBe(true);
    expect(photoInsteadOfSearch("העברתי לצוות.", "יש בצבע תכלת?", [], offered, true)).toBe(true);
    expect(photoInsteadOfSearch("העברתי לצוות.", "מתי אתם פתוחים?", [], offered, true)).toBe(false);
  });

  it("★ every dash variant: a hyphen in a word becomes \"-\", a dash between words a comma", async () => {
    const { normalizeDashes, cleanStyle } = await import("../services/reply-engine/gates");
    expect(normalizeDashes("ב\u2011₪79")).toBe("ב-₪79");
    expect(normalizeDashes("\u22125")).toBe("-5");
    expect(normalizeDashes("יש \u2015 במלאי")).toBe("יש, במלאי");
    expect(normalizeDashes("א\u2012ב")).toBe("א, ב");
    expect(cleanStyle("יש \u2014 במלאי", [])).toBe("יש, במלאי");
  });
});

describe("prod replay 6 follow-up: the customer's own order on their own number", () => {
  it("★ orders found by the number they write from are called theirs, never a mismatch", async () => {
    const { withOwnNumberNote } = await import("../services/reply-engine/engine");
    const found = withOwnNumberNote({ ok: true, result: [{ id: 1 }] });
    expect(found.note).toMatch(/registered on the number the customer is writing from/);
    expect(found.note).toMatch(/not a mismatch/);
    expect(found.result).toEqual([{ id: 1 }]);
    expect(withOwnNumberNote({ ok: true, result: [] }).note).toMatch(/ask for the order number/);
    const { droppedOrderSelectors } = await import("../services/reply-engine/engine");
    expect(droppedOrderSelectors("woocommerce.list_customer_orders", { phone: "0501234567" })).toBe(true);
    expect(droppedOrderSelectors("woocommerce.list_customer_orders", { per_page: 5, email: "" })).toBe(false);
    expect(droppedOrderSelectors("woocommerce.get_order", { phone: "1" })).toBe(false);
    // A refusal or an error is passed through untouched.
    expect(withOwnNumberNote({ ok: false, reason: "x" })).toEqual({ ok: false, reason: "x" });
  });
});

describe("prod replay 7: the address the documents give", () => {
  it("★ a price sentence is never an address; real ones are found", async () => {
    const { extractAddress } = await import("../services/knowledge.service");
    expect(extractAddress('אפשר להחזיר לכתובת שלנו בדואר רשום בעלות 15 ש"ח.')).toBeNull();
    expect(extractAddress("משלוח לכל הארץ תוך 3 ימים")).toBeNull();
    expect(extractAddress("איסוף עצמי עד 5 ימי עסקים")).toBeNull();
    expect(extractAddress("את המוצר יש לשלוח לכתובת תהילה רוזנבאום, יוסף לוי 8/2 נהריה")).toBe("יוסף לוי 8/2 נהריה");
    expect(extractAddress("נקודת איסוף: מסילה 23 נשר")).toBe("מסילה 23 נשר");
    expect(extractAddress("הסטודיו ברחוב הרצל 5, תל אביב")).toBe("הרצל 5, תל אביב");
    // A number with no city after a loose cue: unsure, so nothing.
    expect(extractAddress("הסטודיו פתוח 4 ימים")).toBeNull();
    // A price word before the number is not a street, whatever follows it.
    expect(extractAddress("איסוף עצמי בעלות 15 בלבד")).toBeNull();
    // A loose cue needs a city after the number.
    expect(extractAddress("הסטודיו בקומה 4.")).toBeNull();
  });
  it("★ documentAddress: the most frequent real address, never the price sentence", async () => {
    const { documentAddress } = await import("../services/knowledge.service");
    const rows = [
      { content: 'החזרות בדואר רשום בעלות 15 ש"ח לכתובת שלנו' },
      { content: "יש לשלוח לכתובת תהילה רוזנבאום, יוסף לוי 8/2 נהריה" },
      { content: "החלפות: לכתובת תהילה רוזנבאום, יוסף לוי 8/2 נהריה, בתוך 14 יום" },
    ];
    const db = { knowledgeChunk: { findMany: async () => rows } };
    expect(await documentAddress("t-addr-1", null, { db, kbIds: ["kb"] })).toBe("יוסף לוי 8/2 נהריה");
    expect(await documentAddress("t-addr-2", null, { db: { knowledgeChunk: { findMany: async () => [rows[0]] } }, kbIds: ["kb"] })).toBeNull();
  });
});

describe("prod replay 7: store caches", () => {
  it("★ stale-while-revalidate: fresh served, stale served and refreshed once, missing waits", async () => {
    const { swrCached } = await import("../services/connectors/woocommerce.adapter");
    const cache = new Map<string, { at: number; value: number }>();
    let loads = 0;
    const load = async () => { loads++; return loads; };
    expect(await swrCached(cache, "k", 1000, 10_000, load)).toBe(1);
    expect(await swrCached(cache, "k", 1000, 10_000, load)).toBe(1);
    expect(loads).toBe(1);
    cache.set("k", { at: Date.now() - 5000, value: 1 });
    // Stale: the old value now, one background refresh for two callers.
    const [a, b] = await Promise.all([swrCached(cache, "k", 1000, 10_000, load), swrCached(cache, "k", 1000, 10_000, load)]);
    expect([a, b]).toEqual([1, 1]);
    await new Promise((r) => setTimeout(r, 0));
    expect(loads).toBe(2);
    expect(cache.get("k")!.value).toBe(2);
    // Too old: the caller waits for the new value.
    cache.set("k", { at: Date.now() - 20_000, value: 2 });
    expect(await swrCached(cache, "k", 1000, 10_000, load)).toBe(3);
    // Counted by what it was: fresh, past its fresh window, missing; and a caller that refreshes earlier than a
    // reader's fresh window (the warm pass) is a warm reload, not a stale serve.
    const { cacheCounts } = await import("../services/connectors/woocommerce.adapter");
    const c3 = new Map<string, { at: number; value: number }>();
    const at = (age: number) => c3.set("counted|k", { at: Date.now() - age, value: 1 });
    await swrCached(c3, "counted|k", 1000, 10_000, load);
    at(500); await swrCached(c3, "counted|k", 1000, 10_000, load, undefined, 5000);
    at(2000); await swrCached(c3, "counted|k", 1000, 10_000, load, undefined, 5000);
    at(6000); await swrCached(c3, "counted|k", 1000, 10_000, load, undefined, 5000);
    at(2000); await swrCached(c3, "counted|k", 1000, 10_000, load);
    expect(cacheCounts.counted).toEqual({ hit: 1, stale: 2, miss: 1, warmReload: 1 });
    // A load the keep() rejects is not cached.
    const c2 = new Map<string, { at: number; value: number | null }>();
    await swrCached(c2, "x", 1000, 10_000, async () => null, (v) => v !== null);
    expect(c2.has("x")).toBe(false);
  });
  it("★ the warmer warms every Woo store by default; WOO_CACHE_WARMER=engine limits it", async () => {
    const { warmWooCachesOnce } = await import("../services/woo-cache-warmer.service");
    const base = { tenants: async () => ["on", "off"], mode: (t: string) => (t === "off" ? "off" : "autonomous") as any, load: (async () => ({ credentials: {}, config: {} })) as any, warm: async () => ({ ms: 1, ok: true }) };
    expect((await warmWooCachesOnce(base)).map((x) => x.tenantId)).toEqual(["on", "off"]);
    expect((await warmWooCachesOnce({ ...base, scope: "engine" })).map((x) => x.tenantId)).toEqual(["on"]);
  });
  it("★ the warmer (engine scope) warms only engine tenants, one store at a time, and never throws", async () => {
    const { warmWooCachesOnce } = await import("../services/woo-cache-warmer.service");
    const warmed: string[] = [];
    const r = await warmWooCachesOnce({
      scope: "engine",
      tenants: async () => ["on", "off", "broken", "nostore"],
      mode: (t: string) => (t === "off" ? "off" : "autonomous") as any,
      load: (async ({ tenantId }: any) => { if (tenantId === "broken") throw new Error("db"); return tenantId === "nostore" ? null : { credentials: { k: 1 }, config: {} }; }) as any,
      warm: async () => { warmed.push("x"); return { ms: 5, ok: true }; },
    });
    expect(r).toEqual([{ tenantId: "on", ms: 5, ok: true }, { tenantId: "broken", ok: false, ms: 0 }]);
    expect(warmed).toHaveLength(1);
  });
});

describe("prod replay 7 (Smoovee)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const cands = [
    { title: "משטח הזזה 34*38", price: 149, currency: "ILS", inventoryState: "in_stock", url: "https://s.example/p/1" },
    { title: "משטח במבוק כהה", price: 189, currency: "ILS", inventoryState: "in_stock", url: "https://s.example/p/2" },
    { title: "Old", price: 1, inventoryState: "out_of_stock", url: "https://s.example/p/3" },
  ];

  it("★ a text channel gets the products the reply means: name, price, stock, link", async () => {
    const { textProductList } = await import("../services/reply-engine/engine");
    const keyed = textProductList({ reply: "המתאים ביותר הוא PRODUCT_2.", cards: [] } as any, "המתאים ביותר הוא משטח במבוק כהה.", cands, "he")!;
    expect(keyed.keys).toEqual(["PRODUCT_2"]);
    expect(keyed.text).toBe("משטח במבוק כהה\n₪189\nבמלאי\nhttps://s.example/p/2");
    // Presents products without naming any: the first three in stock.
    expect(textProductList({ reply: "הנה מה שמתאים", cards: [] } as any, "הנה מה שמתאים", cands, "he")!.keys).toEqual(["PRODUCT_1", "PRODUCT_2"]);
    // Nothing meant, or already linked: nothing appended.
    expect(textProductList({ reply: "מה גודל המכשיר?", cards: [] } as any, "מה גודל המכשיר?", cands, "he")).toBeNull();
    expect(textProductList({ reply: "PRODUCT_1", cards: [] } as any, "יש https://s.example/p/1", cands, "he")).toBeNull();
  });

  it("★ a picture or card referred to when none goes out is a FACT problem; with cards it is fine", async () => {
    expect(kinds(await g3("אפשר לראות את המשטח בתמונה המצורפת.", { cardsChannel: false }))).toContain("card_reference");
    expect(kinds(await g3("אפשר לראות את המשטח בתמונה המצורפת.", { cardsChannel: true, cards: ["PRODUCT_1"], candidateCount: 1 }))).not.toContain("card_reference");
    // On a text channel with products the list is appended: not nameless.
    expect(kinds(await g3("הנה משטחים שמתאימים.", { incomingMessage: "מחפשת משטח", listAppended: true }))).not.toContain("nameless_products");
  });

  it("★ a safety complaint anywhere in the conversation keeps its handoff", async () => {
    const { needlessHandoff } = await import("../services/reply-engine/gates");
    expect(needlessHandoff("safety", ["המכשיר מתהפך על המשטח", "[Image]", "שלחתי", "מה עכשיו?"], false)).toBe(false);
    expect(needlessHandoff("x", ["זה לא בטיחותי"], false)).toBe(false);
    expect(needlessHandoff("x", ["אפשר בתשלומים?"], false)).toBe(true);
  });

  it("★ a range keeps its dash; a dash between words is a comma", async () => {
    const { normalizeDashes } = await import("../services/reply-engine/gates");
    expect(normalizeDashes("3\u20137 ימי עסקים")).toBe("3-7 ימי עסקים");
    expect(normalizeDashes("3 \u2013 7 ימים")).toBe("3-7 ימים");
    expect(normalizeDashes("10\u221220")).toBe("10-20");
    expect(normalizeDashes("יש \u2014 במלאי")).toBe("יש, במלאי");
  });

  it("★ an address is quoted with one street word and a comma before the city", async () => {
    const { quotedAddress } = await import("../services/reply-engine/prompt");
    expect(quotedAddress("מסילה 23 נשר")).toBe("רחוב מסילה 23, נשר");
    expect(quotedAddress("ברח' מסילה 23 נשר")).toBe("רחוב מסילה 23, נשר");
    expect(quotedAddress("יוסף לוי 8/2 נהריה")).toBe("רחוב יוסף לוי 8/2, נהריה");
    expect(quotedAddress("רחוב הרצל 5, תל אביב")).toBe("רחוב הרצל 5, תל אביב");
  });

  it("★ replay: an order created after the replayed message did not exist yet", async () => {
    const { ordersAsOf } = await import("../services/reply-engine/engine");
    const asOf = new Date("2026-11-10T10:00:00Z");
    const list = { ok: true, result: [{ id: 1, date_created_gmt: "2026-11-09T08:00:00" }, { id: 2, date_created_gmt: "2026-11-12T08:00:00" }] };
    expect(ordersAsOf("woocommerce.list_customer_orders", list, asOf).result.map((o: any) => o.id)).toEqual([1]);
    expect(ordersAsOf("woocommerce.get_order", { ok: true, result: { id: 2, date_created_gmt: "2026-11-12T08:00:00" } }, asOf)).toMatchObject({ ok: false, reason: expect.stringMatching(/^order_not_found/) });
    expect(ordersAsOf("woocommerce.get_order", { ok: true, result: { id: 1, date_created_gmt: "2026-11-09T08:00:00" } }, asOf).ok).toBe(true);
    expect(ordersAsOf("woocommerce.list_products", list, asOf)).toBe(list);
  });

  it("★ the item the customer names goes first in the search", async () => {
    const { withCustomerSearchFacts, namesOtherItem } = await import("../services/reply-engine/engine");
    expect(namesOtherItem("יש לכם מעמד לסמובי?", "משטח הזזה")).toBe(true);
    expect(namesOtherItem("יש לכם משטח לסמובי?", "משטח הזזה")).toBe(false);
    expect(namesOtherItem("והמחיר?", "משטח הזזה")).toBe(false);
    expect(withCustomerSearchFacts({ query: "משטח הזזה" }, [], "יש לכם מעמד לסמובי?").query).toBe("מעמד משטח הזזה");
  });
});

describe("prod replay 8 (2026-11-17)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ v2's knowledge rule: never mention sources; the specific policy wins; nothing goes to a team, a missing answer is a hand-over. Legacy unchanged", async () => {
    const { buildKnowledgeContext } = await import("../services/knowledge.service");
    const chunks = [{ content: "x", score: 0.6, documentTitle: "FAQ", chunkIndex: 0 }];
    const v2 = buildKnowledgeContext(chunks as any, { conflicts: "team" });
    expect(v2).toMatch(/Never mention sources/);
    expect(v2).not.toMatch(/team_question|offer to have the team/);
    expect(v2).toMatch(/hand over to a person \(set handoff\)/);
    expect(v2).not.toMatch(/surface the disagreement/);
    // Legacy keeps its own wording, team offer included.
    expect(buildKnowledgeContext(chunks as any)).toMatch(/surface the disagreement/);
    expect(buildKnowledgeContext(chunks as any)).toMatch(/offer to have the team answer/);
    // All weak: v2 hands over, legacy offers the team.
    const weak = [{ content: "x", score: 0.1, documentTitle: "FAQ", chunkIndex: 0 }];
    expect(buildKnowledgeContext(weak as any, { dropWhenAllWeak: true, conflicts: "team" })).toMatch(/hand over to a person \(set handoff\); never say the team will get back/);
    expect(buildKnowledgeContext(weak as any, { dropWhenAllWeak: true })).toMatch(/offer to have the team get back to them/);
  });

  it("★ talk of sources, and a tool failure told to the customer, are style problems and are cut", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    expect(styleCodes(await g3("בתקנון כתוב 14 יום, ובמקור אחר כתוב שבוע."))).toContain("internal_jargon");
    expect(styleCodes(await g3("הקטלוג לא נפתח לי כרגע."))).toContain("failure_narration");
    expect(cleanStyle("הקטלוג לא נפתח לי כרגע. איזה גודל מחפשים?", ["failure_narration"])).toBe("איזה גודל מחפשים?");
    expect(styleCodes(await g3("חשוב לנו לשמוע מה לא מרוצה."))).toContain("broken_hebrew");
    expect(cleanStyle("חשוב לנו לשמוע מה לא מרוצה.", ["broken_hebrew"])).toBe("חשוב לנו לשמוע מה לא היה בסדר.");
  });

  it("★ a failed search, then giving up -> gave_up_search (not only a timeout)", async () => {
    const { gaveUpSearch } = await import("../services/reply-engine/gates");
    expect(gaveUpSearch("הקטלוג לא נפתח לי.", [{ tool: "woocommerce.list_products", outcome: "error" } as any])).toBe(true);
  });

  it("★ any offer of a person or the team, then yes -> ignored_yes", async () => {
    const { ignoredYes } = await import("../services/reply-engine/gates");
    for (const offer of ["להעביר אותך?", "שנציג יחזור אלייך?", "שמישהו מהצוות יחזור אלייך?", "רוצה שיחזרו אלייך?"]) {
      expect(ignoredYes("כן", offer, false, false), offer).toBe(true);
    }
    // Passing the QUESTION to the team is no offer of a person (rating ed780586: "כן" became a handoff).
    expect(ignoredYes("כן", "רוצה שאעביר את זה לצוות?", false, false)).toBe(false);
    expect(ignoredYes("כן", "רוצה לראות עוד צבעים?", false, false)).toBe(false);
  });

  it("★ \"the team is already checking\" with nothing open is an unbacked promise", async () => {
    const { unbackedPromises } = await import("../services/reply-engine/gates");
    const none = { teamQuestion: false, handedOff: false, teamAlreadyOpen: false, approvalPending: false };
    expect(unbackedPromises("הצוות כבר בודק את זה.", none)).toHaveLength(1);
    expect(unbackedPromises("זה כבר אצל הצוות.", none)).toHaveLength(1);
    expect(unbackedPromises("הצוות כבר בודק את זה.", { ...none, teamAlreadyOpen: true })).toEqual([]);
  });

  it("★ sizes or an item given, answered with a question or \"I don't want to guess\" -> no_search; not when products are shown", async () => {
    const offered = ["woocommerce.list_products"];
    expect(kinds(await g3("מה הגודל של המכשיר?", { incomingMessage: "יש לי מיקסר 22 על 35", toolsOffered: offered }))).toContain("no_search");
    expect(kinds(await g3("לא רוצה לנחש, תשלחו פרטים.", { incomingMessage: "מחפשת משטח למיקסר", toolsOffered: offered }))).toContain("no_search");
    expect(kinds(await g3("יש משטח 34*38 ב-₪149, מתאים?", { incomingMessage: "מחפשת משטח למיקסר", toolsOffered: offered, tools: [{ tool: "woocommerce.list_products", outcome: "ok" }] }))).not.toContain("no_search");
  });

  it("★ the appended list is exactly what the text names; first three only when it names none", async () => {
    const { textProductList, namesTitle } = await import("../services/reply-engine/engine");
    const c = [
      { title: "סמובי אלכסה שחור 34*38", price: 149, inventoryState: "in_stock", url: "u1" },
      { title: "סמובי כריסטינה לבן 30*40", price: 159, inventoryState: "in_stock", url: "u2" },
      { title: "סמובי נועם אפור 25*35", price: 129, inventoryState: "in_stock", url: "u3" },
    ];
    expect(namesTitle("האלכסה בשחור מתאימה", c[0].title)).toBe(true);
    expect(namesTitle("המשטח 34*38 מתאים", c[0].title)).toBe(true);
    expect(namesTitle("משטח מתאים", c[0].title)).toBe(false);
    const named = textProductList({ reply: "", cards: [] } as any, "האלכסה בשחור והכריסטינה בלבן מתאימות.", c, "he")!;
    expect(named.keys).toEqual(["PRODUCT_1", "PRODUCT_2"]);
    // Speaks of a product without matching one fully: no generic list.
    expect(textProductList({ reply: "", cards: [] } as any, "הנה, הנועם מתאים.", c, "he")?.keys ?? []).not.toContain("PRODUCT_1");
    expect(textProductList({ reply: "", cards: [] } as any, "הנה מה שמתאים.", c, "he")!.keys).toEqual(["PRODUCT_1", "PRODUCT_2", "PRODUCT_3"]);
  });

  it("★ a call request is recognised", async () => {
    const { CALL_REQUEST } = await import("../services/reply-engine/engine");
    for (const t of ["יכול להתקשר אלי?", "תתקשרו אליי בבקשה", "אפשר שיחה טלפונית?", "can someone call me"]) expect(CALL_REQUEST.test(t), t).toBe(true);
    expect(CALL_REQUEST.test("מה הטלפון של החנות?")).toBe(false);
  });

  it("★ the address starts at the street word: \"המפעל ברח במסילה 23 נשר\"", async () => {
    const { extractAddress } = await import("../services/knowledge.service");
    expect(extractAddress("איסוף עצמי מהמפעל ברח במסילה 23 נשר")).toBe("רחוב במסילה 23 נשר");
  });
});

describe("prod replay 9 (2026-11-17)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ a product size the customer typed is not a product fact; their device's size is theirs", async () => {
    const { echoedSizes } = await import("../services/reply-engine/gates");
    const customer = "יש לכם משטח 90×90?";
    expect(echoedSizes("כן, המשטח בגודל 90×90 ס\"מ.", customer, "PRODUCT_1: משטח 70*70")).toHaveLength(1);
    expect(echoedSizes("המשטח בגודל 70×70 ס\"מ.", customer, "PRODUCT_1: משטח 70*70")).toEqual([]);
    expect(echoedSizes("כן, המשטח בגודל 90×90.", customer, "משטח 90*90")).toEqual([]);
    expect(echoedSizes("למכשיר שלך בגודל 90×90 מתאים משטח 70×70.", customer, "משטח 70*70")).toEqual([]);
    expect(kinds(await g3("כן, המשטח בגודל 90×90 ס\"מ.", { customerText: customer, sourceText: "משטח 70*70" }))).toContain("echoed_size");
  });

  it("★ \"the unsupported message\" is internal jargon", async () => {
    expect(styleCodes(await g3("לא ראיתי את ההודעה שלא נתמכה, אפשר לכתוב שוב?"))).toContain("internal_jargon");
  });

  it("★ a cancelled order is marked and never presented as theirs", async () => {
    const { labelInactiveOrders } = await import("../services/reply-engine/engine");
    const list = labelInactiveOrders("woocommerce.list_customer_orders", { ok: true, result: [{ id: 1, status: "cancelled" }, { id: 2, status: "processing" }] });
    expect(list.result[0].inactive).toMatch(/^cancelled/);
    expect(list.result[1].inactive).toBeUndefined();
    expect(list.note).toMatch(/never present it as the customer's order/);
    expect(labelInactiveOrders("woocommerce.get_order", { ok: true, result: { id: 2, status: "completed" } }).note).toBeUndefined();
    expect(labelInactiveOrders("woocommerce.get_order", { ok: true, result: { id: 3, status: "refunded" } }).result.inactive).toMatch(/^refunded/);
  });

  it("★ the sentences a cleanup cut are named exactly", async () => {
    const { removedSentences } = await import("../services/reply-engine/engine");
    expect(removedSentences("א ב. ג ד. ה ו.", "א ב. ה ו.")).toEqual(["ג ד."]);
  });
});

describe("prod replay 10 (2026-11-17)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ the business block carries the profile address, with the instruction to give it", async () => {
    const { businessBlock } = await import("../services/reply-engine/prompt");
    const b = businessBlock({ organizationName: "תהילה", address: "יוסף לוי 8/2, נהריה" } as any);
    expect(b).toMatch(/^# The business/);
    expect(b).toContain("Address: יוסף לוי 8/2, נהריה. Asked where the business is");
    expect(businessBlock(null)).toMatch(/^# The business/);
  });

  it("★ v2's knowledge rule lets the business details stand; legacy unchanged", async () => {
    const { buildKnowledgeContext } = await import("../services/knowledge.service");
    const chunks = [{ content: "x", score: 0.6, documentTitle: "FAQ", chunkIndex: 0 }];
    expect(buildKnowledgeContext(chunks as any, { conflicts: "team" })).toMatch(/unless the business details/);
    expect(buildKnowledgeContext(chunks as any)).toMatch(/treated as unknown for this turn\./);
  });

  it("★ \"the address isn't in my details\" while the prompt has one is a FACT problem", async () => {
    const r = "הכתובת המדויקת לא מופיעה אצלי, אבל אפשר לבדוק.";
    expect(kinds(await g3(r, { businessAddress: "יוסף לוי 8/2, נהריה" }))).toContain("ungrounded_absence");
    expect(kinds(await g3(r, { businessAddress: null }))).not.toContain("ungrounded_absence");
    expect(kinds(await g3("I don't have the exact address.", { businessAddress: "x", locale: "en" }))).toContain("ungrounded_absence");
  });

  it("★ a purchase intent with no store search -> no_search, whatever the reply says", async () => {
    const offered = ["woocommerce.list_products"];
    for (const ask of ["אני רוצה להזמין משטח לאלכסה", "לא מוצאת את זה באתר", "תשלחו לי קישור למשטח"]) {
      expect(kinds(await g3("המשטח מגיע במשלוח תוך 3-7 ימי עסקים.", { incomingMessage: ask, toolsOffered: offered })), ask).toContain("no_search");
    }
    expect(kinds(await g3("המשטח מגיע במשלוח.", { incomingMessage: "אני רוצה להזמין", toolsOffered: offered, tools: [{ tool: "woocommerce.list_products", outcome: "ok" }] }))).not.toContain("no_search");
  });

  it("★ GENERIC safety: harm that happened, in any product; a topic alone is not harm", async () => {
    const { safetyCase } = await import("../services/reply-engine/gates");
    for (const t of ["זה לא יציב", "הוא נופל אחורה", "הילד נחתך מהקצה", "המטען התחמם מאוד ויצא עשן", "קיבלתי פריחה אחרי השימוש בקרם", "the lamp caught fire", "my son got an electric shock", "it tipped over"]) expect(safetyCase([t]), t).toBe(true);
    // A question before buying, or a product word, is not a safety case (2026-11-17: no product words).
    for (const t of ["איזה צבע יש?", "זה מתאים לילדים?", "יש לי אלרגיה לניקל, זה בלי ניקל?", "המכשיר מתגלגל אחורה", "is it safe for kids?", "מחליק שיער במבצע?"]) expect(safetyCase([t]), t).toBe(false);
  });

  it("★ a sentence sent before is cut; new failure and jargon phrases are caught", async () => {
    const { repeatedSentences, cleanStyle } = await import("../services/reply-engine/gates");
    const prev = ["תודה. המשלוח מגיע תוך 3-7 ימי עסקים לכל הארץ, עם שליח עד הבית."];
    const reply = "המשלוח מגיע תוך 3-7 ימי עסקים לכל הארץ, עם שליח עד הבית. לגבי הצבע, יש את המשטח גם בלבן וגם בשחור, ושניהם במלאי כרגע. איזה מהם מעדיפים לבית?";
    expect(repeatedSentences(reply, prev)).toHaveLength(1);
    expect(styleCodes(await g3(reply, { previousBotReplies: prev }))).toContain("repeated_sentence");
    expect(cleanStyle(reply, ["repeated_sentence"], prev)).toBe("לגבי הצבע, יש את המשטח גם בלבן וגם בשחור, ושניהם במלאי כרגע. איזה מהם מעדיפים לבית?");
    expect(styleCodes(await g3("הבדיקה של ההזמנה לא נפתחה כרגע."))).toContain("failure_narration");
    expect(styleCodes(await g3("המספר נוסף לפרטי הקשר שלך."))).toContain("internal_jargon");
  });
});

describe("prod replay 11 (2026-11-17)", () => {
  it("★ a profile address with no street gets the documents' address beside it", async () => {
    const { profileHasStreet } = await import("../services/reply-engine/engine");
    const { businessBlock } = await import("../services/reply-engine/prompt");
    expect(profileHasStreet("הסטודיו נמצא בנהריה. יש נקודות מכירה ברחבי הארץ")).toBe(false);
    expect(profileHasStreet("יוסף לוי 8/2, נהריה")).toBe(true);
    const b = businessBlock({ organizationName: "תהילה", address: "הסטודיו נמצא בנהריה", documentAddress: "יוסף לוי 8/2 נהריה" } as any);
    expect(b).toContain("Address: הסטודיו נמצא בנהריה.");
    expect(b).toContain("Address given in the business's documents for returns and pickup coordination: רחוב יוסף לוי 8/2, נהריה");
  });
});

describe("prod replay 11 rating (2026-11-17)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ a product's own hazards come from the business's knowledge (a warning), never from a word list", async () => {
    const { safetyCase, knowledgeHazard } = await import("../services/reply-engine/gates");
    const k = "אזהרה: ללא המעצור המכשיר עלול להתגלגל ולהחליק מהשיש.";
    expect(safetyCase(["המעצור לא מחזיק והמכשיר מחליק מהשיש"], k)).toBe(true);
    // The same words with no warning in the knowledge, or a question before buying: no.
    expect(safetyCase(["המעצור לא מחזיק והמכשיר מחליק מהשיש"], "המעצור נמכר בנפרד.")).toBe(false);
    expect(knowledgeHazard("האם המעצור מתאים למכשיר שלי?", k)).toBe(false);
    // A store policy is not a warning ("אין להחזיר"), whatever words it shares.
    expect(knowledgeHazard("לא קיבלתי החזר על המוצר", "אין להחזיר מוצר לאחר שימוש.")).toBe(false);
    // Shared words in a sentence that does not warn: not a hazard ("normal use" is not a warning).
    expect(knowledgeHazard("הכבל לא מחובר טוב ומתחמם", "יש לחבר את הכבל לפני הפעלה, הכבל מתחמם בשימוש רגיל.")).toBe(false);
    expect(knowledgeHazard("הכבל לא מחובר טוב ומתחמם", "אזהרה: אם הכבל מתחמם, יש לנתק מיד.")).toBe(true);
    // English knowledge, English customer.
    expect(knowledgeHazard("the heater still smells and the cord is not cool", "Warning: if the cord smells or is hot, unplug the heater.")).toBe(true);
    expect(safetyCase(["המכשיר נהפך"])).toBe(true);
  });

  it("★ a usage tip in a safety conversation that the knowledge does not give is a FACT problem; stop-use advice is fine", async () => {
    const { unsafeTips } = await import("../services/reply-engine/gates");
    const tip = "כדאי לוודא שהמעצור נוגע בגלגלים.";
    expect(unsafeTips(tip, "", true)).toHaveLength(1);
    expect(unsafeTips(tip, "", false)).toEqual([]);
    expect(unsafeTips(tip, "חשוב: המעצור צריך לגעת בגלגלים של המכשיר", true)).toEqual([]);
    expect(unsafeTips("עד הבדיקה, מומלץ להפסיק להשתמש במשטח.", "", true)).toEqual([]);
    expect(kinds(await g3(tip, { safety: true }))).toContain("unsafe_tip");
  });

  it("★ a text channel: products named with no store search -> no_search", async () => {
    const offered = ["woocommerce.list_products"];
    expect(kinds(await g3("מתאים לך משטח אלכסה או כריסטינה.", { incomingMessage: "איזה משטח מתאים למיקסר?", toolsOffered: offered, cardsChannel: false }))).toContain("no_search");
    expect(kinds(await g3("מתאים לך משטח אלכסה או כריסטינה.", { incomingMessage: "איזה משטח מתאים למיקסר?", toolsOffered: offered, cardsChannel: false, tools: [{ tool: "woocommerce.list_products", outcome: "ok" }] }))).not.toContain("no_search");
  });

  it("★ a failed store search sent to the team while the knowledge has the device -> knowledge_has_it", async () => {
    const knowledge = "טבלת התאמה: מיקסר קנווד - משטח כריסטינה 30*40";
    expect(kinds(await g3("העברתי לצוות.", { incomingMessage: "איזה משטח מתאים למיקסר קנווד?", teamQuestion: true, searchFailed: true, knowledge }))).toContain("knowledge_has_it");
    expect(kinds(await g3("העברתי לצוות.", { incomingMessage: "איזה משטח מתאים למיקסר קנווד?", teamQuestion: true, searchFailed: false, knowledge }))).not.toContain("knowledge_has_it");
  });

  it("★ \"still with the team\" on a coupon: search the knowledge for the general answer", async () => {
    expect(kinds(await g3("זה עדיין אצל הצוות.", { incomingMessage: "איפה מזינים את הקופון?", teamAlreadyOpen: true, toolsOffered: ["search_knowledge"] }))).toContain("unread_knowledge");
  });

  it("★ Hebrew: \"לא מצוין התאמה\", and a statement written as a question", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    expect(styleCodes(await g3("לא מצוין התאמה למכשיר הזה."))).toContain("broken_hebrew");
    expect(cleanStyle("לא מצוין התאמה למכשיר הזה.", ["broken_hebrew"])).toBe("לא מצוינת התאמה למכשיר הזה.");
    expect(styleCodes(await g3("יש כמה מטפחות חגיגיות בגווני כחול?", { candidateCount: 2 }))).toContain("statement_question");
    expect(cleanStyle("יש כמה מטפחות חגיגיות בגווני כחול?", ["statement_question"])).toBe("יש כמה מטפחות חגיגיות בגווני כחול.");
    expect(styleCodes(await g3("יש לנו תיק בד קנבס, לאיזה שימוש?", { candidateCount: 1 }))).not.toContain("statement_question");
    expect(styleCodes(await g3("יש כמה מטפחות חגיגיות בגווני כחול?", { candidateCount: 0 }))).not.toContain("statement_question");
  });

  it("★ a size written with a slash (90/90) is a size; a house number (8/2) is not", async () => {
    const { echoedSizes } = await import("../services/reply-engine/gates");
    expect(echoedSizes("הבנדנה סוליקה בגודל 90/90.", "יש לכם בנדנה 90/90?", "סוליקה 70*70")).toHaveLength(1);
    expect(echoedSizes("הבנדנה סוליקה בגודל 70/70.", "יש לכם בנדנה 90/90?", "סוליקה 70*70")).toEqual([]);
    expect(echoedSizes("המשטח ברחוב יוסף לוי 8/2.", "יוסף לוי 8/2", "")).toEqual([]);
  });
});

describe("prod replay 12 (2026-11-17)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ source exposure and placeholder names are internal jargon", async () => {
    for (const r of ["בתיאור העסק מוזכרים שרשראות מנירוסטה.", "אצלנו מופיע שזה כסף.", "הפרטים לא מופיעים אצלנו.", "לא התקבלה הודעה קריאה, רק צירוף תבנית."]) {
      expect(styleCodes(await g3(r)), r).toContain("internal_jargon");
    }
  });

  it("★ a material stated without reading the product -> unread_product", async () => {
    const offered = ["woocommerce.get_product", "woocommerce.list_products"];
    expect(kinds(await g3("השרשראות עשויות כסף.", { incomingMessage: "מאיזה חומר השרשרת?", toolsOffered: offered }))).toContain("unread_product");
    expect(kinds(await g3("השרשרת מנירוסטה.", { incomingMessage: "מאיזה חומר השרשרת?", toolsOffered: offered, tools: [{ tool: "woocommerce.get_product", decision: "allow", outcome: "ok" }] }))).not.toContain("unread_product");
  });

  it("★ \"not on file\" about what the knowledge mentions is a FACT problem", async () => {
    const { infoDeniedButKnown } = await import("../services/reply-engine/gates");
    const k = "איסוף עצמי מנשר בתיאום מראש מול המשרד.";
    expect(infoDeniedButKnown("פרטי תיאום האיסוף לא מופיעים אצלנו כרגע.", k)).toHaveLength(1);
    expect(infoDeniedButKnown("פרטי תיאום האיסוף לא מופיעים אצלנו כרגע.", "")).toEqual([]);
    expect(infoDeniedButKnown("מועד המשלוח לא מופיע אצלנו.", k)).toEqual([]);
    expect(kinds(await g3("פרטי תיאום האיסוף לא מופיעים אצלנו כרגע.", { knowledge: k }))).toContain("ungrounded_absence");
  });

  it("★ the odd hedge is cut; a stop-use sentence the model wrote in other words counts", async () => {
    const { cleanStyle, hasStopUse } = await import("../services/reply-engine/gates");
    expect(styleCodes(await g3("ייתכן שהמשטח יזוז קצת."))).toContain("odd_hedge");
    expect(cleanStyle("יש משטח מתאים. ייתכן שהמשטח יזוז קצת.", ["odd_hedge"])).toBe("יש משטח מתאים.");
    expect(hasStopUse("עדיף להפסיק לעבוד עם המכשיר על המשטח.")).toBe(true);
    expect(hasStopUse("מומלץ להימנע משימוש עד הבדיקה.")).toBe(true);
  });

  it("★ the product in use vs an unrelated ask (generic words, no product parts)", async () => {
    const { customerDescribesUse, safetyWord } = await import("../services/reply-engine/gates");
    expect(customerDescribesUse("כשאני משתמש בזה זה זז כל הזמן")).toBe(true);
    expect(customerDescribesUse("זה לא מחזיק, המגהץ נשמט")).toBe(true);
    expect(customerDescribesUse("אשמח לשיתוף פעולה עם תוכן UGC לעמוד שלכם")).toBe(false);
    expect(customerDescribesUse("When I use it, it keeps moving")).toBe(true);
    expect(safetyWord(["המכשיר נהפך על המשטח"])).toBe("נהפך");
  });

  it("★ a placeholder is no customer text; the same sentence never twice in a reply", async () => {
    const { placeholderOnly, dedupeSentences } = await import("../services/reply-engine/engine");
    for (const t of ["[template attachment]", "[Unsupported message]", "", "  ", "[interactive button]"]) expect(placeholderOnly(t), t).toBe(true);
    expect(placeholderOnly("[Image]")).toBe(false);
    expect(placeholderOnly("היי")).toBe(false);
    expect(dedupeSentences("עד הבדיקה, מומלץ להפסיק. מעבירים לנציג. עד הבדיקה, מומלץ להפסיק.")).toBe("עד הבדיקה, מומלץ להפסיק. מעבירים לנציג.");
  });

  it("★ an order the guard let through is theirs: the note says so", async () => {
    const { ownOrderNote } = await import("../services/reply-engine/engine");
    expect(ownOrderNote("woocommerce.get_order", { ok: true, result: { id: 5 } }).note).toMatch(/Never tell them a number differs/);
    expect(ownOrderNote("woocommerce.get_order", { ok: false, reason: "x" })).toEqual({ ok: false, reason: "x" });
    expect(ownOrderNote("woocommerce.list_products", { ok: true, result: [] }).note).toBeUndefined();
  });

  it("★ a store's coupon field is a platform fact in the prompt", async () => {
    const { buildStablePrefix } = await import("../services/reply-engine/prompt");
    const base = { agent: { name: "-", role: "-" }, company: { organizationName: "Smoovee" }, locale: "he", skills: [], channel: "WHATSAPP", cardsChannel: false } as any;
    expect(buildStablePrefix({ ...base, storePlatform: "woocommerce" })).toContain("\"קוד קופון\" field");
    expect(buildStablePrefix({ ...base, storePlatform: null })).not.toContain("קוד קופון\" field");
  });
});

describe("prod replay 13: the final sanitizer", () => {
  it("★ symbol runs, fences, control and zero-width characters, a symbol tail: gone; text, emoji and punctuation stay", async () => {
    const { sanitizeReply } = await import("../services/reply-engine/engine");
    expect(sanitizeReply("התשלום מתבצע בעמוד הקופה.+#+#+#+#+#+")).toBe("התשלום מתבצע בעמוד הקופה.");
    expect(sanitizeReply("יש ### כמה ==== אפשרויות")).toBe("יש כמה אפשרויות");
    expect(sanitizeReply("```\nשלום\n```")).toBe("שלום");
    expect(sanitizeReply("של\u200Bום\u0007")).toBe("שלום");
    expect(sanitizeReply("שמחים לעזור 👨\u200D👩\u200D👧")).toBe("שמחים לעזור 👨\u200D👩\u200D👧");
    expect(sanitizeReply("מתאים לך? 🙂")).toBe("מתאים לך? 🙂");
    expect(sanitizeReply("המחיר ₪149, 30*40 ס\"מ, 3-7 ימי עסקים.")).toBe("המחיר ₪149, 30*40 ס\"מ, 3-7 ימי עסקים.");
    expect(sanitizeReply("המשלוח: 2 + 1 במבצע")).toBe("המשלוח: 2 + 1 במבצע");
    expect(sanitizeReply("נתראה --")).toBe("נתראה");
  });
});

describe("prod replay 13 (Smoovee)", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ the customer's own message decides the stop-use line", async () => {
    const { customerDescribesUse } = await import("../services/reply-engine/gates");
    expect(customerDescribesUse("המעצור לא מונע את זה")).toBe(true);
    expect(customerDescribesUse("המכשיר נהפך")).toBe(true);
    expect(customerDescribesUse("אשמח לשיתוף פעולה, איך תרצו להשתמש בתוכן?")).toBe(false);
    expect(customerDescribesUse("יש נציג אנושי?")).toBe(false);
    expect(customerDescribesUse("יש לכם משטח למיקסר?")).toBe(false);
  });

  it("★ \"והנה תמונה\" with no card or media is a picture claim", async () => {
    expect(kinds(await g3("והנה תמונה עם המשטח.", { cardsChannel: false }))).toContain("card_reference");
    expect(kinds(await g3("שלחתי לך תמונה של הדגם.", { cardsChannel: false }))).toContain("card_reference");
    expect(kinds(await g3("אפשר לשלוח תמונה של המכשיר?", { cardsChannel: false }))).not.toContain("card_reference");
  });

  it("★ exposure and a photo that \"did not arrive as text\"", async () => {
    expect(styleCodes(await g3("הפרטים לא מפורטים כאן."))).toContain("internal_jargon");
    expect(styleCodes(await g3("אין במידע פרטים על זה."))).toContain("internal_jargon");
    expect(styleCodes(await g3("הצילום לא הגיע אלינו כטקסט שאפשר לקרוא."))).toContain("failure_narration");
  });

  it("★ never affirm the product is unsafe; \"צודק\" becomes neutral", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    expect(styleCodes(await g3("מצטערים, זה באמת לא בטיחותי."))).toContain("affirms_unsafe");
    expect(cleanStyle("מצטערים מאוד. זה באמת לא בטיחותי.", ["affirms_unsafe"])).toBe("מצטערים מאוד.");
    expect(styleCodes(await g3("את צודקת, זה לא תקין."))).toContain("gendered_agree");
    expect(cleanStyle("את צודקת, זה לא תקין.", ["gendered_agree"])).toBe("נכון, זה לא תקין.");
  });

  it("★ where to GET a code answered with where to enter it -> coupon_source", async () => {
    expect(kinds(await g3("מזינים את הקוד בשדה קוד קופון בעמוד התשלום.", { incomingMessage: "איפה אני מוצאת את הקוד עצמו?" }))).toContain("coupon_source");
    expect(kinds(await g3("קודים נשלחים בניוזלטר ובמבצעים.", { incomingMessage: "איפה אני מוצאת את הקוד עצמו?" }))).not.toContain("coupon_source");
    expect(kinds(await g3("מזינים את הקוד בשדה קוד קופון.", { incomingMessage: "איפה מזינים את הקוד?" }))).not.toContain("coupon_source");
  });
});

/**
 * The generic pass (2026-11-17, Omer via the Supervisor): the checks hold for any
 * business, any store platform and any language, never tuned to one tenant's words.
 * Every example below is from a store the engine was never tuned on.
 */
describe("generic pass: held-out stores, English, other alphabets, Shopify", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "en", incomingMessage: "thanks", isFirstReply: false, employeeGender: null, employeeName: "Sam", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ ONE number rule: a time, quantity, measure or percentage needs evidence this turn", async () => {
    const { ungroundedNumbers } = await import("../services/reply-engine/gates");
    expect(ungroundedNumbers("Delivery takes 5 business days.", "")).toHaveLength(1);
    expect(ungroundedNumbers("Delivery takes 5 business days.", "Shipping: 3-5 business days")).toEqual([]);
    expect(ungroundedNumbers("המשלוח מגיע תוך 2 ימים.", "משלוח עד 5 ימי עסקים")).toHaveLength(1);
    expect(ungroundedNumbers("המשלוח מגיע תוך 3–5 ימי עסקים.", "משלוח 3-5 ימי עסקים")).toEqual([]);
    expect(ungroundedNumbers("You get 10% off today.", "")).toHaveLength(1);
    expect(ungroundedNumbers("Only 2 units left.", '{"stock_quantity": 2}')).toEqual([]);
    // A number without a unit (an order number, a phone) is not this rule's.
    expect(ungroundedNumbers("Your order 48213 is on its way.", "")).toEqual([]);
    expect(kinds(await g3("Delivery takes 5 business days."))).toContain("ungrounded_number");
    expect(kinds(await g3("Delivery takes 5 business days.", { knowledge: "Delivery: 5 business days." }))).not.toContain("ungrounded_number");
  });

  it("★ English is covered by the same claim rules (actions, absence, callbacks, hedges)", async () => {
    expect(kinds(await g3("I've passed your question to the team."))).toContain("unsupported_action");
    expect(kinds(await g3("We don't sell desk lamps.", { toolsOffered: ["shopify.search_products"] }))).toContain("ungrounded_absence");
    expect(styleCodes(await g3("We'll call you back tomorrow."))).toContain("callback_promise");
    expect(styleCodes(await g3("It might slip a little on glass."))).toContain("odd_hedge");
    expect(styleCodes(await g3("Yes, it's really unsafe."))).toContain("affirms_unsafe");
    // The business's own warning, quoted, is not the AI affirming it.
    expect(styleCodes(await g3("Yes, it's really unsafe near water.", { knowledge: "Warning: unsafe near water." }))).not.toContain("affirms_unsafe");
  });

  it("★ a Russian or Arabic chat keeps its alphabet; a stray one in a Hebrew chat is cut", async () => {
    const { foreignScript, stripForeignScript, nearDuplicate } = await import("../services/reply-engine/gates");
    expect(foreignScript("Доставка занимает три дня.", "Сколько идет доставка?")).toBe(false);
    expect(foreignScript("التوصيل خلال ثلاثة أيام", "كم يستغرق التوصيل؟")).toBe(false);
    expect(foreignScript("כשמ折לים", "מתי זה מגיע?")).toBe(true);
    expect(stripForeignScript("Доставка", "Привет")).toBe("Доставка");
    expect(stripForeignScript("אבגДа", "שלום")).toBe("אבג");
    // The repeat checks read any alphabet.
    const ru = "Доставка занимает три рабочих дня по всей стране курьером";
    expect(nearDuplicate(ru, [ru])).toBe(true);
    expect(styleCodes(await g3("Доставка занимает три дня.", { incomingMessage: "Сколько?", customerText: "Сколько?" }))).not.toContain("foreign_script");
  });

  it("★ a size echoed as a product's: the store's own titles name the product (no product word list)", async () => {
    const { echoedSizes } = await import("../services/reply-engine/gates");
    const echo = "The Oak Desk Pad comes in 90x90.";
    expect(echoedSizes(echo, "I need 90x90", "Oak Desk Pad 70x70", ["Oak Desk Pad 70x70"])).toHaveLength(1);
    expect(echoedSizes(echo, "I need 90x90", "Oak Desk Pad 70x70", [])).toEqual([]);
    expect(echoedSizes("For your 90x90 desk, the 70x70 pad is the closest.", "my desk is 90x90", "Oak Desk Pad 70x70", ["Oak Desk Pad 70x70"])).toEqual([]);
  });

  it("★ get vs use, for anything obtainable (a gift card, an invoice), in English too", async () => {
    const { couponSourceMissed } = await import("../services/reply-engine/gates");
    expect(couponSourceMissed("where do I get a gift card?", "Enter it at checkout.")).toBe(true);
    expect(couponSourceMissed("where do I get a gift card?", "Gift cards are sent by email after purchase.")).toBe(false);
    expect(couponSourceMissed("where do I get a gift card?", "Gift cards are sent by email, and you enter them at checkout.")).toBe(false);
    expect(couponSourceMissed("איפה אני מוצאת את הקוד עצמו?", "קודים נשלחים בניוזלטר, ומזינים אותם בעמוד התשלום.")).toBe(false);
    expect(couponSourceMissed("מאיפה החשבונית?", "לוחצים על הקישור בעמוד התשלום.")).toBe(true);
    expect(couponSourceMissed("how do I enter the code?", "Enter it at checkout.")).toBe(false);
  });

  it("★ a brand or category every title shares is not a distinctive product word", async () => {
    const { commonTitleWords, namesTitle } = await import("../services/reply-engine/engine");
    const titles = ["Lumo Lamp Desk", "Lumo Lamp Floor", "Lumo Shade"];
    const common = commonTitleWords(titles);
    expect([...common].sort()).toEqual(["lamp", "lumo"]);
    expect(namesTitle("The Lumo Lamp is lovely", "Lumo Lamp Desk", common)).toBe(false);
    expect(namesTitle("The desk one by Lumo", "Lumo Lamp Desk", common)).toBe(false);
    expect(namesTitle("Desk or floor? The desk lamp from Lumo", "Lumo Lamp Desk", new Set())).toBe(true);
  });

  it("★ Shopify parity: orders, the product named by name, the engine's own lookup", async () => {
    const { labelInactiveOrders, ownOrderNote, ordersAsOf, storeSearchByName, withCustomerQueryWords } = await import("../services/reply-engine/engine");
    const { autoLookups } = await import("../services/reply-engine/gates");
    const cancelled = labelInactiveOrders("shopify.get_orders", { ok: true, result: [{ id: 1, cancelled_at: "2026-11-01T00:00:00Z" }, { id: 2, financial_status: "paid" }] });
    expect(cancelled.result[0].inactive).toMatch(/^cancelled/);
    expect(cancelled.result[1].inactive).toBeUndefined();
    expect(labelInactiveOrders("shopify.order_lookup", { ok: true, result: { id: 3, financial_status: "refunded" } }).result.inactive).toMatch(/^refunded/);
    expect(ownOrderNote("shopify.order_lookup", { ok: true, result: { id: 3 } }).note).toMatch(/customer's own/);
    expect(ordersAsOf("shopify.get_orders", { ok: true, result: [{ id: 1, created_at: "2026-11-12T08:00:00Z" }, { id: 2, created_at: "2026-11-01T08:00:00Z" }] }, new Date("2026-11-10T00:00:00Z")).result.map((o: any) => o.id)).toEqual([2]);
    expect(storeSearchByName("shopify.get_product", "Oak Desk Pad", "en")).toEqual({ tool: "shopify.search_products", args: { query: "Oak Desk Pad", limit: 5 } });
    expect(storeSearchByName("woocommerce.get_product", "x", "he")?.tool).toBe("woocommerce.list_products");
    expect(storeSearchByName("custom.get_thing", "x", "he")).toBeNull();
    const auto = autoLookups([{ kind: "no_search" }] as any, "desk lamp", ["shopify.search_products"], []);
    expect(JSON.parse(auto[0].function.arguments)).toEqual({ query: "desk lamp", limit: 5 });
    expect(withCustomerQueryWords({ query: "תיק" }, [], "יש לכם ארנק?").query).toMatch(/^ארנק/);
  });
});

/** Prod replay 2026-11-17 on fc618f4f, held-out stores included. Every rule generic. */
describe("fc618f4f validation fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "en", incomingMessage: "hi", isFirstReply: false, employeeGender: null, employeeName: "Sam", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ automated mail is no customer: the ingest hint, no-reply senders, our own sender, a bulk footer on email only", async () => {
    const { automatedInbound } = await import("../services/reply-engine/gates");
    expect(automatedInbound({ channel: "GMAIL", sender: "news@openai.com", body: "x", metadata: { email: { bulk: "list" } } })).toBe("ingest_list");
    expect(automatedInbound({ channel: "GMAIL", sender: "noreply@accounts.example.com", body: "Reset" })).toBe("no_reply_sender");
    expect(automatedInbound({ channel: "EMAIL", sender: "security-noreply@facebookmail.com", body: "x" })).toBe("no_reply_sender");
    expect(automatedInbound({ channel: "GMAIL", sender: "hello@em.brand.com", body: "Big sale" })).toBe("bulk_domain");
    expect(automatedInbound({ channel: "GMAIL", sender: "alerts-team@gotcha.co.il", body: "שיחה הועברה לנציג", platformSender: "alerts-team@gotcha.co.il" })).toBe("platform_sender");
    expect(automatedInbound({ channel: "OUTLOOK", sender: "team@saas.com", body: "New features! Click here to unsubscribe." })).toBe("bulk_footer");
    expect(automatedInbound({ channel: "GMAIL", sender: "dana@gmail.com", body: "אין להשיב להודעה זו" })).toBe("bulk_footer");
    // A real customer: on email, and on WhatsApp asking how to unsubscribe.
    expect(automatedInbound({ channel: "GMAIL", sender: "dana@gmail.com", body: "Do you have the board in 154cm?" })).toBeNull();
    expect(automatedInbound({ channel: "WHATSAPP", sender: "972501234567", body: "how do I unsubscribe from your newsletter?" })).toBeNull();
  });

  it("★ an empty search narrower than the claim proves nothing; the engine searches the category alone", async () => {
    const { ungroundedAbsence, autoLookups } = await import("../services/reply-engine/gates");
    const narrow = [{ tool: "shopify.search_products", outcome: "empty", args: { query: "snowboard beginner" } }] as any;
    expect(ungroundedAbsence("I didn't find a snowboard in the catalogue.", narrow)).toHaveLength(1);
    // As broad as the claim, and not limited to what is in stock (Shopify's default).
    const broad = [{ tool: "shopify.search_products", outcome: "empty", args: { query: "snowboard", in_stock_only: false } }] as any;
    expect(ungroundedAbsence("I didn't find a snowboard in the catalogue.", broad)).toEqual([]);
    // As broad as the claim: "red snowboard" searched, "no red snowboard" said.
    expect(ungroundedAbsence("We don't have a red snowboard.", [{ tool: "shopify.search_products", outcome: "empty", args: { query: "red snowboard", in_stock_only: false } }] as any)).toEqual([]);
    const auto = autoLookups([{ kind: "ungrounded_absence", claims: ["I didn't find a snowboard in the catalogue."] }] as any, "which snowboard for a beginner under $650?", ["shopify.search_products"], narrow);
    expect(JSON.parse(auto[0].function.arguments)).toEqual({ query: "snowboard", limit: 5, in_stock_only: false });
  });

  it("★ a pointer at a list or cards that the message does not carry", async () => {
    const { danglingReferences } = await import("../services/reply-engine/gates");
    expect(danglingReferences("You can pay with one of these methods.", false)).toHaveLength(1);
    expect(danglingReferences("אפשר לשלם באחד מאמצעי התשלום האלה.", false)).toHaveLength(1);
    expect(danglingReferences("השרשראות שמופיעות כאן הן מכסף.", false)).toHaveLength(1);
    expect(danglingReferences("You can pay with one of these methods.", true)).toEqual([]);
    expect(danglingReferences("Pay with one of these:\n- Visa\n- PayPal", false)).toEqual([]);
    expect(kinds(await g3("Pick one of the following."))).toContain("dangling_reference");
    expect(kinds(await g3("Pick one of the following.", { listAppended: true }))).not.toContain("dangling_reference");
  });

  it("★ the same advice in other words is cut, unless the customer asks about it again", async () => {
    const { repeatedAdvice, cleanStyle } = await import("../services/reply-engine/gates");
    const prev = ["Thanks! Important: always wax the board base before the first ride, it protects the base."];
    const again = "Sure. Remember it is important to wax the base of the board before riding the first time.";
    expect(repeatedAdvice(again, prev)).toHaveLength(1);
    expect(repeatedAdvice(again, prev, "how do I wax the board base?")).toEqual([]);
    expect(repeatedAdvice("Important: the bindings come pre-mounted.", prev)).toEqual([]);
    expect(styleCodes(await g3(again, { previousBotReplies: prev }))).toContain("repeated_advice");
    expect(cleanStyle(again, ["repeated_advice"], prev)).toBe("Sure.");
  });

  it("★ asked to recommend: a pick with a reason, or one question, never neither", async () => {
    const { noRecommendation } = await import("../services/reply-engine/gates");
    const ask = "which board under $650 would you recommend?";
    expect(noRecommendation("We have the Drift 154 at $599 and the Ridge 150 at $640.", ask, 2)).toBe(true);
    expect(noRecommendation("The Drift 154 at $599 is the best fit for a beginner, because it is soft and forgiving.", ask, 2)).toBe(false);
    expect(noRecommendation("We have the Drift and the Ridge. Do you ride mostly park or piste?", ask, 2)).toBe(false);
    expect(noRecommendation("We have the Drift 154 at $599.", "do you have boards?", 2)).toBe(false);
    expect(noRecommendation("We have the Drift.", ask, 0)).toBe(false);
    expect(kinds(await g3("We have the Drift 154 and the Ridge 150.", { incomingMessage: ask, candidateCount: 2 }))).toContain("no_recommendation");
  });

  it("★ a gendered form the rewrite kept becomes the plural", async () => {
    const { neutralSecondPerson, cleanStyle } = await import("../services/reply-engine/gates");
    expect(neutralSecondPerson("אפשר להיכנס לאתר ותבחרי את המידה.")).toBe("אפשר להיכנס לאתר ותבחרו את המידה.");
    expect(neutralSecondPerson("את מחפשת משהו חגיגי?")).toBe("מחפשים משהו חגיגי?");
    expect(neutralSecondPerson("מחפשת משהו חגיגי?")).toBe("מחפשים משהו חגיגי?");
    expect(neutralSecondPerson("היא מחפשת מתנה.")).toBe("היא מחפשת מתנה.");
    expect(cleanStyle("שלחי לנו את מספר ההזמנה.", ["gendered_address"])).toBe("שלחו לנו את מספר ההזמנה.");
  });
});

/** Dev eval 2026-11-17 on fc618f4f: an English sentence in a Hebrew reply; "כן אחי". */
describe("eval follow-up: one language per reply, friendly not familiar", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ an English sentence inside a Hebrew reply is cut; a product's own English title stays", async () => {
    const { foreignLanguageSentences, cleanStyle } = await import("../services/reply-engine/gates");
    const r = "יש לנו את זה במלאי. A person from the team will continue with you here.";
    expect(foreignLanguageSentences(r)).toHaveLength(1);
    expect(styleCodes(await g3(r))).toContain("mixed_language");
    expect(cleanStyle(r, ["mixed_language"])).toBe("יש לנו את זה במלאי.");
    expect(foreignLanguageSentences("מומלץ: Oak Desk Pad Pro Max.", ["Oak Desk Pad Pro Max"])).toEqual([]);
    expect(foreignLanguageSentences("Delivery takes three business days.")).toEqual([]);
    // In a Hebrew reply: a product's own English title alone, and a short Latin name, stay.
    expect(foreignLanguageSentences("יש לנו את זה. Oak Desk Pad Pro Max.", ["Oak Desk Pad Pro Max"])).toEqual([]);
    expect(foreignLanguageSentences("יש לנו את זה. Oak Desk Pad Pro Max.")).toHaveLength(1);
    expect(foreignLanguageSentences("יש במלאי. Nike Air.")).toEqual([]);
    expect(styleCodes(await g3(r, { locale: "en" }))).not.toContain("mixed_language");
  });

  it("★ \"אחי\" and the like are dropped as a vocative; a product word is not one", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    expect(styleCodes(await g3("כן אחי, יש במלאי."))).toContain("familiar_address");
    expect(styleCodes(await g3("יש במלאי, מותק."))).toContain("familiar_address");
    expect(styleCodes(await g3("יש לנו בושם גבר במבצע."))).not.toContain("familiar_address");
    expect(styleCodes(await g3("מיטת מלך במלאי."))).not.toContain("familiar_address");
    expect(cleanStyle("כן אחי, יש במלאי.", ["familiar_address"])).toBe("כן, יש במלאי.");
    expect(cleanStyle("יש במלאי, מותק.", ["familiar_address"])).toBe("יש במלאי.");
    expect(cleanStyle("נשמה, יש במלאי.", ["familiar_address"])).toBe("יש במלאי.");
  });
});

/** Final rating on e9a75ca5 (prod replay 2026-11-17): payment claims, inactive orders, automated mail, identity, close names. */
describe("e9a75ca5 rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "מה עם ההזמנה?", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ a payment or charge status needs a tool result with payment data this turn", async () => {
    const { ungroundedPayment, correctionNote } = await import("../services/reply-engine/gates");
    const r = "ההזמנה בוטלה ולא חויבת, אפשר להזמין שוב.";
    expect(ungroundedPayment(r, [])).toHaveLength(1);
    expect(ungroundedPayment("You were not charged for it.", [])).toHaveLength(1);
    expect(ungroundedPayment("You'll get a refund in 5 days.", [])).toHaveLength(1);
    const order = [{ tool: "woocommerce.get_order", outcome: "ok", content: JSON.stringify({ ok: true, result: { id: 5512, status: "cancelled", date_paid: null } }) }] as any;
    expect(ungroundedPayment(r, order)).toEqual([]);
    expect(ungroundedPayment("ההזמנה בדרך אליך.", [])).toEqual([]);
    const ps = await g3(r, { openTeamText: "האם חויבתי על ההזמנה שבוטלה" });
    expect(kinds(ps)).toContain("ungrounded_payment");
    expect((ps as any[]).find((p: any) => p.kind === "ungrounded_payment").teamOpen).toBe(true);
    expect(correctionNote(ps, "he")).toMatch(/already checking the payment/);
    const { stripFactProblems } = await import("../services/reply-engine/gates");
    expect(stripFactProblems("מבינים. ההזמנה בוטלה ולא חויבת, אפשר להזמין שוב. נשמח לעזור.", ps)).toBe("מבינים. נשמח לעזור.");
    expect(((await g3(r, { openTeamText: "צבע אחר" })) as any[]).find((p: any) => p.kind === "ungrounded_payment").teamOpen).toBe(false);
  });

  it("★ an inactive order's number always comes with its status", async () => {
    const { unlabelledInactiveOrders } = await import("../services/reply-engine/gates");
    const tools = [{ tool: "woocommerce.list_customer_orders", outcome: "ok", content: JSON.stringify({ ok: true, result: [{ id: 5512, number: "5512", status: "cancelled", inactive: "cancelled: not an active order" }, { id: 5600, status: "processing" }] }) }] as any;
    expect(unlabelledInactiveOrders("מספר ההזמנה שלך הוא 5512.", tools)).toHaveLength(1);
    expect(unlabelledInactiveOrders("ההזמנה 5512 בוטלה.", tools)).toEqual([]);
    expect(unlabelledInactiveOrders("Order 5512 was cancelled.", tools)).toEqual([]);
    expect(unlabelledInactiveOrders("ההזמנה שלך 5600 בטיפול.", tools)).toEqual([]);
    expect(kinds(await g3("מספר ההזמנה שלך הוא 5512.", { tools }))).toContain("inactive_order_unlabelled");
  });

  it("★ automated mail, wider: security and account senders, sending subdomains, codes and resets, auto-replies, other languages", async () => {
    const { automatedInbound } = await import("../services/reply-engine/gates");
    const em = (sender: string, body: string) => automatedInbound({ channel: "GMAIL", sender, body });
    expect(em("security@facebookmail.com", "x")).toBe("no_reply_sender");
    expect(em("notification@service.capcut.com", "x")).toBe("no_reply_sender");
    expect(em("hello@mail.instagram.com", "x")).toBe("bulk_domain");
    expect(em("dana@mail.ru", "Do you ship to Haifa?")).toBeNull();
    expect(em("team@insta.com", "We received a request to reset your Instagram password.")).toBe("bulk_footer");
    expect(em("team@insta.com", "123456 is your Instagram code. Don't share it.")).toBe("bulk_footer");
    expect(em("team@insta.com", "We got a request to reset the password for your account.")).toBe("bulk_footer");
    expect(em("team@app.com", "We noticed a new login to your account from Chrome on Windows.")).toBe("bulk_footer");
    expect(em("billing@app.com", "Your subscription is about to expire on Nov 30.")).toBe("bulk_footer");
    expect(em("dana@hotel.com", "Automatic reply: I am currently out of the office.")).toBe("bulk_footer");
    expect(em("x@shop.com", "המנוי שלך עומד להסתיים בעוד 3 ימים")).toBe("bulk_footer");
    expect(em("x@shop.com", "código de verificación: 4412")).toBe("bulk_footer");
    // A person asking about a code or a login is a customer.
    expect(em("dana@gmail.com", "I didn't get the verification code for my order, can you help?")).toBeNull();
    expect(em("dana@gmail.com", "I can't log in to my account on your site")).toBeNull();
  });

  it("★ the model calling the message a forwarded notification marks it automated", async () => {
    const { MODEL_SAYS_AUTOMATED } = await import("../services/reply-engine/gates");
    expect(MODEL_SAYS_AUTOMATED.test("נראה ששיתפת הודעה מאינסטגרם על איפוס סיסמה.")).toBe(true);
    expect(MODEL_SAYS_AUTOMATED.test("It looks like an automated message from Instagram.")).toBe(true);
    expect(MODEL_SAYS_AUTOMATED.test("It seems you forwarded a notification from your bank.")).toBe(true);
    expect(MODEL_SAYS_AUTOMATED.test("נראה שהמידה הזו תתאים לך.")).toBe(false);
  });

  it("★ no other name than the configured one", async () => {
    const { wrongSelfName, cleanStyle } = await import("../services/reply-engine/gates");
    expect(wrongSelfName("היי, כאן מתן מהצוות. במה אפשר לעזור?", "נועה")).toBe("מתן");
    expect(wrongSelfName("Hi, this is Matan from GOTCHA.", "Noa")).toBe("Matan");
    expect(wrongSelfName("שמי מתן.", "נועה")).toBe("מתן");
    expect(wrongSelfName("היי, כאן נועה. במה אפשר לעזור?", "נועה")).toBeNull();
    expect(wrongSelfName("זה נכון, יש במלאי.", "נועה")).toBeNull();
    expect(wrongSelfName("I'm sorry, it's sold out.", "Noa")).toBeNull();
    // "from <place>" needs its dash: a word that starts with מ after "זה <word>" is no place (2026-11-19).
    for (const ordinary of ["כן, זה ממש מתאים לך.", "את צודקת, זה באמת מבלבל.", "כן, זה בהחלט מומלץ.", "נכון, זה דגם מצוין."]) {
      expect(wrongSelfName(ordinary, "נועה"), ordinary).toBeNull();
      expect(kinds(await g3(ordinary)), ordinary).not.toContain("wrong_identity");
      expect(styleCodes(await g3(ordinary)), ordinary).not.toContain("wrong_identity");
    }
    expect(wrongSelfName("היי, זה מתן מ-GOTCHA.", "נועה")).toBe("מתן");
    expect(wrongSelfName("היי, כאן מתן מ- החנות.", "נועה")).toBe("מתן");
    expect(wrongSelfName("היי, זה מתן.", "נועה")).toBe("מתן");
    expect(wrongSelfName("היי, זאת מיכל מ-GOTCHA.", "נועה")).toBe("מיכל");
    expect(styleCodes(await g3("היי, כאן מתן מהצוות. במה אפשר לעזור?"))).toContain("wrong_identity");
    expect(cleanStyle("היי, כאן מתן מהצוות. במה אפשר לעזור?", ["wrong_identity"], [], "", "", [], "נועה")).toBe("במה אפשר לעזור?");
  });

  it("★ a close name is another model: \"קריספי\" is not \"קרמי\"", async () => {
    const { nearNameAsExact } = await import("../services/reply-engine/gates");
    expect(nearNameAsExact("יש לנו את משטח קרמי ב-₪199.", "יש לכם משטח קריספי?", ["משטח קרמי"])).toEqual({ asked: "קריספי", shown: "קרמי" });
    expect(nearNameAsExact("קריספי לא מצאנו בשם הזה; יש את משטח קרמי, דגם אחר.", "יש לכם משטח קריספי?", ["משטח קרמי"])).toBeNull();
    expect(nearNameAsExact("יש לנו את משטח קריספי ב-₪199.", "יש לכם משטח קריספי?", ["משטח קריספי"])).toBeNull();
    expect(kinds(await g3("יש לנו את משטח קרמי ב-₪199.", { incomingMessage: "יש לכם משטח קריספי?", candidateTitles: ["משטח קרמי"], candidateCount: 1, grounding: "₪199" }))).toContain("near_name");
  });

  it("★ \"no snowboard\" phrasings, and the category lookup after a search that returned others", async () => {
    const { ungroundedAbsence, autoLookups } = await import("../services/reply-engine/gates");
    const ran = [{ tool: "search_products", outcome: "ok", args: { query: "snowboard beginner" }, content: JSON.stringify([{ title: "Wax Kit" }]) }] as any;
    for (const r of ["We don't currently have snowboards.", "There are no snowboards in our catalogue.", "I'm not seeing any snowboards right now.", "Snowboards aren't part of our collection.", "אין בקטלוג סנובורד כרגע."]) {
      expect(ungroundedAbsence(r, ran), r).toHaveLength(1);
    }
    const auto = autoLookups([{ kind: "ungrounded_absence", claims: ["We don't currently have snowboards."] }] as any, "any snowboard for a beginner?", ["search_products"], ran);
    expect(JSON.parse(auto[0].function.arguments).query).toBe("snowboard");
  });
});

/** Rating on 6a383fcb (prod replay 2026-11-17). */
describe("6a383fcb rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ \"passed to the team\" with any object, and \"a person continues\", are claims", async () => {
    const { teamLineIn, removeTeamLines, dropPersonPromises } = await import("../services/reply-engine/gates");
    expect(teamLineIn("העברנו את הבדיקה לצוות ונמשיך כאן בצ׳אט.")).toBe(true);
    expect(teamLineIn("העברתי את פרטי ההזמנה שלך לצוות.")).toBe(true);
    expect(teamLineIn("הצבע הזה מגיע גם בכחול.")).toBe(false);
    expect(kinds(await g3("העברנו את הבדיקה לצוות ונמשיך כאן בצ׳אט."))).toContain("unsupported_action");
    expect(removeTeamLines("מבינים. העברנו את הבדיקה לצוות. נשמח לעזור.")).toBe("מבינים. נשמח לעזור.");
    expect(dropPersonPromises("מבינים. נציג מהצוות ימשיך איתך כאן. נשמח לעזור.")).toBe("מבינים. נשמח לעזור.");
  });

  it("★ \"we recorded it\" needs a write this turn (a tool, or the state)", async () => {
    const { unbackedRecords } = await import("../services/reply-engine/gates");
    expect(unbackedRecords("תודה, רשמנו את סכום ההזמנה.", [])).toHaveLength(1);
    expect(unbackedRecords("Thanks, I've noted your address.", [])).toHaveLength(1);
    expect(unbackedRecords("Your address has been updated.", [])).toHaveLength(1);
    expect(unbackedRecords("עדכנו את הכתובת.", [{ tool: "woocommerce.update_shipping_address", decision: "allow", outcome: "ok" }] as any)).toEqual([]);
    // A read is not a write; a write that failed or awaits approval is not one either.
    expect(unbackedRecords("עדכנו את הכתובת.", [{ tool: "woocommerce.get_order", decision: "allow", outcome: "ok" }] as any)).toHaveLength(1);
    expect(unbackedRecords("עדכנו את הכתובת.", [{ tool: "woocommerce.update_shipping_address", decision: "allow", outcome: "error" }] as any)).toHaveLength(1);
    expect(kinds(await g3("תודה, רשמנו את סכום ההזמנה."))).toContain("unsupported_action");
    // A verb the shared honesty check does not know: only this rule catches it.
    expect(kinds(await g3("תודה, תיעדנו את הבקשה שלך."))).toContain("unsupported_action");
    expect(kinds(await g3("Thanks, your preference has been recorded.", { locale: "en" }))).toContain("unsupported_action");
    const { stripFactProblems } = await import("../services/reply-engine/gates");
    expect(stripFactProblems("תודה, תיעדנו את הבקשה שלך. מה עוד?", await g3("תודה, תיעדנו את הבקשה שלך. מה עוד?"))).toBe("מה עוד?");
    expect(stripFactProblems("תודה, רשמנו את סכום ההזמנה. מה עוד?", await g3("תודה, רשמנו את סכום ההזמנה. מה עוד?"))).toBe("מה עוד?");
  });

  it("★ \"זה מתן מ-GOTCHA\" is a self-name", async () => {
    const { wrongSelfName } = await import("../services/reply-engine/gates");
    expect(wrongSelfName("היי זיו, זה מתן מ-GOTCHA.", "נועה")).toBe("מתן");
    expect(wrongSelfName("היי מתן, זה מתן מ-GOTCHA", "נועה")).toBe("מתן");
    expect(wrongSelfName("אני מתן מ-GOTCHA, במה אפשר לעזור?", "נועה")).toBe("מתן");
    expect(wrongSelfName("היי זיו, זה מתן מ-GOTCHA.", "מתן")).toBeNull();
    expect(styleCodes(await g3("היי זיו, זה מתן מ-GOTCHA."))).toContain("wrong_identity");
  });

  it("★ auto-replies and office-hours notices", async () => {
    const { automatedInbound } = await import("../services/reply-engine/gates");
    const em = (body: string) => automatedInbound({ channel: "GMAIL", sender: "reservations@hotel.com", body });
    expect(em("Thank you for your email. Our reservations department operates Sunday to Thursday, 9:00-17:00.")).toBe("bulk_footer");
    expect(em("Our office hours are 9-17. We will respond within 24 hours.")).toBe("bulk_footer");
    expect(em("This mailbox is not monitored.")).toBe("bulk_footer");
    expect(em("Automated response: we got your message.")).toBe("bulk_footer");
    expect(em("Hi, what are your office hours on Friday?")).toBeNull();
  });

  it("★ a filtered or in-stock-only search proves nothing about the item; the engine looks again without the filter", async () => {
    const { ungroundedAbsence, filteredSearch, autoLookups } = await import("../services/reply-engine/gates");
    const shopify = [{ tool: "search_products", outcome: "empty", args: { query: "snowboard" } }] as any;
    expect(filteredSearch(shopify[0])).toBe(true);
    expect(ungroundedAbsence("I didn't find a snowboard in the catalogue.", shopify)).toHaveLength(1);
    const all = [{ tool: "search_products", outcome: "empty", args: { query: "snowboard", in_stock_only: false } }] as any;
    expect(ungroundedAbsence("I didn't find a snowboard in the catalogue.", all)).toEqual([]);
    const priced = [{ tool: "woocommerce.list_products", outcome: "empty", args: { query: "snowboard", price_max: 650 } }] as any;
    expect(ungroundedAbsence("We don't have a snowboard.", priced)).toHaveLength(1);
    expect(filteredSearch({ tool: "woocommerce.list_products", args: { query: "x" } } as any)).toBe(false);
    const auto = autoLookups([{ kind: "ungrounded_absence", claims: ["I didn't find a snowboard in the catalogue."] }] as any, "a snowboard under $650?", ["search_products"], shopify);
    expect(JSON.parse(auto[0].function.arguments)).toEqual({ query: "snowboard", limit: 5, in_stock_only: false });
  });

  it("★ curly apostrophes and quotes read like ASCII ones, in every check", async () => {
    const { normalizeQuotes, stripFactProblems } = await import("../services/reply-engine/gates");
    expect(normalizeQuotes("didn\u2019t \u201Cx\u201D צ\u05F3אט")).toBe(`didn't "x" צ'אט`);
    const shopify = [{ tool: "shopify.search_products", outcome: "empty", args: { query: "snowboard" } }, { tool: "search_products", outcome: "empty", args: { query: "snowboard" } }];
    const curly = "I didn\u2019t find a snowboard in the catalogue. Want something else?";
    const ps = await g3(curly, { tools: shopify, locale: "en", toolsOffered: ["search_products"] });
    expect(kinds(ps)).toContain("ungrounded_absence");
    expect(stripFactProblems(curly, ps)).toBe("Want something else?");
    expect(kinds(await g3("We don\u2019t sell desk lamps.", { locale: "en", toolsOffered: ["search_products"] }))).toContain("ungrounded_absence");
  });
});

/** Rating on 3ca1dabe (prod 2026-11-17, six tenants): the Smoovee blocker and the generic fixes. */
describe("3ca1dabe rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ stock for one option needs that option's own data (a variation or variant read)", async () => {
    const { optionClaimsWithoutVariations } = await import("../services/reply-engine/gates");
    const parent = [{ tool: "woocommerce.get_product", outcome: "ok", content: JSON.stringify({ id: 9, name: "משטח", stock_status: "instock" }) }] as any;
    expect(optionClaimsWithoutVariations("השחור במלאי עכשיו.", "מתי השחור יחזור למלאי?", parent)).toHaveLength(1);
    expect(optionClaimsWithoutVariations("Black is in stock now.", "when will black be back in stock?", parent)).toHaveLength(1);
    const vars = [...parent, { tool: "woocommerce.list_product_variations", outcome: "ok", content: JSON.stringify([{ id: 91, attributes: [{ option: "שחור" }], stock_status: "outofstock" }]) }] as any;
    expect(optionClaimsWithoutVariations("השחור אזל כרגע.", "מתי השחור יחזור למלאי?", vars)).toEqual([]);
    const shopify = [{ tool: "shopify.get_product", outcome: "ok", content: JSON.stringify({ title: "Tee", variants: [{ title: "Black", available: false }] }) }] as any;
    expect(optionClaimsWithoutVariations("Black is sold out.", "is the black one in stock?", shopify)).toEqual([]);
    // No option asked: the parent's stock is the answer, a simple product's own colour included.
    expect(optionClaimsWithoutVariations("המשטח במלאי.", "יש במלאי?", parent)).toEqual([]);
    expect(optionClaimsWithoutVariations("המשטח השחור במלאי.", "המשטח במלאי?", parent)).toEqual([]);
    expect(kinds(await g3("השחור במלאי עכשיו.", { incomingMessage: "מתי השחור יחזור למלאי?", tools: parent }))).toContain("option_without_variation");
  });

  it("★ a failed search never hands the work back, never ends in an empty \"we'll check\"", async () => {
    const { gaveUpSearch, returnsWork, cleanStyle, unbackedPromises } = await import("../services/reply-engine/gates");
    const failed = [{ tool: "woocommerce.list_products", outcome: "timeout" }] as any;
    expect(returnsWork("לא מצאתי, נסי שם אחר.")).toBe(true);
    expect(returnsWork("כדאי לבדוק באתר.")).toBe(true);
    expect(returnsWork("Try another name, or check our website.")).toBe(true);
    expect(returnsWork("באתר יש את כל הדגמים.")).toBe(false);
    expect(gaveUpSearch("נסי שם אחר.", failed)).toBe(true);
    expect(gaveUpSearch("מעולה, העברתי לצוות.", failed, "מחפשת משטח למיקסר", true)).toBe(true);
    expect(gaveUpSearch("מעולה, העברתי לצוות.", failed, "מה עם ההזמנה שלי?", true)).toBe(false);
    expect(styleCodes(await g3("יש כמה דגמים. כדאי לבדוק באתר."))).toContain("returns_work");
    expect(cleanStyle("יש כמה דגמים. כדאי לבדוק באתר.", ["returns_work"])).toBe("יש כמה דגמים.");
    expect(unbackedPromises("נבדוק את זה ונחזור.", { teamQuestion: false, handedOff: false, teamAlreadyOpen: false, approvalPending: false })).not.toEqual([]);
    expect(unbackedPromises("We'll check it and get back to you.", { teamQuestion: false, handedOff: false, teamAlreadyOpen: false, approvalPending: false })).not.toEqual([]);
  });

  it("★ a payment problem is a support case: a handoff may stand, and it is no product ask", async () => {
    const { paymentProblem, productAskNow, needlessHandoff } = await import("../services/reply-engine/gates");
    expect(paymentProblem("לא מצליח לשלם עם ביימי")).toBe(true);
    expect(paymentProblem("התשלום לא עובר")).toBe(true);
    expect(paymentProblem("my card was declined at checkout")).toBe(true);
    expect(paymentProblem("אפשר לשלם בביט?")).toBe(false);
    expect(productAskNow("לא מצליח לשלם עם ביימי")).toBe(false);
    expect(productAskNow("יש לכם משטח במבוק?")).toBe(true);
    expect(productAskNow("יש משטחי במבוק?")).toBe(true);
    expect(productAskNow("ההזמנה שלי 5512 לא הגיעה")).toBe(false);
    expect(needlessHandoff("payment", ["לא מצליח לשלם עם ביימי"], false)).toBe(false);
  });

  it("★ recommend after the qualifying question was answered: pick, a question is not enough", async () => {
    const { noRecommendation } = await import("../services/reply-engine/gates");
    const inbound = ["איזה גוון מתאים לי?", "חם, עור בהיר"];
    const lastBot = "יש לך גוון עור חם או קר?";
    expect(noRecommendation("יש לנו כמה גוונים. איזה מרקם מעדיפים?", "חם, עור בהיר", 3, inbound, lastBot)).toBe(true);
    expect(noRecommendation("הגוון Warm Beige הכי מתאים לך, כי הוא מיועד לעור בהיר עם גוון חם.", "חם, עור בהיר", 3, inbound, lastBot)).toBe(false);
    // Asked now: one question is still fine.
    expect(noRecommendation("איזה גוון עור יש לך?", "איזה גוון מתאים לי?", 3, [], "")).toBe(false);
  });

  it("★ the configured name in the other alphabet is the employee's; another name is not", async () => {
    const { wrongSelfName, nameSkeleton } = await import("../services/reply-engine/gates");
    expect(nameSkeleton("דניאל")).toBe(nameSkeleton("Daniel"));
    expect(wrongSelfName("היי, זה דניאל מ-GOTCHA.", "Daniel")).toBeNull();
    expect(wrongSelfName("היי מתן, זה מתן מ-GOTCHA", "Daniel")).toBe("מתן");
    expect(wrongSelfName("היי מתן זה מתן מ־GOTCHA", "Daniel")).toBe("מתן");
    expect(wrongSelfName("זה נכון מאוד.", "Daniel")).toBeNull();
  });
});

/** Rating on 2f6ff7e3 (prod replay 2026-11-17). */
describe("2f6ff7e3 rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ each subject the customer raised must be an open team item, or it is recorded", async () => {
    const { uncoveredSubjects } = await import("../services/reply-engine/engine");
    expect(uncoveredSubjects("מה עם הלבן והקופון?", ["הקופון שלא עבד בקופה"])).toEqual(["מה עם הלבן"]);
    expect(uncoveredSubjects("מה עם הקופון?", ["הקופון שלא עבד בקופה"])).toEqual([]);
    expect(uncoveredSubjects("the white one, and the coupon?", ["coupon did not work"])).toEqual(["the white one"]);
    expect(uncoveredSubjects("מה עם הצבע?", ["הקופון שלא עבד"])).toEqual(["מה עם הצבע?"]);
    // A number is a detail of the open item, not a subject of its own.
    expect(uncoveredSubjects("התשלום בביימי לא עבר, הכרטיס נגמר ב-4155", ["התשלום בביימי לא עבר"])).toEqual([]);
  });

  it("★ a repeat with new digits updates the open item", async () => {
    const { withNewDetails } = await import("../services/reply-engine/engine");
    const pending = [{ kind: "promise", text: "checking with the team: התשלום בביימי לא עבר", at: "x" }];
    const u = withNewDetails(pending, "התשלום בביימי לא עבר", "הכרטיס שלי נגמר ב-4155");
    expect(u?.added).toEqual(["4155"]);
    expect(u?.pending[0].text).toMatch(/customer gave: 4155/);
    expect(withNewDetails(u!.pending, "התשלום בביימי לא עבר", "4155")).toBeNull();
    expect(withNewDetails(pending, "התשלום בביימי לא עבר", "עדיין לא עובד")).toBeNull();
    // The matching TEAM item, not whatever comes first.
    const mixed = [{ kind: "pending", text: "checking with the team: התשלום בביימי לא עבר", at: "x" }, ...pending];
    const m = withNewDetails(mixed, "התשלום בביימי לא עבר", "4155");
    expect(m?.pending[0].text).toBe("checking with the team: התשלום בביימי לא עבר");
    expect(m?.pending[1].text).toMatch(/customer gave: 4155/);
  });

  it("★ no order, or it cannot be located, only after the customer's own order lookup; never \"per the terms\"", async () => {
    const { ungroundedOrderAbsence, termsRefusal, autoLookups, cleanStyle } = await import("../services/reply-engine/gates");
    const r = "אין מספר הזמנה, ולכן לא ניתן לאתר את ההזמנה.";
    expect(ungroundedOrderAbsence(r, [])).toHaveLength(1);
    expect(ungroundedOrderAbsence("We can't find an order under that name.", [])).toHaveLength(1);
    expect(ungroundedOrderAbsence(r, [{ tool: "woocommerce.list_customer_orders", outcome: "empty" }] as any)).toEqual([]);
    expect(kinds(await g3(r))).toContain("ungrounded_absence");
    // A phrasing only the order rule knows.
    expect(kinds(await g3("There's no order under this number.", { locale: "en" }))).toContain("ungrounded_absence");
    const auto = autoLookups([{ kind: "ungrounded_absence", claims: [r] }] as any, "מה עם ההזמנה שלי?", ["woocommerce.list_customer_orders", "woocommerce.list_products"], []);
    expect(auto.map((a) => a.function.name)).toEqual(["woocommerce.list_customer_orders"]);
    expect(JSON.parse(auto[0].function.arguments)).toEqual({});
    expect(termsRefusal("לפי התקנון לא ניתן לאתר הזמנה בלי מספר.")).toBe(true);
    expect(termsRefusal("According to our terms we cannot help without an order number.")).toBe(true);
    expect(termsRefusal("לפי התקנון, אפשר להחזיר תוך 14 יום.")).toBe(false);
    expect(styleCodes(await g3("לפי התקנון לא ניתן לאתר הזמנה בלי מספר. נשמח לעזור."))).toContain("terms_refusal");
    expect(cleanStyle("לפי התקנון לא ניתן לאתר הזמנה בלי מספר. נשמח לעזור.", ["terms_refusal"])).toBe("נשמח לעזור.");
  });

  it("★ products answer a product ask only: not a policy, coupon or how-to question", async () => {
    const { productAskNow } = await import("../services/reply-engine/gates");
    expect(productAskNow("יש משטחי במבוק?")).toBe(true);
    expect(productAskNow("מחפשת משטח למיקסר")).toBe(true);
    expect(productAskNow("מה מדיניות ההחזרות?")).toBe(false);
    expect(productAskNow("איך מזינים את הקופון?")).toBe(false);
    expect(productAskNow("איך מנקים את המשטח?")).toBe(false);
    // A how-to that names what fits is still a how-to.
    expect(productAskNow("איך מנקים משטח? אני מחפשת משהו קל לניקוי")).toBe(false);
    expect(productAskNow("יש עדכון?")).toBe(false);
    expect(productAskNow("how do I clean it?")).toBe(false);
    expect(productAskNow("how do I order?")).toBe(true);
  });

  it("★ \"where do I find it\" after a code was discussed is a get-vs-use ask", async () => {
    const { couponSourceMissed } = await import("../services/reply-engine/gates");
    expect(couponSourceMissed("איפה מוצאת את זה?", "מזינים את הקוד בשדה בעמוד התשלום.", "יש לכם קוד קופון?")).toBe(true);
    expect(couponSourceMissed("איפה מוצאת את זה?", "מזינים את הקוד בשדה בעמוד התשלום.", "יש לכם משטח לבן?")).toBe(false);
    expect(kinds(await g3("מזינים את הקוד בשדה בעמוד התשלום.", { incomingMessage: "איפה מוצאת את זה?", recentInbound: ["יש לכם קוד קופון?", "איפה מוצאת את זה?"] }))).toContain("coupon_source");
  });

  it("★ a qualifier narrows: only the products that carry it", async () => {
    const { notNarrowed } = await import("../services/reply-engine/gates");
    const titles = ["Foundation Fair", "Foundation Light", "Foundation Medium Dark"];
    expect(notNarrowed("Foundation Fair or Foundation Medium Dark would work.", "fair skin, which shade?", titles)).toEqual(["Foundation Medium Dark"]);
    expect(notNarrowed("Foundation Fair is the one.", "fair skin, which shade?", titles)).toEqual([]);
    expect(notNarrowed("Foundation Fair and Foundation Light.", "which shade?", titles)).toEqual([]);
    expect(kinds(await g3("Foundation Fair or Foundation Medium Dark.", { incomingMessage: "fair skin", candidateTitles: titles, candidateCount: 3, locale: "en" }))).toContain("not_narrowed");
  });
});

/** Rating on 4511b79c (prod 2026-11-17, Smoovee live). */
describe("4511b79c rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);

  it("★ \"we'll check X with the team\" needs a team item or a handoff", async () => {
    const { unbackedPromises, stripFactProblems } = await import("../services/reply-engine/gates");
    const o = { teamQuestion: false, handedOff: false, teamAlreadyOpen: false, approvalPending: false };
    expect(unbackedPromises("נבדוק את הפער מול הצוות ונעדכן.", o)).not.toEqual([]);
    expect(unbackedPromises("נברר את זה אצלנו.", o)).not.toEqual([]);
    expect(unbackedPromises("We'll check this with the team.", o)).not.toEqual([]);
    expect(unbackedPromises("נבדוק את הפער מול הצוות.", { ...o, teamQuestion: true })).toEqual([]);
    expect(unbackedPromises("נבדוק את הפער מול הצוות.", { ...o, teamAlreadyOpen: true })).toEqual([]);
    expect(unbackedPromises("אפשר לבדוק את המידות בטבלה.", o)).toEqual([]);
    const r = "מבינים. נבדוק את הפער מול הצוות. בינתיים יש במלאי.";
    expect(stripFactProblems(r, await g3(r))).toBe("מבינים. בינתיים יש במלאי.");
  });

  it("★ where a code comes from only from the knowledge", async () => {
    const { ungroundedSource } = await import("../services/reply-engine/gates");
    expect(ungroundedSource("איפה מוצאת את הקוד עצמו?", "את הקוד עצמו מקבלים מהצוות.", "", "")).toHaveLength(1);
    expect(ungroundedSource("איפה מוצאת את הקוד עצמו?", "את הקוד עצמו מקבלים בניוזלטר.", "", "קוד הנחה נשלח לכל מי שנרשם לניוזלטר.")).toEqual([]);
    expect(ungroundedSource("איפה מוצאת את זה?", "מקבלים אותו מהצוות.", "יש לכם קוד קופון?", "")).toHaveLength(1);
    expect(ungroundedSource("יש לכם משטח?", "מקבלים אותו מהצוות.", "", "")).toEqual([]);
    expect(kinds(await g3("את הקוד עצמו מקבלים מהצוות.", { incomingMessage: "איפה מוצאת את הקוד עצמו?" }))).toContain("ungrounded_source");
  });

  it("★ a product price from the store, never a document's", async () => {
    const { priceAgainstStore } = await import("../services/reply-engine/gates");
    const c = [{ title: "Velvet Foundation", price: 160.2 }];
    const read = [{ tool: "woocommerce.list_products", outcome: "ok", content: "[{\"price\":\"160.20\"}]" }] as any;
    expect(priceAgainstStore("Velvet Foundation עולה 178 ₪.", c, read, true)).toHaveLength(1);
    expect(priceAgainstStore("Velvet Foundation עולה 160.20 ₪.", c, read, true)).toEqual([]);
    // No store read: a product price from a document is not stated.
    expect(priceAgainstStore("המוצר עולה 178 ₪.", [], [], true)).toHaveLength(1);
    // Shipping is no product.
    expect(priceAgainstStore("המשלוח עולה 30 ₪.", [], [], true)).toEqual([]);
    expect(priceAgainstStore("המוצר עולה 178 ₪.", [], [], false)).toEqual([]);
    expect(kinds(await g3("Velvet Foundation עולה 178 ₪.", { candidatePrices: c, tools: read, grounding: "178 ₪ 160.20", toolsOffered: ["woocommerce.list_products"] }))).toContain("price_against_store");
  });

  it("★ an order's state is never stated when every order lookup failed", async () => {
    const { orderStateWithoutLookup } = await import("../services/reply-engine/gates");
    const failed = [{ tool: "shopify.get_order", outcome: "error" }, { tool: "shopify.track_shipment", outcome: "timeout" }] as any;
    expect(orderStateWithoutLookup("ההזמנה עדיין לא בוטלה.", failed)).toHaveLength(1);
    expect(orderStateWithoutLookup("Your order was shipped yesterday.", failed)).toHaveLength(1);
    expect(orderStateWithoutLookup("ההזמנה עדיין לא בוטלה.", [...failed, { tool: "shopify.get_orders", outcome: "ok" }] as any)).toEqual([]);
    expect(orderStateWithoutLookup("ההזמנה עדיין לא בוטלה.", [])).toEqual([]);
    expect(kinds(await g3("ההזמנה עדיין לא בוטלה.", { tools: failed }))).toContain("order_state_unread");
  });

  it("★ back on an open team subject, saying it is with the team is no repeat", async () => {
    const { repeatedTeamLine } = await import("../services/reply-engine/gates");
    expect(repeatedTeamLine("זה כבר אצל הצוות.", "ומה עם הגוון?", true, false, false)).toBe(true);
    expect(repeatedTeamLine("זה כבר אצל הצוות.", "ומה עם הגוון?", true, false, true)).toBe(false);
  });
});

/** Rating on e78b114c (prod 2026-11-17, six tenants live). */
describe("e78b114c rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);

  it("★ an inactive order known from an earlier turn still needs its status", async () => {
    const { unlabelledInactiveOrders } = await import("../services/reply-engine/gates");
    expect(unlabelledInactiveOrders("מספר ההזמנה הוא 97858.", [], ["97858"])).toHaveLength(1);
    expect(unlabelledInactiveOrders("ההזמנה 97858 בוטלה.", [], ["97858"])).toEqual([]);
    expect(kinds(await g3("מספר ההזמנה הוא 97858.", { knownInactiveOrders: ["97858"] }))).toContain("inactive_order_unlabelled");
    const { inactiveOrdersFact } = await import("../services/reply-engine/engine");
    expect(inactiveOrdersFact("111,222", ["333", "111"])).toEqual({ _inactiveOrders: "111,222,333" });
    expect(inactiveOrdersFact("111", [])).toEqual({});
  });

  it("★ an apology alone on a support case is hollow", async () => {
    const { tooThin, ackOnly } = await import("../services/reply-engine/gates");
    expect(ackOnly("מצטערים על הבלבול.")).toBe(true);
    expect(ackOnly("מצטערים על הבלבול. ההזמנה בדרך.")).toBe(false);
    expect(tooThin("מצטערים על הבלבול.", "מצטערים על הבלבול.", "חויבתי ואין הזמנה")).toBe(true);
    expect(tooThin("We understand, sorry about that.", "We understand, sorry about that.", "my payment failed")).toBe(true);
    expect(tooThin("תודה!", "תודה!", "תודה רבה")).toBe(false);
  });

  it("★ a recommend ask with no store search is no_search; a pick is a pick", async () => {
    const { picksProduct } = await import("../services/reply-engine/gates");
    expect(kinds(await g3("כל הלוחות שלנו מעולים.", { incomingMessage: "which board would you recommend for a beginner?", locale: "en", toolsOffered: ["shopify.search_products"] }))).toContain("no_search");
    expect(kinds(await g3("כל הלוחות שלנו מעולים.", { incomingMessage: "which board would you recommend for a beginner?", locale: "en", toolsOffered: ["shopify.search_products"], tools: [{ tool: "shopify.search_products", outcome: "ok" }] }))).not.toContain("no_search");
    expect(picksProduct("The Drift 154 is the best fit for a beginner, because it is soft.")).toBe(true);
    expect(picksProduct("We have the Drift and the Ridge.")).toBe(false);
  });

  it("★ a team question is the subject plus the ask; a status ask on an open item is none", async () => {
    const { teamQuestionText } = await import("../services/reply-engine/engine");
    const st = { intent: "משטח למיקסר קנווד", offeredItems: [] };
    expect(teamQuestionText("אני רוצה עם מעצור 1", "אני רוצה עם מעצור 1", st, [])).toBe("משטח למיקסר קנווד: אני רוצה עם מעצור 1");
    expect(teamQuestionText("יש חדש?", "יש חדש?", st, ["משטח למיקסר"])).toBeNull();
    // The model's own summary stands as written.
    expect(teamQuestionText("Does the 30x40 mat fit a Kenwood Chef?", "does it fit?", st, [])).toBe("Does the 30x40 mat fit a Kenwood Chef?");
    expect(teamQuestionText("call request: תתקשרו", "תתקשרו", st, [])).toBe("call request: תתקשרו");
  });
});

/** 39b65d68 regressed (prod replay 2026-11-17): the team question's text quoted to the customer. */
describe("39b65d68 regression fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);

  it("★ the \"still checking\" line is a fixed noun or neutral, never the item's text", async () => {
    const { stillCheckingLine } = await import("../services/reply-engine/engine");
    expect(stillCheckingLine("איך הלקוחה מקבלת או מוצאת קוד קופון?", "he")).toBe("הקופון עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.");
    expect(stillCheckingLine("חיוב כפול בביימי", "he")).toBe("החיוב עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.");
    expect(stillCheckingLine("which suitable models are availabl", "en")).toBe("This is still being checked by the team; the answer will come here in the chat.");
    expect(stillCheckingLine("משהו אחר לגמרי", "he")).toBe("זה עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.");
  });

  it("★ an offer to ask is not followed by \"I passed it\"", async () => {
    const { offersToAsk } = await import("../services/reply-engine/engine");
    expect(offersToAsk("Would you like me to ask the team about it?")).toBe(true);
    expect(offersToAsk("רוצה שאבדוק את זה מול הצוות?")).toBe(true);
    expect(offersToAsk("יש לנו את זה בשחור.")).toBe(false);
  });

  it("★ \"we got the photo\" with no media sent is a FACT problem", async () => {
    const { claimsAttachment } = await import("../services/reply-engine/gates");
    expect(claimsAttachment("קיבלנו את התמונה, תודה. נבדוק.", ["היי", "יש בעיה במשטח"])).toHaveLength(1);
    expect(claimsAttachment("Thanks for the photo.", ["here"])).toHaveLength(1);
    expect(claimsAttachment("קיבלנו את התמונה, תודה.", ["יש בעיה", "[Image]"])).toEqual([]);
    expect(kinds(await g3("קיבלנו את התמונה, תודה.", { recentInbound: ["יש בעיה במשטח"] }))).toContain("claims_attachment");
  });

  it("★ a cancel or refund request keeps its handoff", async () => {
    const { needlessHandoff, cancelRequest } = await import("../services/reply-engine/gates");
    expect(cancelRequest("אני רוצה לבטל את ההזמנה")).toBe(true);
    expect(cancelRequest("please cancel my order")).toBe(true);
    expect(needlessHandoff("cancel", ["אני רוצה לבטל את ההזמנה"], false)).toBe(false);
    expect(needlessHandoff("cancel", ["I want a refund"], false)).toBe(false);
    expect(needlessHandoff("x", ["יש לכם בשחור?"], false)).toBe(true);
  });

  it("★ a greeting name only when it reads as a name", async () => {
    const { greetingName } = await import("../services/reply-engine/engine");
    expect(greetingName("SharonKampinski")).toBeNull();
    expect(greetingName("sharon_k")).toBeNull();
    expect(greetingName("user123")).toBeNull();
    expect(greetingName("Sharon Kampinski")).toBe("Sharon");
    expect(greetingName("שרון כהן")).toBe("שרון");
    expect(greetingName("")).toBeNull();
  });
});

/** First live replies on v2 (NE'A web chat, 2026-11-17). */
describe("first live replies", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ a clarifying question never asks back a detail the customer gave", async () => {
    const { asksKnown, cleanStyle } = await import("../services/reply-engine/gates");
    expect(asksKnown("יש טינט מעולה. התכוונת לטינט לפנים או לשפתיים?", "אני צריכה טינט לפנים, מה ממליצים?")).toHaveLength(1);
    expect(asksKnown("There is a great one. Did you mean a tint for the face or the lips?", "I need a face tint, what do you recommend")).toHaveLength(1);
    expect(asksKnown("התכוונת לטינט לפנים או לשפתיים?", "אני צריכה טינט, מה ממליצים?")).toEqual([]);
    expect(styleCodes(await g3("יש טינט מעולה. התכוונת לפנים או לשפתיים?", { incomingMessage: "אני צריכה טינט לפנים" }))).toContain("asks_known");
    expect(cleanStyle("יש טינט מעולה. התכוונת לפנים או לשפתיים?", ["asks_known"], [], "", "אני צריכה טינט לפנים")).toBe("יש טינט מעולה.");
  });

  it("★ a recommendation names the product", async () => {
    const { unnamedRecommendation } = await import("../services/reply-engine/gates");
    const titles = ["מייקאפ טינט SPF50"];
    expect(unnamedRecommendation("מוצר אחד שמתאים לטינט לפנים הוא כיסוי בינוני שנבנה, SPF50.", titles)).toBe(true);
    expect(unnamedRecommendation("One product that fits is medium buildable coverage, SPF50.", titles)).toBe(true);
    expect(unnamedRecommendation("מייקאפ טינט SPF50: כיסוי בינוני שנבנה, 160.20 ₪.", titles)).toBe(false);
    expect(unnamedRecommendation("מוצר אחד שמתאים הוא מייקאפ טינט SPF50.", titles)).toBe(false);
    expect(kinds(await g3("מוצר אחד שמתאים הוא כיסוי בינוני.", { candidateTitles: titles, candidateCount: 1 }))).toContain("unnamed_recommendation");
  });
});

/** Rating on 057d37db (prod replay 2026-11-17). */
describe("057d37db rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);
  const styleCodes = (ps: any[]) => ps.filter((p) => p.kind === "style").flatMap((p) => p.codes);

  it("★ orders found contradict \"no order\"; payment speculation is never a fact", async () => {
    const { ungroundedOrderAbsence, ungroundedPayment } = await import("../services/reply-engine/gates");
    const found = [{ tool: "woocommerce.list_customer_orders", outcome: "ok", content: "[{\"id\":97858,\"status\":\"cancelled\"}]" }] as any;
    const empty = [{ tool: "woocommerce.list_customer_orders", outcome: "empty" }] as any;
    expect(ungroundedOrderAbsence("לא נוצרה הזמנה, ולכן לא ניתן לאתר את ההזמנה.", found)).toHaveLength(1);
    expect(ungroundedOrderAbsence("לא ניתן לאתר את ההזמנה.", empty)).toEqual([]);
    const spec = "יכול להיות שהאישור בויזה לא הפך לחיוב סופי, ולכן לא נוצרה הזמנה.";
    expect(ungroundedPayment(spec, found)).toHaveLength(1);
    expect(ungroundedPayment("Maybe the authorization never went through, so no order was created.", found)).toHaveLength(1);
    expect(ungroundedPayment("ההזמנה 97858 בוטלה.", found)).toEqual([]);
    // Even with the order's payment data in hand, speculation about the payment is not a fact.
    const paid = [{ tool: "woocommerce.get_order", outcome: "ok", content: "{\"id\":97858,\"status\":\"cancelled\",\"date_paid\":null}" }] as any;
    expect(ungroundedPayment(spec, paid)).toHaveLength(1);
    expect(ungroundedPayment("ההזמנה בוטלה ולא חויבת.", paid)).toEqual([]);
    const { namedInResults } = await import("../services/reply-engine/engine");
    expect(namedInResults("יש מעצור לאליס?", [{ title: "מעצור אליס" }])).toBe(true);
    expect(namedInResults("יש מעצור לאליס?", [{ title: "משטח כריסטינה" }])).toBe(false);
  });

  it("★ \"fits <a close but different model>\" is near_name", async () => {
    const { nearNameAsExact } = await import("../services/reply-engine/gates");
    expect(nearNameAsExact("לנינג'ה קריספי, סמובי גפן מתאימה לנינג'ה קרמי.", "יש משטח לנינג'ה קריספי?", [])).toEqual({ asked: "קריספי", shown: "קרמי" });
    expect(nearNameAsExact("סמובי גפן מתאימה לנינג'ה קריספי.", "יש משטח לנינג'ה קריספי?", [])).toBeNull();
    expect(nearNameAsExact("The Gefen mat fits the Ninja Crami.", "a mat for the Ninja Crispi?", [])).toEqual({ asked: "crispi", shown: "crami" });
  });

  it("★ any team-pass statement counts before a team line is appended", async () => {
    const { teamPassIn } = await import("../services/reply-engine/gates");
    expect(teamPassIn("נעביר את זה לצוות שיבדוק.")).toBe(true);
    expect(teamPassIn("הצוות יבדוק ויעדכן כאן.")).toBe(true);
    expect(teamPassIn("We'll check with the team.")).toBe(true);
    expect(teamPassIn("יש לנו את זה בשחור.")).toBe(false);
  });

  it("★ a link or price the employee sent earlier is never denied", async () => {
    const { contradictsEarlier } = await import("../services/reply-engine/gates");
    const prev = ["הנה סרטון ההדרכה: https://youtube.com/watch?v=x"];
    expect(contradictsEarlier("אין לי קישור לסרטון כרגע.", prev)).toHaveLength(1);
    expect(contradictsEarlier("There's no video link available.", prev)).toHaveLength(1);
    expect(contradictsEarlier("אין לי קישור לסרטון כרגע.", ["שלום"])).toEqual([]);
    expect(contradictsEarlier("אין לי את המחיר.", ["המשטח עולה ₪199."])).toHaveLength(1);
    expect(kinds(await g3("אין לי קישור לסרטון כרגע.", { previousBotReplies: prev }))).toContain("ungrounded_absence");
  });

  it("★ a return question gets returns and exchanges when the business has both", async () => {
    const { partialReturnPolicy } = await import("../services/reply-engine/gates");
    const k = "החזרות: עד 14 יום, זיכוי מלא. החלפות: עד 30 יום.";
    expect(partialReturnPolicy("אפשר להחזיר עד 14 יום ולקבל זיכוי.", "איך מחזירים?", k)).toBe(true);
    expect(partialReturnPolicy("החזרה עד 14 יום, והחלפה עד 30 יום.", "איך מחזירים?", k)).toBe(false);
    expect(partialReturnPolicy("אפשר להחזיר עד 14 יום.", "איך מחזירים?", "החזרות: עד 14 יום.")).toBe(false);
    expect(kinds(await g3("אפשר להחזיר עד 14 יום ולקבל זיכוי.", { incomingMessage: "איך מחזירים?", knowledge: k }))).toContain("partial_return_policy");
  });

  it("★ \"the assistant\" alone becomes the configured name", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    expect(styleCodes(await g3("היי, זה העוזר של GOTCHA. במה אפשר לעזור?", { employeeName: "Daniel" }))).toContain("nameless_self");
    expect(cleanStyle("היי, זה העוזר של GOTCHA. במה אפשר לעזור?", ["nameless_self"], [], "", "", [], "Daniel")).toBe("היי, זה Daniel מ-GOTCHA. במה אפשר לעזור?");
    expect(cleanStyle("Hi, this is the AI assistant from GOTCHA.", ["nameless_self"], [], "", "", [], "Daniel")).toBe("Hi, this is Daniel from GOTCHA.");
  });
});

/** Rating on 1f510cc4 (two Smoovee runs, 2026-11-17): what repeats in both. */
describe("1f510cc4 rating fixes", () => {
  const g3 = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "תודה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kinds = (ps: any[]) => ps.map((p) => p.kind);

  it("★ no product twice and no line twice in one message", async () => {
    const { assembleOnce } = await import("../services/reply-engine/engine");
    const prose = "הנה מה שיש לנו שמתאים:\n• סמובי אלכסה, ₪199\n• סמובי כריסטינה, ₪229";
    const list = "סמובי אלכסה\n₪199\nבמלאי\nhttps://x/a\n\nסמובי כריסטינה\n₪229\nבמלאי\nhttps://x/c";
    const out = assembleOnce(prose, list, ["סמובי אלכסה", "סמובי כריסטינה"]);
    expect((out.match(/סמובי אלכסה/g) ?? []).length).toBe(1);
    expect((out.match(/סמובי כריסטינה/g) ?? []).length).toBe(1);
    expect(assembleOnce("הנה מה שיש לנו שמתאים:\nהנה מה שיש לנו שמתאים:\nתודה", null, [])).toBe("הנה מה שיש לנו שמתאים:\nתודה");
    expect(assembleOnce("הנה מה שיש לנו שמתאים.\nהנה מה שיש לנו שמתאים:\n• Canvas Tote, ₪79", null, [])).toBe("הנה מה שיש לנו שמתאים.\n• Canvas Tote, ₪79");
    // The replay's exact shape: the fallback's bullets inline, each with its price, then the same three listed.
    const inline = "הנה מה שיש לנו שמתאים: • סמובי אלכסה, 30*40, ₪199 • סמובי כריסטינה, 34*38, ₪229 • סמובי גפן, 40*50, ₪249";
    const three = "סמובי אלכסה\n₪199\nhttps://x/a\n\nסמובי כריסטינה\n₪229\nhttps://x/c\n\nסמובי גפן\n₪249\nhttps://x/g";
    const once = assembleOnce(inline, three, ["סמובי אלכסה", "סמובי כריסטינה", "סמובי גפן"]);
    for (const t of ["סמובי אלכסה", "סמובי כריסטינה", "סמובי גפן"]) expect((once.match(new RegExp(t, "g")) ?? []).length).toBe(1);
    // A product the text only names (no price, no link) keeps its details in the list.
    expect(assembleOnce("סמובי אלכסה מתאים לך.", "סמובי אלכסה\n₪199\nhttps://x/a", ["סמובי אלכסה"])).toMatch(/https:\/\/x\/a/);
  });

  it("★ a product said to fit another device than the customer's is cut", async () => {
    const { deviceMismatch } = await import("../services/reply-engine/gates");
    expect(deviceMismatch("סמובי גפן מתאימה לנינג'ה סלושי, הנה הקישור.", "יש משטח לנינג'ה קריספי?")).toHaveLength(1);
    expect(deviceMismatch("The Gefen mat fits the Ninja Slushi.", "a mat for my Ninja Crispi?")).toHaveLength(1);
    expect(deviceMismatch("סמובי גפן מתאימה לנינג'ה קריספי.", "יש משטח לנינג'ה קריספי?")).toEqual([]);
    expect(deviceMismatch("סמובי גפן מתאימה לכל המכשירים.", "יש משטח לנינג'ה קריספי?")).toEqual([]);
    expect(kinds(await g3("סמובי גפן מתאימה לנינג'ה סלושי.", { incomingMessage: "יש משטח לנינג'ה קריספי?" }))).toContain("device_mismatch");
  });

  it("★ a fit word after a \"not\" is no fit for another device; a plain one beside it in the same sentence still is", async () => {
    const { deviceMismatch } = await import("../services/reply-engine/gates");
    const pens = "יש טוש לעיניים?", penEn = "do you have a pen for eyes?";
    // An honest "does not fit" (Supervisor, 2026-11-19), each beside the same words without the "not".
    for (const [no, plain, incoming] of [
      ["הטושים לא מתאימים לעיניים רגישות, אבל לעיניים רגילות הם מתאימים.", "הטושים מתאימים לעיניים רגישות, אבל לעיניים רגילות הם מתאימים.", pens],
      ["הטושים לא מתאימים לעיניים רגישות.", "הטושים מתאימים לעיניים רגישות.", pens],
      ["הטוש אינו מתאים לעיניים רגישות.", "הטוש מתאים לעיניים רגישות.", pens],
      ["הטוש אינה מתאימה לעיניים רגישות.", "הטוש מתאימה לעיניים רגישות.", pens],
      ["הטושים אינם מתאימים לעיניים רגישות.", "הטושים מתאימים לעיניים רגישות.", pens],
      ["הטוש אינו מיועד לעיניים רגישות.", "הטוש מיועד לעיניים רגישות.", pens],
      ["הטושים אינן מתאימות לעיניים רגישות.", "הטושים מתאימות לעיניים רגישות.", pens],
      ["הטוש לא ממש מתאים לעיניים רגישות.", "הטוש ממש מתאים לעיניים רגישות.", pens],
      ["וחשוב לדעת שלא מתאים לעיניים רגישות.", "וחשוב לדעת, מתאים לעיניים רגישות.", pens],
      ["The pens are not made for sensitive eyes.", "The pens are made for sensitive eyes.", penEn],
      ["The pen isn't compatible with sensitive eyes.", "The pen is compatible with sensitive eyes.", penEn],
      ["The pen is not really made for sensitive eyes.", "The pen is really made for sensitive eyes.", penEn],
      ["The pen never fits sensitive eyes.", "The pen fits sensitive eyes.", penEn],
    ]) expect([no, deviceMismatch(no, incoming).length, deviceMismatch(plain, incoming).length]).toEqual([no, 0, 1]);
    // Forms the fit pattern never took as a fit.
    for (const t of ["The pens do not fit sensitive eyes.", "The pens are not for sensitive eyes."]) expect([t, deviceMismatch(t, penEn)]).toEqual([t, []]);
    // The original case stands: said not to fit hers and to fit another, in one sentence, in either order.
    const crispi = "יש משטח לנינג'ה קריספי?", crispiEn = "a mat for my Ninja Crispi?";
    for (const t of [
      "סמובי גפן לא מתאימה לנינג'ה קריספי, אבל מתאימה לנינג'ה סלושי.",
      "סמובי גפן מתאימה לנינג'ה סלושי, אבל לא מתאימה לנינג'ה מקס.",
      // "Not only" negates nothing, and neither does a "not" that ended before a comma or belongs to another word.
      "סמובי גפן לא רק מתאימה לנינג'ה סלושי, היא גם נשטפת במדיח.",
      "אם לא, מתאימה לנינג'ה סלושי סמובי גפן.",
      "הסט המלא מתאים לנינג'ה סלושי.",
      "סמובי גפן לא יקרה בכלל ומחזיקה שנים, מתאימה לנינג'ה סלושי.",
    ]) expect([t, deviceMismatch(t, crispi).length]).toEqual([t, 1]);
    for (const t of [
      "The Gefen mat is not made for the Ninja Crispi, but it fits the Ninja Slushi.",
      "The Gefen mat is not only made for the Ninja Slushi.",
      "The Gefen mat is not just made for the Ninja Slushi.",
      "It is not new, but it fits the Ninja Slushi.",
    ]) expect([t, deviceMismatch(t, crispiEn).length]).toEqual([t, 1]);
    // Said not to fit another device: no fit claimed.
    expect(deviceMismatch("סמובי גפן לא מתאימה לנינג'ה סלושי.", crispi)).toEqual([]);
    expect(deviceMismatch("The Gefen mat is not made for the Ninja Slushi.", crispiEn)).toEqual([]);
    // In the whole check.
    expect(kinds(await g3("הטושים לא מתאימים לעיניים רגישות.", { incomingMessage: pens }))).not.toContain("device_mismatch");
    expect(kinds(await g3("סמובי גפן לא מתאימה לנינג'ה קריספי, אבל מתאימה לנינג'ה סלושי.", { incomingMessage: crispi }))).toContain("device_mismatch");
  });
});

/** Rating on 2c57725b (2026-11-17): worse than live; the seven fixes. */
describe("2c57725b rating fixes", () => {
  it("★ the card protocol never reaches the customer", async () => {
    const { sanitizeReply, assembleOnce } = await import("../services/reply-engine/engine");
    expect(sanitizeReply("יש לנו שני בובונים מתאימים.\nSHOW: בובון שטוח, בובון חצי שטוח")).toBe("יש לנו שני בובונים מתאימים.");
    expect(sanitizeReply("הנה.\nCARDS: PRODUCT_1\nPRODUCT_2")).toBe("הנה.");
    expect(assembleOnce("יש.\nSHOW: PRODUCT_1", null, [])).toBe("יש.");
  });

  it("★ orders are read only on a turn about them", async () => {
    const { orderTurn } = await import("../services/reply-engine/gates");
    expect(orderTurn("תודה רבה!")).toBe(false);
    expect(orderTurn("תודה, יום טוב")).toBe(false);
    expect(orderTurn("איפה ההזמנה שלי?")).toBe(true);
    expect(orderTurn("חויבתי פעמיים")).toBe(true);
    expect(orderTurn("רוצה להחזיר את הצעיף")).toBe(true);
    expect(orderTurn("9664")).toBe(true);
    expect(orderTurn("זה", "מה מספר ההזמנה?")).toBe(true);
    expect(orderTurn("thanks!")).toBe(false);
  });

  it("★ the order read is refused on a thanks turn, allowed after our ask for the number", async () => {
    const { refuseOrderRead } = await import("../services/reply-engine/engine");
    expect(refuseOrderRead("woocommerce.list_customer_orders", "תודה רבה!", [])).toMatch(/^not_asked/);
    expect(refuseOrderRead("shopify.find_latest_order", "thanks", [])).toMatch(/^not_asked/);
    expect(refuseOrderRead("woocommerce.list_customer_orders", "זה", [{ direction: "OUTBOUND", body: "מה מספר ההזמנה?" }])).toBeNull();
    expect(refuseOrderRead("woocommerce.list_products", "תודה", [])).toBeNull();
  });

  it("★ a different order number than the one typed is not asserted as theirs", async () => {
    const { orderNumberDiffers } = await import("../services/reply-engine/gates");
    expect(orderNumberDiffers("ההזמנה הקודמת שלך היא 96664, הושלמה ושולמה.", "ההזמנה 9664")).toHaveLength(1);
    expect(orderNumberDiffers("מצאתי הזמנה 96664, זו ההזמנה שהתכוונת אליה?", "ההזמנה 9664")).toEqual([]);
    expect(orderNumberDiffers("הזמנה 9664 נשלחה אתמול.", "ההזמנה 9664")).toEqual([]);
    const { gate3 } = await import("../services/reply-engine/gates");
    const g = gate3({ reply: "ההזמנה הקודמת שלך היא 96664, הושלמה ושולמה.", claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "מה עם ההזמנה 9664?", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false } as any);
    expect(g.problems.some((p: any) => p.kind === "style" && p.codes.includes("order_number_differs"))).toBe(true);
  });

  it("★ should/shouldn't payment speculation is cut", async () => {
    const { ungroundedPayment } = await import("../services/reply-engine/gates");
    expect(ungroundedPayment("לא אמורה להיות כפילות בהזמנה החדשה.", [])).toHaveLength(1);
    expect(ungroundedPayment("לא אמור להיות חיוב כפול.", [])).toHaveLength(1);
    expect(ungroundedPayment("There shouldn't be a double charge.", [])).toHaveLength(1);
  });

  it("★ a product named in prose with its price is not listed again", async () => {
    const { assembleOnce } = await import("../services/reply-engine/engine");
    const out = assembleOnce("קיט פודרה מתאים לך, הוא עולה ₪165.06.", "קיט פודרה מינרלית 30 גרם\n₪165.06\nבמלאי\nhttps://x/k", ["קיט פודרה מינרלית 30 גרם"]);
    expect(out).not.toMatch(/https:\/\/x\/k/);
    // A different price is a different fact: the block stays.
    expect(assembleOnce("קיט פודרה מתאים לך.", "קיט פודרה מינרלית 30 גרם\n₪165.06\nhttps://x/k", ["קיט פודרה מינרלית 30 גרם"])).toMatch(/https:\/\/x\/k/);
  });

  it("★ a price sentence left without its product is dropped", async () => {
    const { dropDanglingPrice } = await import("../services/reply-engine/gates");
    expect(dropDanglingPrice("הוא במבצע ב-₪165.06. רוצה שאשלח קישור?", ["קיט פודרה מינרלית"])).toBe("רוצה שאשלח קישור?");
    expect(dropDanglingPrice("קיט פודרה מינרלית מעולה לעור יבש. הוא במבצע ב-₪165.06.", ["קיט פודרה מינרלית"])).toMatch(/165\.06/);
  });

  it("★ a bent word inside a known title is restored", async () => {
    const { fixNearTitles } = await import("../services/reply-engine/gates");
    expect(fixNearTitles("הקיטור פודרה מינרלית מתאים לך.", ["קיט פודרה מינרלית"])).toBe("הקיט פודרה מינרלית מתאים לך.");
    expect(fixNearTitles("קיט פודרה מינרלית מתאים לך.", ["קיט פודרה מינרלית"])).toBe("קיט פודרה מינרלית מתאים לך.");
    expect(fixNearTitles("יש לנו קיטים ופודרות.", ["קיט פודרה מינרלית"])).toBe("יש לנו קיטים ופודרות.");
    // Every word bent is another phrase, not the title.
    expect(fixNearTitles("We sell Canvases Totes.", ["Canvas Tote"])).toBe("We sell Canvases Totes.");
    expect(fixNearTitles("We sell Canvass Tote.", ["Canvas Tote"])).toBe("We sell Canvas Tote.");
  });
});

/** Rating on 0bf4e95e (2026-11-17): the payment thread needs a mode, not patterns. */
describe("0bf4e95e rating fixes", () => {
  it("★ holding mode: a sensitive item puts the conversation on hold; ordinary items do not", async () => {
    const { holdingItem } = await import("../services/reply-engine/gates");
    expect(holdingItem(["חויבתי פעמיים ואין הזמנה"])).toMatch(/חויבתי/);
    expect(holdingItem(["the customer was charged twice"])).toBeTruthy();
    expect(holdingItem(["המוצר הגיע שבור"])).toBeTruthy();
    expect(holdingItem(["האם יש משלוח לאילת"])).toBeNull();
  });

  it("★ holding mode: nothing about the state, cause or outcome; the ack and the holding line instead", async () => {
    const { holdReply, HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    const line = "החיוב עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.";
    const a = holdReply("ייתכן שאישור הויזה זמני ואינו חיוב סופי. הבדיקה מול ספק התשלום בתהליך.", line, { details: false, locale: "he" });
    expect(a).toBe(line);
    const b = holdReply("הבדיקה של החיוב וההזמנה הכפולה עדיין אצל הצוות.", line, { details: true, locale: "he" });
    expect(b).toBe(`${HOLD_ACK_HE} ${line}`);
    // A sentence on anything else stays.
    expect(holdReply("שעות הפעילות שלנו הן א-ה 9-17.", line, { details: false, locale: "he" })).toMatch(/שעות הפעילות/);
  });

  it("★ the team-pass shapes the runs repeated", async () => {
    const { teamPassIn } = await import("../services/reply-engine/gates");
    expect(teamPassIn("נעדכן כאן בצ'אט כשיתקבל מענה.")).toBe(true);
    expect(teamPassIn("אבדוק מול הצוות ואחזור אלייך.")).toBe(true);
    expect(teamPassIn("המשטח מתאים לנינג'ה קריספי.")).toBe(false);
  });

  it("★ a first name only from the profile or the customer's signature (never its second word)", async () => {
    const { dropUnaskedName, signedNames } = await import("../services/reply-engine/gates");
    expect(dropUnaskedName("היי אלה, איך אפשר לעזור?", [null])).toBe("היי, איך אפשר לעזור?");
    expect(dropUnaskedName("בשמחה, רחל! הנה הקישור.", [])).toBe("בשמחה! הנה הקישור.");
    expect(dropUnaskedName("היי דנה, איך אפשר לעזור?", ["דנה"])).toBe("היי דנה, איך אפשר לעזור?");
    expect(dropUnaskedName("תודה רבה, נשמח לעזור.", [])).toBe("תודה רבה, נשמח לעזור.");
    expect(signedNames(["שלום, יש לכם משטח?\nמיכל לוי"])).toEqual(["מיכל"]);
    expect(signedNames(["יש לכם משטח?"])).toEqual([]);
    expect(dropUnaskedName("היי לוי, הנה.", signedNames(["שאלה\nמיכל לוי"]))).toBe("היי, הנה.");
  });

  it("★ a search timeout sent to the team while the knowledge speaks of it: answered from the knowledge", async () => {
    const { gaveUpSearch, autoLookups } = await import("../services/reply-engine/gates");
    const timeout = [{ callId: "1", tool: "woocommerce.list_products", args: { query: "משטח" }, decision: "timeout", content: "", ms: 8000, outcome: "timeout" }] as any;
    expect(gaveUpSearch("אבדוק מול הצוות איזה מתאים.", timeout, "איזה משטח מתאים לנינג'ה קריספי?", false, "טבלת מכשירים: נינג'ה קריספי - משטח 30x40")).toBe(true);
    // Without the knowledge it is still a give-up (a product want sent to the team), but not the knowledge path.
    const { knowledgeAnswersIt } = await import("../services/reply-engine/gates");
    expect(knowledgeAnswersIt("אבדוק מול הצוות איזה מתאים.", "איזה משטח מתאים לנינג'ה קריספי?", false, "")).toBe(false);
    const auto = autoLookups([{ kind: "gave_up_search", fromKnowledge: true }] as any, "איזה משטח מתאים לנינג'ה קריספי?", ["woocommerce.list_products", "search_knowledge"], timeout);
    expect(auto.map((x) => x.function.name)).toEqual(["woocommerce.list_products", "search_knowledge"]);
    // A plain give-up keeps the store retry alone.
    expect(autoLookups([{ kind: "gave_up_search" }] as any, "תיקים", ["woocommerce.list_products", "search_knowledge"], timeout).map((x) => x.function.name)).toEqual(["woocommerce.list_products"]);
  });
});

/** Rating on b8ec6dcf (2026-11-18): holding held; the fallbacks and the repeats did not. */
describe("b8ec6dcf rating fixes", () => {
  it("★ 'the photo came through' with no photo is cut", async () => {
    const { claimsAttachment } = await import("../services/reply-engine/gates");
    expect(claimsAttachment("התמונה התקבלה, תודה.", ["שלחתי"])).toHaveLength(1);
    expect(claimsAttachment("הצילום התקבל אצלנו.", ["שלחתי"])).toHaveLength(1);
    expect(claimsAttachment("קיבלנו תמונה.", ["שלחתי"])).toHaveLength(1);
    expect(claimsAttachment("Your photo came through.", ["sent"])).toHaveLength(1);
    expect(claimsAttachment("התמונה התקבלה, תודה.", ["[image]"])).toEqual([]);
  });

  it("★ holding mode: a what-should-I-do ask gets fixed advice, never the state", async () => {
    const { holdReply, proceduralAsk, HOLD_ADVICE_HE } = await import("../services/reply-engine/gates");
    expect(proceduralAsk("אם אזמין שוב תהיה כפילות?")).toBe(true);
    expect(proceduralAsk("מה אני צריכה לעשות עכשיו?")).toBe(true);
    expect(proceduralAsk("מה שעות הפעילות?")).toBe(false);
    const out = holdReply("לא אמורה להיות כפילות בהזמנה החדשה.", "החיוב עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.", { details: false, locale: "he", procedural: true });
    expect(out).toMatch(new RegExp(HOLD_ADVICE_HE.slice(0, 20)));
    expect(out).not.toMatch(/לא אמורה להיות כפילות/);
  });

  it("★ a customer's thanks or okay", async () => {
    const { customerAck } = await import("../services/reply-engine/gates");
    for (const t of ["תודה", "תודה רבה!", "אוקיי", "סבבה 👍", "thanks", "ok"]) expect(customerAck(t), t).toBe(true);
    for (const t of ["תודה, ומה עם המשלוח?", "אוקיי אז מתי?"]) expect(customerAck(t), t).toBe(false);
  });

  it("★ a write runs only on an explicit ask; cards, booking and handoff keep their own flows", async () => {
    const { refuseWrite } = await import("../services/reply-engine/gates");
    expect(refuseWrite("woocommerce.add_order_note", "תודה רבה!")).toMatch(/^not_asked/);
    expect(refuseWrite("woocommerce.add_order_note", "ההזמנה הגיעה")).toMatch(/^not_asked/);
    expect(refuseWrite("woocommerce.add_order_note", "תוסיפו בבקשה הערה שזה מתנה")).toBeNull();
    expect(refuseWrite("shopify.cancel_order", "אפשר לבטל את ההזמנה?")).toBeNull();
    expect(refuseWrite("woocommerce.list_products", "תודה")).toBeNull();
    expect(refuseWrite("send_product_card", "תודה")).toBeNull();
    expect(refuseWrite("schedule_meeting", "ביום שלישי")).toBeNull();
    expect(refuseWrite("close_conversation", "תודה")).toBeNull();
    expect(refuseWrite("integration_create_lead", "שמי דנה")).toBeNull();
    expect(refuseWrite("woocommerce.update_order", "תודה, הכל טוב")).toMatch(/^not_asked/);
  });

  it("★ a failed payment method is a support case", async () => {
    const { paymentMethodFailure } = await import("../services/reply-engine/gates");
    expect(paymentMethodFailure("ניסיתי לשלם בביימי וזה נכשל")).toBe(true);
    expect(paymentMethodFailure("הכרטיס לא עובר")).toBe(true);
    expect(paymentMethodFailure("my card was declined")).toBe(true);
    expect(paymentMethodFailure("אפשר לשלם בביימי?")).toBe(false);
  });

  it("★ the name question and the hollow header", async () => {
    const { nameAsk } = await import("../services/reply-engine/engine");
    expect(nameAsk("איך קוראים לו?")).toBe(true);
    expect(nameAsk("מה השם של הגוון?")).toBe(true);
    expect(nameAsk("what's it called?")).toBe(true);
    expect(nameAsk("איזה גוון מתאים לי?")).toBe(false);
  });
});

/** Rating on 7af7c6d7 (2026-11-18): the holding behaviours did not fire in the real thread. */
describe("7af7c6d7 rating fixes", () => {
  it("★ the real procedural ask (3rd person, a typo, 'שלא יהיה כפילות')", async () => {
    const { proceduralAsk } = await import("../services/reply-engine/gates");
    expect(proceduralAsk("אם הזמין שנית שלא יהיה כפילות")).toBe(true);
    expect(proceduralAsk("אני יכולה לשלם שוב?")).toBe(true);
    expect(proceduralAsk("will it double if I order again?")).toBe(true);
    expect(proceduralAsk("שוב תודה")).toBe(false);
    expect(proceduralAsk("מה עם ההזמנה?")).toBe(false);
  });
  it("★ a thanks with filler is a thanks", async () => {
    const { customerAck } = await import("../services/reply-engine/gates");
    for (const t of ["שיהיה תודה", "יאללה תודה", "אז אוקיי", "ותודה רבה", "שתודה"]) expect(customerAck(t), t).toBe(true);
    for (const t of ["שיהיה מהר בבקשה", "תודה אבל מתי זה יגיע?"]) expect(customerAck(t), t).toBe(false);
  });
  it("★ 'לכאורה' on a payment is cut, and never in holding mode", async () => {
    const { ungroundedPayment, holdReply } = await import("../services/reply-engine/gates");
    expect(ungroundedPayment("החיוב שאושר לכאורה יבוטל.", [])).toHaveLength(1);
    expect(holdReply("לכאורה זה בסדר.", "", { details: false, locale: "he" })).toBe("");
  });
  it("★ a pick by its kind with no name is unnamed", async () => {
    const { unnamedRecommendation } = await import("../services/reply-engine/gates");
    expect(unnamedRecommendation("משטח הזזה עם גלגלים הכי מתאים לך.", ["סמובי גפן 40*50", "סמובי אלכסה"])).toBe(true);
    expect(unnamedRecommendation("סמובי גפן הכי מתאים לך.", ["סמובי גפן 40*50", "סמובי אלכסה"])).toBe(false);
    expect(unnamedRecommendation("משטח הזזה מתאים לך.", [])).toBe(false);
    // Asking whether it fits is not a pick.
    expect(unnamedRecommendation("יש תיק בד קנבס ב-₪79, מתאים לך?", ["Canvas Tote"])).toBe(false);
  });
  it("★ a link in an earlier card or button counts as said", async () => {
    const { contradictsEarlier } = await import("../services/reply-engine/gates");
    expect(contradictsEarlier("אין לי כרגע קישור לסרטון.", ["הנה", ' {"buttons":[{"url":"https://youtu.be/x"}]}'])).toHaveLength(1);
  });
});

/** Rating on d7782dd2 (2026-11-18, LIVE). */
describe("d7782dd2 rating fixes", () => {
  it("★ a count that disagrees with its list takes the list's count", async () => {
    const { fixListCount } = await import("../services/reply-engine/gates");
    expect(fixListCount("יש 3 גוונים: Sand, Medium ו-Hony, Medium Dark.")).toBe("יש 4 גוונים: Sand, Medium ו-Hony, Medium Dark.");
    expect(fixListCount("יש שלושה צבעים: שחור, לבן ואפור.")).toBe("יש שלושה צבעים: שחור, לבן ואפור.");
    expect(fixListCount("יש שני צבעים: שחור, לבן ואפור.")).toBe("יש 3 צבעים: שחור, לבן ואפור.");
    expect(fixListCount("המחיר 3 ש\"ח.")).toBe("המחיר 3 ש\"ח.");
  });
  it("★ a timeout on a product want, sent to the team by the reply's words, is a give-up", async () => {
    const { gaveUpSearch } = await import("../services/reply-engine/gates");
    const timeout = [{ callId: "1", tool: "woocommerce.list_products", args: {}, decision: "timeout", content: "", ms: 8000, outcome: "timeout" }] as any;
    expect(gaveUpSearch("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", timeout, "יש לכם בובון לקשירה נמוכה?", false, "")).toBe(true);
  });
  it("★ a how-to ask brings the guide's link chunk", async () => {
    const { defaultKnowledge } = await import("../services/reply-engine/tools");
    const chunk = (content: string, i: number) => ({ content, score: 0.9, documentTitle: "guide", chunkIndex: i, documentId: "d1" });
    const out = await defaultKnowledge("t1", "איך מורחים את המייקאפ? יש סרטון?", "a1", {
      vector: (async () => [chunk("המייקאפ נמרח בתנועות עדינות.", 1)]) as any,
      lexical: (async (_t: string, q: string) => q.includes("youtu") ? [chunk("סרטון הדרכה: https://youtu.be/abc", 7)] : []) as any,
    });
    expect(out).toMatch(/youtu\.be\/abc/);
    const plain = await defaultKnowledge("t1", "מה המחיר?", "a1", {
      vector: (async () => [chunk("המחיר באתר.", 1)]) as any,
      lexical: (async (_t: string, q: string) => q.includes("youtu") ? [chunk("סרטון הדרכה: https://youtu.be/abc", 7)] : []) as any,
    });
    expect(plain).not.toMatch(/youtu/);
  });
});

/** Prod 2026-11-18 (Smoovee, cmwlusggx): "https://smoovee-ltd.העברתי את השאלה לצוות". */
describe("urlfix units", () => {
  const URL = "https://smoovee-ltd.com/product/%d7%a1%d7%9e%d7%95%d7%91%d7%99-%d7%90%d7%9c%d7%9b%d7%a1%d7%94/";
  const LIVE = "הקישור לסמובי אלכסה: https://smoovee-ltd.העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.";
  it("★ the sentence cuts keep a URL whole", async () => {
    const g: any = await import("../services/reply-engine/gates");
    const s = `הקישור לסמובי אלכסה: ${URL}\nהעברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.`;
    expect(g.removeTeamLines(s)).toContain(URL);
    expect(g.dropPersonPromises(`הנה: ${URL}\nנציג יחזור אלייך.`)).toContain(URL);
    // The digits of a percent-encoded path are no numbers to ground.
    expect(g.ungroundedNumbers(`הקישור: ${URL}`, "")).toEqual([]);
    expect(g.ungroundedNumbers("זה 95% כותנה", "")).toHaveLength(1);
  });
  it("★ the exact live text: the cut link becomes the product's URL, the team line keeps its own sentence", async () => {
    const { repairUrls, spaceSentences } = await import("../services/reply-engine/gates");
    const r = repairUrls(LIVE, `product: ${URL}`);
    expect(r.text).toContain(URL);
    expect(spaceSentences(r.text)).toMatch(/העברתי את השאלה לצוות/);
    expect(spaceSentences(r.text)).not.toMatch(/[.!?][\u05D0-\u05EA]/);
    // Two product URLs: no way to tell which, so the cut link's sentence goes and the team line stays.
    const two = repairUrls(LIVE, `${URL} https://smoovee-ltd.com/product/other/`);
    expect(two.text).not.toMatch(/smoovee-ltd(?!\.com)/);
    expect(two.text).toMatch(/^העברתי את השאלה לצוות/);
    expect(two.dropped).toBe(1);
  });
  it("★ kept sentences never touch; a sentence end gets a space before a Hebrew letter, never inside a URL", async () => {
    const { joinKept, spaceSentences } = await import("../services/reply-engine/gates");
    expect(["הקישור: x.", "העברתי."].reduce(joinKept, "")).toBe("הקישור: x. העברתי.");
    expect(["a. ", "b."].reduce(joinKept, "")).toBe("a. b.");
    expect(spaceSentences("תודה.העברתי")).toBe("תודה. העברתי");
    expect(spaceSentences(`ראי ${URL}`)).toBe(`ראי ${URL}`);
  });
});

/** Narrow prod hotfix on 7c476131 (Smoovee live, 2026-11-18). */
describe("smoovee live hotfix units", () => {
  it("★ a decimal price cut by the splitters is one number again", async () => {
    const { joinKept } = await import("../services/reply-engine/gates");
    expect(["סמובי אלכסה במחיר 227.", "50 ₪."].reduce(joinKept, "")).toBe("סמובי אלכסה במחיר 227.50 ₪.");
    expect(["תודה.", "העברתי."].reduce(joinKept, "")).toBe("תודה. העברתי.");
  });
  it("★ an attribute nothing states: 'בסיס: פרספקס' never makes it transparent", async () => {
    const { ungroundedAttribute } = await import("../services/reply-engine/gates");
    expect(ungroundedAttribute("המשטחים מפרספקס שקוף.", "בסיס: פרספקס")).toHaveLength(1);
    expect(ungroundedAttribute("המשטח שקוף לגמרי.", "חומר: פרספקס שקוף")).toEqual([]);
    expect(ungroundedAttribute("אין לי מידע שמאשר אם הם שקופים.", "בסיס: פרספקס")).toEqual([]);
    expect(ungroundedAttribute("יש אותו בצבע ורוד.", "צבעים: שחור, לבן")).toHaveLength(1);
    expect(ungroundedAttribute("יש אותו בשחור.", "צבעים: שחור, לבן")).toEqual([]);
    expect(ungroundedAttribute("הוא עמיד במים.", "פרספקס")).toHaveLength(1);
  });
  it("★ a price next to a named product is its own; the sale's prices count", async () => {
    const { priceOfOtherProduct, namedOnce } = await import("../services/reply-engine/gates");
    const c = [{ title: "סמובי אלכסה", price: "227" }, { title: "סמובי אריאל", price: "158.76" }, { title: "סמובי גפן", price: "99", discount: { was: "129", now: "99" } }];
    expect(priceOfOtherProduct("סמובי אלכסה במחיר 158.76 ₪.", c)).toHaveLength(1);
    expect(priceOfOtherProduct("סמובי אלכסה במחיר 227 ₪.", c)).toEqual([]);
    expect(priceOfOtherProduct("סמובי גפן ב-₪99 במקום ₪129.", c)).toEqual([]);
    expect(priceOfOtherProduct("סמובי אלכסה ב-227 ₪ וסמובי אריאל ב-158.76 ₪.", c)).toEqual([]);
    expect(namedOnce("הנה סמובי אלכסה", c)).toBe(0);
    expect(namedOnce("אלכסה ואריאל", c)).toBe(-1);
  });
  it("★ a return REQUEST, not a policy question; a failure told; a reason given", async () => {
    const g: any = await import("../services/reply-engine/gates");
    expect(g.returnRequest("אני רוצה להחזיר את המשטח")).toBe(true);
    expect(g.returnRequest("החזרה של הזמנה 97837")).toBe(true);
    expect(g.returnRequest("אפשר להחזיר מוצר אחרי שבוע?")).toBe(false);
    expect(g.FAILURE_TOLD.test("כרגע לא הצלחתי לבדוק את פרטי העסקה.")).toBe(true);
    expect(g.gaveReason(["רוצה להחזיר כי זה לא מתאים למיקסר"])).toBe(true);
    expect(g.gaveReason(["רוצה להחזיר"])).toBe(false);
  });
});

describe("smoovee live hotfix: gate3 and the hold noun", () => {
  it("★ gate3 cuts a transparency nothing states, and another product's price next to a named one", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    const v = gate3({ ...baseG3, reply: "המשטחים מפרספקס שקוף.", grounding: "סמובי אלכסה בסיס: פרספקס 227" } as any);
    expect(JSON.stringify(v)).toMatch(/ungrounded_attribute/);
    const w = gate3({ ...baseG3, reply: "סמובי אלכסה במחיר 158.76 ₪.", grounding: "סמובי אלכסה 227 ₪; סמובי אריאל 158.76 ₪", candidateTitles: ["סמובי אלכסה", "סמובי אריאל"], candidates: [{ title: "סמובי אלכסה", price: "227" }, { title: "סמובי אריאל", price: "158.76" }] } as any);
    expect(JSON.stringify(w)).toMatch(/price_of_other_product/);
  });
  it("★ a held return is 'the request', never 'the charge'", async () => {
    const { stillCheckingLine } = await import("../services/reply-engine/engine");
    expect(stillCheckingLine("return request: רוצה להחזיר, יש זיכוי?", "he")).toMatch(/^הבקשה עדיין בבדיקה/);
    expect(stillCheckingLine("חויבתי פעמיים", "he")).toMatch(/^החיוב עדיין בבדיקה/);
  });
});

describe("the action trace and the money floor (2026-11-18)", () => {
  it("★ error codes and an argument summary for the platform's feed", async () => {
    const { errorCodeOf, argsSummary, orderReadTimeoutMs } = await import("../services/reply-engine/tools");
    expect(errorCodeOf({ outcome: "timeout" })).toBe("timeout");
    expect(errorCodeOf({ outcome: "error", errorKind: "tool_error", content: JSON.stringify({ status: 403 }) })).toBe("http_403");
    expect(errorCodeOf({ decision: "deny", content: JSON.stringify({ ok: false, failure: "refused", reason: "not_asked: x" }) })).toBe("refused:not_asked");
    expect(errorCodeOf({ outcome: "ok", content: JSON.stringify({ ok: true }) })).toBeNull();
    expect(errorCodeOf({ outcome: "ok", content: JSON.stringify({ ok: false, failure: "order_not_found" }) })).toBe("order_not_found");
    expect(argsSummary({ order_id: "97837", items: [1, 2] })).toBe("order_id=97837 items=[…]");
    expect(orderReadTimeoutMs({} as any)).toBe(10000);
  });
  it("the money tools are named (the floor waits for Omer's decision)", async () => {
    // By path: this worktree's node_modules may link another line's shared package.
    const { readFileSync: rf } = await import("fs");
    const gateSrc = rf("../../packages/shared/src/lib/tool-gate.ts", "utf8");
    const ALWAYS_APPROVAL = new RegExp(eval(gateSrc.match(/export const ALWAYS_APPROVAL = (\/.*\/);/)![1]).source);
    for (const t of ["woocommerce.create_refund", "woocommerce.create_coupon", "shopify.create_discount_code", "refund", "apply_discount"]) expect(ALWAYS_APPROVAL.test(t)).toBe(true);
    for (const t of ["woocommerce.get_order", "woocommerce.add_order_note", "woocommerce.disable_coupon"]) expect(ALWAYS_APPROVAL.test(t)).toBe(false);
    const src = (await import("fs")).readFileSync("../../packages/shared/src/lib/tool-gate.ts", "utf8");
    // Not applied until Omer decides (the workspace's Execute still holds).
    expect(src).not.toMatch(/if \(ALWAYS_APPROVAL\.test\(opts\.toolName\)/);
  });
});

/** Rating on 93f9fdff (2026-11-18, LIVE). */
describe("93f9fdff rating fixes", () => {
  const URL = "https://chanivainberger.co.il/product/makeup-base.v2/?ref=a.b";
  it("★ a URL is one unit in every sentence cut", async () => {
    const g = await import("../services/reply-engine/gates");
    const reply = `אפשר לראות בעמוד המוצר: ${URL}. נשמח לעזור.`;
    expect(g.foreignLanguageSentences(reply)).toEqual([]);
    expect(g.cleanStyle(reply, ["mixed_language"], [], "", "", [], null)).toContain(URL);
    expect(g.dropDanglingPrice(reply, [])).toContain(URL);
    expect(g.stripFactProblems(reply, [{ kind: "card_reference", claims: ["משהו אחר לגמרי"] }] as any)).toContain(URL);
    expect(g.holdReply(`${reply}`, "", { details: false, locale: "he" })).toContain(URL);
    // The sentence after the URL is still its own sentence.
    expect(g.stripFactProblems(reply, [{ kind: "card_reference", claims: ["נשמח לעזור"] }] as any)).not.toMatch(/נשמח/);
  });
  it("★ narrated reasoning about the results is internal", async () => {
    const { gate3, cleanStyle } = await import("../services/reply-engine/gates");
    const reply = "הקשתות שמופיעות באתר לא תואמות למה שתיארת, אז לא אציע אותן. איזה צבע את מחפשת?";
    const g = gate3({ reply, claims: [], cards: [], candidateCount: 2, tools: [], grounding: "", locale: "he", incomingMessage: "קשת רחבה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false } as any);
    expect(g.problems.some((p: any) => p.kind === "style" && p.codes.includes("internal_reasoning"))).toBe(true);
    expect(cleanStyle(reply, ["internal_reasoning"], [], "", "", [], null)).toBe("איזה צבע את מחפשת?");
  });
  it("★ a fit the product's own text states is not a mismatch", async () => {
    const { deviceMismatch } = await import("../services/reply-engine/gates");
    // It names their model (and another): it fits.
    expect(deviceMismatch("אליס מתאים לנינג'ה קריספי ולנינג'ה מקס.", "יש לכם משטח שמתאים לנינג'ה קריספי שלי?")).toEqual([]);
    // It names another model only: a mismatch, as before.
    expect(deviceMismatch("סמובי גפן מתאימה לנינג'ה סלושי.", "יש לכם משטח שמתאים לנינג'ה קריספי שלי?")).toHaveLength(1);
  });
  it("★ a product named by its own word, said to fit, is a named pick (the Crispy reply)", async () => {
    const { gate3, namesCandidate } = await import("../services/reply-engine/gates");
    expect(namesCandidate("אליס מתאים לנינג'ה קריספי.", ["סמובי אליס 35*28", "סמובי אלכסה 30*40"])).toBe(true);
    expect(namesCandidate("סמובי מתאים לך.", ["סמובי אליס 35*28", "סמובי אלכסה 30*40"])).toBe(false);
    const g = gate3({ reply: "אליס מתאים לנינג'ה קריספי.", claims: [], cards: ["PRODUCT_1"], candidateCount: 2, candidateTitles: ["סמובי אליס 35*28", "סמובי אלכסה 30*40"], tools: [], grounding: "סמובי אליס 35*28 מתאים ל: נינג'ה קריספי", locale: "he", incomingMessage: "איזה משטח מתאים לנינג'ה קריספי 4 ב-1?", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: true, handedOff: false, approvalPending: false } as any);
    expect(g.problems.map((p: any) => p.kind)).not.toContain("unnamed_recommendation");
    expect(g.problems.map((p: any) => p.kind)).not.toContain("no_recommendation");
  });
  it("★ narrated reasoning searches again with the customer's own words", async () => {
    const { autoLookups } = await import("../services/reply-engine/gates");
    const auto = autoLookups([{ kind: "style", codes: ["internal_reasoning"] }] as any, "קשת רחבה לשיער", ["woocommerce.list_products"], []);
    expect(auto[0]?.function.name).toBe("woocommerce.list_products");
    expect(JSON.parse(auto[0].function.arguments).query).toMatch(/קשת/);
  });
  it("★ 'the search returned no match' after a timeout is narration, and a fit ask goes to the knowledge", async () => {
    const { failureNarration, gate3 } = await import("../services/reply-engine/gates");
    expect(failureNarration("החיפוש לא החזיר התאמה למכשיר שלך.")).toBe(true);
    const timeout = [{ callId: "1", tool: "woocommerce.list_products", args: { query: "משטח" }, decision: "timeout", content: "", ms: 8000, outcome: "timeout" }] as any;
    const g = gate3({ reply: "החיפוש לא החזיר התאמה.", claims: [], cards: [], candidateCount: 0, tools: timeout, grounding: "", locale: "he", incomingMessage: "איזה משטח מתאים לנינג'ה קריספי?", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: ["woocommerce.list_products", "search_knowledge"], shopFloor: false, handedOff: false, approvalPending: false } as any);
    expect(g.problems.find((p: any) => p.kind === "gave_up_search")).toMatchObject({ fromKnowledge: true });
  });
  it("★ holding mode: another topic's sentence only when the customer asked about one", async () => {
    const { holdReply, asksOtherTopic } = await import("../services/reply-engine/gates");
    expect(asksOtherTopic("יש חדש?")).toBe(false);
    expect(asksOtherTopic("החיוב עדיין לא חזר")).toBe(false);
    expect(asksOtherTopic("ומה המידה של אלכסה?")).toBe(true);
    const out = holdReply("סמובי אלכסה היא במידה 35×28 ס\"מ.", "החיוב עדיין בבדיקה אצל הצוות.", { details: false, locale: "he", keepOther: false });
    expect(out).toBe("החיוב עדיין בבדיקה אצל הצוות.");
  });
});

/** Rating on 657e5f85 (2026-11-18). */
describe("657e5f85 rating fixes", () => {
  it("★ a charge complaint's handoff or team pass is never needless", async () => {
    const { needlessHandoff } = await import("../services/reply-engine/gates");
    expect(needlessHandoff("payment", ["חויבתי ואין לי הזמנה"], false)).toBe(false);
    expect(needlessHandoff("refund", ["אני רוצה החזר כספי"], false)).toBe(false);
    expect(needlessHandoff("x", ["יש לכם משטח לתמי 4?"], false)).toBe(true);
  });
  it("★ a fit denied with nothing behind it is cut; a size comparison or the product's text keeps it", async () => {
    const { ungroundedNegativeFit, fittingBySize, padFits } = await import("../services/reply-engine/gates");
    expect(padFits([31, 41], [32, 22])).toBe(true);
    expect(padFits([20, 20], [32, 22])).toBe(false);
    expect(ungroundedNegativeFit("סמובי אליס לא מתאים למיקסר.", "מיקסר 32x22", ["סמובי אליס 31*41"], "")).toHaveLength(1);
    expect(ungroundedNegativeFit("למיקסר לא התקבלה התאמה לפי המידות.", "מיקסר 32 על 22", ["סמובי אליס 31*41"], "")).toHaveLength(1);
    expect(ungroundedNegativeFit("סמובי קטן לא מתאים למיקסר.", "מיקסר 32x22", ["סמובי קטן 20*20"], "")).toEqual([]);
    expect(ungroundedNegativeFit("סמובי אליס לא מתאים לקריספי.", "קריספי", ["סמובי אליס 31*41"], "סמובי אליס: לא מתאים לקריספי")).toEqual([]);
    expect(fittingBySize("מיקסר 32x22", ["סמובי אליס 31*41", "סמובי אסף 46*33", "סמובי קטן 20*20"])).toEqual(["סמובי אליס 31*41", "סמובי אסף 46*33"]);
  });
  it("★ several items asked: those the reply never names", async () => {
    const { unansweredItems } = await import("../services/reply-engine/gates");
    expect(unansweredItems("למיקסר מתאים סמובי אליס.", "מיקסר, טוסטר ובלנדר")).toEqual(["טוסטר", "בלנדר"]);
    expect(unansweredItems("למיקסר סמובי אליס, לטוסטר אסף ולבלנדר אלכסה.", "מיקסר, טוסטר ובלנדר")).toEqual([]);
    expect(unansweredItems("הנה.", "יש לכם משטח שמתאים למיקסר שלי בגודל 32 על 22 ס\"מ?")).toEqual([]);
    // A long clause after the comma is a sentence, not a list item.
    expect(unansweredItems("הנה.", "מיקסר, ואני צריכה את זה עד יום שישי")).toEqual([]);
    const { gate3 } = await import("../services/reply-engine/gates");
    const base = { claims: [], cards: [], tools: [], grounding: "", locale: "he", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: true, handedOff: false, approvalPending: false };
    const g = gate3({ ...base, reply: "למיקסר מתאים סמובי אליס.", candidateCount: 2, candidateTitles: ["סמובי אליס 31*41"], incomingMessage: "מיקסר, טוסטר ובלנדר" } as any);
    expect(g.problems.some((p: any) => p.kind === "style" && p.codes.includes("unanswered_items"))).toBe(true);
    // No products this turn (an order complaint joined by a comma): never "unanswered items".
    const o = gate3({ ...base, reply: "העברתי את זה לצוות.", candidateCount: 0, candidateTitles: [], incomingMessage: "ההזמנה עדיין לא הגיעה, כבר שבועיים" } as any);
    expect(o.problems.some((p: any) => p.kind === "style" && p.codes.includes("unanswered_items"))).toBe(false);
    const n = gate3({ ...base, reply: "סמובי אליס לא מתאים למיקסר.", candidateCount: 1, candidateTitles: ["סמובי אליס 31*41"], incomingMessage: "יש משטח למיקסר 32x22?" } as any);
    expect(n.problems.map((p: any) => p.kind)).toContain("ungrounded_negative_fit");
  });
  it("★ the customer's head noun and a product of its kind", async () => {
    const { headNoun, ofNoun } = await import("../services/reply-engine/gates");
    expect(headNoun("מטפחת חגיגית בגווני כחול")).toBe("מטפחת");
    expect(headNoun("יש לכם מטפחות חגיגיות?")).toBe("מטפחות");
    expect(ofNoun({ title: "אנה", attributes: { category: "מטפחות חגיגיות" } }, "מטפחת")).toBe(true);
    expect(ofNoun({ title: "קשת-כחולה", attributes: { category: "קשתות" } }, "מטפחת")).toBe(false);
  });
  it("★ a short follow-up carries the item from two messages back", async () => {
    const { customerSearchQuery } = await import("../services/woo-chat-turn.service");
    const msgs = [{ direction: "INBOUND", body: "יש לכם בובון לקשירה נמוכה?" }, { direction: "OUTBOUND", body: "באיזה צבע?" }, { direction: "INBOUND", body: "כן" }, { direction: "INBOUND", body: "שחור" }];
    expect(customerSearchQuery(msgs, "שחור", "מטפחת שחורה")).toMatch(/בובון/);
  });
});

/** Rating on ed780586 (2026-11-18): product matching. */
describe("ed780586 rating fixes", () => {
  it("★ 'yes' hands over only after a real offer of a person, in the question itself", async () => {
    const { ignoredYes, offeredPerson } = await import("../services/reply-engine/gates");
    expect(offeredPerson("לבדוק את זה עם הצוות?")).toBe(false);
    expect(offeredPerson("תרצי שאעביר את השאלה לצוות?")).toBe(false);
    expect(offeredPerson("תרצי שנציג יחזור אלייך?")).toBe(true);
    expect(offeredPerson("זה דחוף? אם כן אעביר לנציג.")).toBe(true);
    expect(ignoredYes("כן", "לבדוק את זה עם הצוות?", false, false)).toBe(false);
    expect(ignoredYes("כן", "תרצי לדבר עם נציג?", false, false)).toBe(true);
  });
  it("★ a fit with nothing behind it, or from a similar model, is cut; the data or a size keeps it", async () => {
    const { ungroundedPositiveFit } = await import("../services/reply-engine/gates");
    const titles = ["סמובי אסף 46*33", "סמובי אליס 31*41"];
    expect(ungroundedPositiveFit("סמובי אסף מתאים גם לנינג'ה קריספי.", "יש לנינג'ה קריספי?", titles, "סמובי אסף מתאים ל: נינג'ה גריל XL", "")).toHaveLength(1);
    expect(ungroundedPositiveFit("הוא מופיע במפרט כמתאים לדגם דומה.", "", titles, "", "")).toHaveLength(1);
    expect(ungroundedPositiveFit("סמובי אסף מתאים לנינג'ה קריספי.", "יש לנינג'ה קריספי?", titles, "סמובי אסף מתאים ל: נינג'ה קריספי", "")).toEqual([]);
    expect(ungroundedPositiveFit("סמובי אסף מתאים לנינג'ה קריספי שלך.", "", titles, "", "טבלה: אייר פרייר נינג'ה קריספי - סמובי אסף")).toEqual([]);
    expect(ungroundedPositiveFit("סמובי אליס מתאים למיקסר.", "מיקסר 32x22", titles, "", "")).toEqual([]);
    expect(ungroundedPositiveFit("זה מתאים לך מאוד.", "", titles, "", "")).toEqual([]);
    // The device table lists CATEGORIES (prod Smoovee, 2026-11-18): a model mapped to its category, named, stands;
    // products the category does not list are an over-claim.
    const table = "סיר טיגון ללא שמן נינג'ה: סמובי אליס\nנינג'ה גריל XL: סמובי אליס, סמובי אסף\nמיקסר דאבו: סמובי אליס";
    const three = ["סמובי אליס 31*41", "סמובי אסף 46*33", "סמובי כריסטינה 30*40"];
    expect(ungroundedPositiveFit("נינג'ה קריספי הוא סיר טיגון ללא שמן, ולנינג'ה קריספי מתאים סמובי אליס.", "יש לנינג'ה קריספי?", three, "", table)).toEqual([]);
    expect(ungroundedPositiveFit("לנינג'ה קריספי מופיעים כמתאימים סמובי אליס, סמובי אסף וסמובי כריסטינה.", "יש לנינג'ה קריספי?", three, "", table)).toHaveLength(1);
    expect(ungroundedPositiveFit("לנינג'ה גריל XL מתאים סמובי אסף.", "", three, "", table)).toEqual([]);
    // One product backed, one not, in one sentence: cut.
    expect(ungroundedPositiveFit("לנינג'ה גריל XL מתאימים סמובי אליס וסמובי כריסטינה.", "", three, "", table)).toHaveLength(1);
    const { gate3 } = await import("../services/reply-engine/gates");
    const base = { claims: [], cards: [], tools: [], locale: "he", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: true, handedOff: false, approvalPending: false };
    const g = gate3({ ...base, reply: "סמובי אסף מתאים לנינג'ה קריספי.", candidateCount: 2, candidateTitles: titles, grounding: "", knowledge: "", incomingMessage: "יש לנינג'ה קריספי?" } as any);
    expect(g.problems.map((p: any) => p.kind)).toContain("ungrounded_positive_fit");
    const w = gate3({ ...base, reply: "עט נמשים הוא מה שאת מחפשת.", candidateCount: 2, candidateTitles: ["עט נמשים", "טינט שפתיים עם מברשת"], grounding: "", knowledge: "", incomingMessage: "טינט שיש בסוף מברשת" } as any);
    expect(w.problems.some((p: any) => p.kind === "style" && p.codes.includes("wrong_product_type"))).toBe(true);
  });
  it("★ restock asks, a repeated question, an orphan conditional", async () => {
    const { restockAsk, repeatsQuestion, dropOrphanConditional } = await import("../services/reply-engine/gates");
    expect(restockAsk("מתי יתחדש המלאי אליס שחור")).toBe(true);
    expect(restockAsk("מתי יחזור למלאי?")).toBe(true);
    expect(restockAsk("when is it back in stock?")).toBe(true);
    expect(restockAsk("יש במלאי?")).toBe(false);
    expect(repeatsQuestion("על מה מדובר?", "על מה מדובר?")).toBe(true);
    expect(repeatsQuestion("על מה מדובר?", "איזה צבע?")).toBe(false);
    expect(dropOrphanConditional("אם זה דגם אחר, תכתבי לי.", ["סמובי אליס"])).toBe("");
    expect(dropOrphanConditional("סמובי אליס מתאים. אם זה דגם אחר, תכתבי לי.", ["סמובי אליס"])).toMatch(/אם זה דגם אחר/);
  });
  it("★ her noun: only products of it, and a reply naming another kind", async () => {
    const { productsOfNoun, wrongProductType } = await import("../services/reply-engine/gates");
    const c = [{ title: "עט נמשים" }, { title: "טינט שפתיים עם מברשת" }];
    expect(productsOfNoun(c, "טינט שיש בסוף מברשת")?.map((x) => x.title)).toEqual(["טינט שפתיים עם מברשת"]);
    expect(productsOfNoun(c, "שפתון אדום")).toBeNull();
    expect(wrongProductType("עט נמשים הוא מה שאת מחפשת.", "טינט שיש בסוף מברשת", c.map((x) => x.title))).toBe(true);
    expect(wrongProductType("טינט שפתיים עם מברשת מתאים.", "טינט שיש בסוף מברשת", c.map((x) => x.title))).toBe(false);
  });
});

/** Rating on 83086356 (2026-11-18): "נינגה" with no geresh. */
describe("83086356 spot check: a geresh left out", () => {
  it("★ the knowledge search meets the table's spelling", async () => {
    const { lexicalTerms } = await import("../services/knowledge.service");
    const { own } = lexicalTerms("ולנינגה קריספי");
    expect(own).toContain("נינג");
    expect(own).toContain("נינגה");
    // Short words are not cut.
    expect(lexicalTerms("גזר").own).not.toContain("ג");
  });
  it("★ the fit check reads נינגה as נינג'ה", async () => {
    const { ungroundedPositiveFit } = await import("../services/reply-engine/gates");
    const table = "סיר טיגון ללא שמן נינג'ה: סמובי אליס";
    const three = ["סמובי אליס 31*41", "סמובי אסף 46*33"];
    expect(ungroundedPositiveFit("נינגה קריספי הוא סיר טיגון ללא שמן, ולנינגה קריספי מתאים סמובי אליס.", "ולנינגה קריספי", three, "", table)).toEqual([]);
  });
});

/** Rating on 83086356 (2026-11-18). */
describe("83086356 rating fixes", () => {
  it("★ urgency is no offer of a person; an 'if so' that names one is", async () => {
    const { offeredPerson } = await import("../services/reply-engine/gates");
    expect(offeredPerson("זה דחוף? נבדוק בעדיפות גבוהה.")).toBe(false);
    expect(offeredPerson("לסמן את זה כדחוף?")).toBe(false);
    expect(offeredPerson("זה דחוף? אם כן אעביר לנציג.")).toBe(true);
  });
  it("★ an imperative is a direct ask", async () => {
    const { imperativeAsk } = await import("../services/reply-engine/gates");
    expect(imperativeAsk("תעדכנו בבקשה ושלחו לי מספר הזמנה")).toBe(true);
    expect(imperativeAsk("please send me the order number")).toBe(true);
    expect(imperativeAsk("תודה רבה")).toBe(false);
  });
  it("★ sized items and the smallest pad that takes each", async () => {
    const { sizedItems, smallestFitting } = await import("../services/reply-engine/gates");
    expect(sizedItems("נינג׳ה קרמה 28x18 מיקסר 32x22 סודה 18x14").map((x) => x.size)).toEqual([[28, 18], [32, 22], [18, 14]]);
    expect(smallestFitting([32, 22], ["סמובי אסף 46*33", "סמובי אליס 31*41", "סמובי קטן 20*20"])).toBe("סמובי אליס 31*41");
    expect(smallestFitting([50, 40], ["סמובי אסף 46*33"])).toBeNull();
    const items = sizedItems("איזה מוצרי סמובי אני צריכה? נינג׳ה קרמה 28x18 מיקסר 32x22 סודה 18x14");
    expect(items.map((x) => x.name)).toEqual(["נינג׳ה קרמה", "מיקסר", "סודה"]);
    const { namesItem } = await import("../services/reply-engine/gates");
    expect(namesItem("לסודה: סמובי גפן.", "סודה")).toBe(true);
    expect(namesItem("למיקסר: סמובי אליס.", "סודה")).toBe(false);
    // The shared brand of two Ninja devices answers neither.
    expect(namesItem("לנינג'ה קרמה: סמובי אליס.", "נינג׳ה בלנדר", ["נינג׳ה קרמה"])).toBe(false);
    expect(namesItem("לנינג'ה קרמה: סמובי אליס.", "נינג׳ה קרמה", ["נינג׳ה בלנדר"])).toBe(true);
  });
  it("★ search hygiene: no 0..0 price, an audience only when she names one, never her whole message", async () => {
    const { cleanSearchArgs } = await import("../services/reply-engine/engine");
    expect(cleanSearchArgs({ query: "משטח", price_min: 0, price_max: 0, audience: "women" }, "היי מחפשת משטח")).toEqual({ query: "משטח" });
    expect(cleanSearchArgs({ query: "צעיף", audience: "men" }, "צעיף לבעלי")).toEqual({ query: "צעיף", audience: "men" });
    expect(cleanSearchArgs({ query: "היי מחפשת את הבובון לקשירה נמוכה" }, "היי מחפשת את הבובון לקשירה נמוכה").query).toBe("הבובון לקשירה נמוכה");
    expect(cleanSearchArgs({ query: "תיק", price_max: 200 }, "תיק עד 200").price_max).toBe(200);
  });
});

/** 6e6c306a five-devices (2026-11-18). */
describe("6e6c306a five-devices", () => {
  it("★ pads with their sizes from the business's texts", async () => {
    const { padsFromText } = await import("../services/reply-engine/gates");
    expect(padsFromText("מידות המשטחים: סמובי אליס 31*41, סמובי אסף 46*33")).toEqual(["סמובי אליס 31*41", "סמובי אסף 46*33"]);
  });
  it("★ 'לא עלתה התאמה' is a negative fit claim", async () => {
    const { ungroundedNegativeFit } = await import("../services/reply-engine/gates");
    expect(ungroundedNegativeFit("לטוסטר לא עלתה התאמה לפי המידות.", "טוסטר 24x15", ["סמובי גפן 26*20"], "")).toHaveLength(1);
  });
});

/** Rating on 052f53ad (2026-11-18). */
describe("052f53ad rating fixes", () => {
  it("★ a URL not in any source: the source's own URL with the same start, else the sentence goes", async () => {
    const { repairUrls } = await import("../services/reply-engine/gates");
    const src = "Product: https://chanivainberger.co.il/product/%d7%94%d7%9e-abc and https://shop.example/";
    const bad = "בעמוד המוצר: https://chanivainberger.co.il/product/%d7%ה%d7%9e-abc תודה.";
    const r = repairUrls(bad, src);
    expect(r.text).toContain("https://chanivainberger.co.il/product/%d7%94%d7%9e-abc");
    expect(r.fixed).toBe(1);
    const u = repairUrls("הנה: https://evil.example/x. ואחלה יום.", src);
    expect(u.text).not.toMatch(/evil/);
    expect(u.text).toMatch(/אחלה יום/);
    expect(repairUrls("באתר: https://shop.example/", src).fixed).toBe(0);
    expect(repairUrls("באתר: https://shop.example/", src).dropped).toBe(0);
    // The store's home on a host the sources know, though not verbatim: kept.
    expect(repairUrls("באתר: https://chanivainberger.co.il/ תודה.", src).text).toContain("https://chanivainberger.co.il/");
    // A URL denial in gate3 when the data has one.
    const { gate3 } = await import("../services/reply-engine/gates");
    const v = gate3({ ...baseG3, reply: "אין לי כאן קישור לסרטון.", grounding: "סרטון: https://youtu.be/abc" } as any);
    expect(JSON.stringify(v)).toMatch(/קישור לסרטון/);
  });
  it("★ 'no link' while the data has one is an absence claim", async () => {
    const { deniesKnownLink } = await import("../services/reply-engine/gates");
    expect(deniesKnownLink("אין לי כאן קישור לסרטון.", "סרטון: https://youtu.be/abc")).toHaveLength(1);
    expect(deniesKnownLink("אין לי כאן קישור לסרטון.", "אין סרטון")).toEqual([]);
  });
  it("★ how-to and safety asks; pad labels; pads named only by a size are no pads", async () => {
    const { howToSafetyAsk, padLabel, padsFromText } = await import("../services/reply-engine/gates");
    expect(howToSafetyAsk("הבלנדר התהפך, איפה שמים את המעצורים?")).toBe(true);
    expect(howToSafetyAsk("זה בטוח לשים על השיש?")).toBe(true);
    expect(howToSafetyAsk("כמה זה עולה?")).toBe(false);
    expect(padLabel("סמובי אליס 31*41")).toBe("סמובי אליס");
    expect(padLabel("סמובי גפן 26x20 ס\"מ")).toBe("סמובי גפן");
    expect(padsFromText("מידות 31*41, סמובי אליס 31*41")).toEqual(["סמובי אליס 31*41"]);
  });
});

/** Items 1 to 9 of the 1771ba14 rating (2026-11-18), on the prod engine line. */
describe("1771ba14 rating items", () => {
  it("★ 1: a pad's distinguishing name, never a generic noun; 'לא נקבעה התאמה' is a no-fit claim", async () => {
    const g: any = await import("../services/reply-engine/gates");
    const pads = ["משטח הזזה 32*22", "משטח הזזה 31*41", "משטח הזזה 46*33"];
    expect(g.padName("משטח הזזה 31*41", pads, ["סמובי אליס 31*41", "סמובי אסף 46*33"])).toBe("סמובי אליס");
    expect(g.padName("משטח הזזה 32*22", pads, [])).toBe("משטח הזזה 32*22");
    expect(g.padName("סמובי גפן 26*20", ["סמובי גפן 26*20", "סמובי אליס 31*41"], [])).toBe("סמובי גפן");
    expect(g.ungroundedNegativeFit("למיקסר ולטוסטר לא נקבעה התאמה.", "מיקסר 32x22", ["סמובי אליס 31*41"], "")).toHaveLength(1);
  });
  it("★ 2: a sentence with an unbalanced bracket goes; never the whole reply", async () => {
    const { dropBrokenFragments } = await import("../services/reply-engine/gates");
    expect(dropBrokenFragments("מתאים לפמילי ושבת. [אלכסה מתאים לתמי 4").text).toBe("מתאים לפמילי ושבת.");
    expect(dropBrokenFragments("ראי (בעמוד המוצר) כאן.").dropped).toBe(0);
    expect(dropBrokenFragments("[רק זה").text).toBe("רק זה");
    expect(dropBrokenFragments("ראי https://x.co/a(1 כאן.").dropped).toBe(0);
  });
  it("★ 3: a pad for ANOTHER device offered as an alternative is cut", async () => {
    const { ungroundedPositiveFit } = await import("../services/reply-engine/gates");
    const titles = ["סמובי כריסטינה 23*40", "סמובי אליס 31*41"];
    const kb = "סמובי כריסטינה: נינג'ה סלושי";
    expect(ungroundedPositiveFit("או לראות את סמובי כריסטינה שמתאימה לנינג'ה סלושי.", "יש משטח לנינג'ה קריספי?", titles, "", kb)).toHaveLength(1);
    expect(ungroundedPositiveFit("סמובי כריסטינה מתאימה לנינג'ה סלושי.", "יש משטח לנינג'ה סלושי?", titles, "", kb)).toEqual([]);
  });
  it("★ 4: 'no model by that name' when she named none", async () => {
    const { nameMissUnasked } = await import("../services/reply-engine/gates");
    expect(nameMissUnasked("לא מצאתי דגם בשם הזה. אפשר את שם הדגם?", "אפשר המלצה?")).toHaveLength(1);
    expect(nameMissUnasked("לא מצאתי דגם בשם הזה.", "יש לכם XR-200?")).toEqual([]);
  });
  it("★ 5: a silence promise", async () => {
    const { SILENCE_PROMISE } = await import("../services/reply-engine/gates");
    expect(SILENCE_PROMISE.test("נשאיר את זה בשקט ולא נשלח הודעה נוספת.")).toBe(true);
    expect(SILENCE_PROMISE.test("לא נשלח הודעה נוספת עד שיהיה עדכון.")).toBe(true);
    expect(SILENCE_PROMISE.test("נשלח לך עדכון כאן.")).toBe(false);
  });
  it("★ 6: the replay always prints a search line", async () => {
    const { searchLine } = await import("../scripts/replay-v2");
    expect(searchLine({})).toBe("none");
    expect(searchLine({ tools: [{ tool: "woocommerce.list_products", args: { query: "בובות" }, outcome: "empty", resultCount: 0 }] })).toMatch(/model args: list_products \{"query":"בובות"\} -> empty \(0\)/);
    // The titles it returned, the first three, 60 characters each; what was sent is labelled apart.
    const l = searchLine({ searchArgs: [{ tool: "woocommerce.list_products", q: "מיקסר" }], tools: [{ tool: "woocommerce.list_products", args: { query: "מיקסר", audience: "men" }, outcome: "ok", resultCount: 2, content: 'PRODUCT_1: "משטח הזזה 20*25" | ILS 99\nPRODUCT_2: "משטח הזזה 31*41" | ILS 129' }] });
    expect(l).toMatch(/^sent: list_products q="מיקסר" \| model args: /);
    expect(l).toMatch(/\["משטח הזזה 20\*25", "משטח הזזה 31\*41"\]/);
  });
  it("★ 7: a derived measure no source states", async () => {
    const { derivedMeasure } = await import("../services/reply-engine/gates");
    expect(derivedMeasure("כל צלע של המשולש היא בערך 70 ס\"מ.", "מטפחת 70x70 ס\"מ")).toHaveLength(1);
    expect(derivedMeasure("המטפחת בגודל 70 על 70 ס\"מ.", "מטפחת 70x70 ס\"מ")).toEqual([]);
  });
  it("★ 9: 'אין כאן מידע על גוונים' while the product data has the shades", async () => {
    const { infoDeniedButKnown } = await import("../services/reply-engine/gates");
    expect(infoDeniedButKnown("אין כאן מידע על גוונים של הבסיס.", "גוונים: Sand, Medium, Honey")).toHaveLength(1);
  });
});

describe("C pinned rating c24439a1: units", () => {
  it("★ a guessed audience never reaches the store: not hers, not on a kitchen-pad ask", async () => {
    const { cleanSearchArgs } = await import("../services/reply-engine/engine");
    expect((cleanSearchArgs({ query: "בובון", audience: "women" } as any, "היי מחפשת את הבובון לקשירה נמוכה") as any).audience).toBeUndefined();
    expect((cleanSearchArgs({ query: "מיקסר", audience: "men" } as any, "מיקסר 30x22 טוסטר 24x15") as any).audience).toBeUndefined();
    expect((cleanSearchArgs({ query: "חולצה", audience: "men" } as any, "חולצה לגבר") as any).audience).toBe("men");
  });
  it("★ 3: a greeting is no noun: 'היי מחפשת את הבובון' is about the bubon", async () => {
    const { headNoun, productsOfNoun } = await import("../services/reply-engine/gates");
    expect(headNoun("היי מחפשת את הבובון לקשירה נמוכה")).toBe("הבובון");
    const c = [{ title: "מטפחת משי" }, { title: "בובון קטיפה לקשירה נמוכה" }];
    expect(productsOfNoun(c, "היי מחפשת את הבובון לקשירה נמוכה")?.map((x) => x.title)).toEqual(["בובון קטיפה לקשירה נמוכה"]);
  });
  it("★ 2: howToLink picks the discussed product's line, else the only video, else none", async () => {
    const { howToLink } = await import("../services/reply-engine/gates");
    const kb = "מיס ריס מסקרה: https://shop.example/product/miss-lash\nעט גבות פדרה, סרטון הדרכה: https://youtu.be/brow123";
    expect(howToLink(kb, ["יש לכם עט גבות? אשמח לסרטון הדרכה"])).toBe("https://youtu.be/brow123");
    expect(howToLink(kb, ["אשמח לסרטון הדרכה", "כן, מיס ריס מסקרה."])).toBe("https://shop.example/product/miss-lash");
    expect(howToLink("מסקרה: https://shop.example/a\nסרטון: https://youtu.be/only", ["אשמח לסרטון"])).toBe("https://youtu.be/only");
    expect(howToLink("סרטון א: https://youtu.be/a\nסרטון ב: https://youtu.be/b", ["אשמח לסרטון"])).toBeNull();
  });
  it("★ 1: held kinds are payment (a refund included), damage and safety only", async () => {
    const { holdingItem } = await import("../services/reply-engine/gates");
    expect(holdingItem(["Customer asks whether shipping is paid"])).toBeNull();
    expect(holdingItem(["האם המשלוח כפול"])).toBeNull();
    expect(holdingItem(["חויבתי פעמיים"])).not.toBeNull();
    expect(holdingItem(["המשטח הגיע שבור"])).not.toBeNull();
    expect(holdingItem(["החזר כספי על המשטח"])).not.toBeNull();
  });
  it("★ 5: the last message sent was the hold line, a silent turn between", async () => {
    const { lastSentHoldLine } = await import("../services/reply-engine/engine");
    expect(lastSentHoldLine({ _holdLineTurn: "3", _spokeTurn: "3" }, "", "he")).toBe(true);
    expect(lastSentHoldLine({ _holdLineTurn: "3", _spokeTurn: "4" }, "", "he")).toBe(false);
    expect(lastSentHoldLine({}, "החיוב עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.", "he")).toBe(true);
  });
  it("★ 6: general know-how is never a team question, a follow-up on it is answered", async () => {
    const { PLATFORM_RULES } = await import("../services/reply-engine/prompt");
    const all = PLATFORM_RULES;
    expect(all).toMatch(/It is not a fact about this store: answer it yourself/);
    // There is no team question at all any more (2026-11-23).
    expect(all).toMatch(/Never say something was passed to the team, that the team is checking, or that an answer will come later/);
  });
});

describe("nothing new from the customer: the only turns silence may meet (2026-11-19)", () => {
  it("an acknowledgement, a bare nudge and a message with no words bring nothing new", async () => {
    const { nothingNewFromCustomer } = await import("../services/reply-engine/gates");
    for (const t of ["טוב", "אוקיי תודה", "תודה רבה!", "נו", "נו?", "נווו", "אה", "hm", "well", "👍", "...", ""]) expect(nothingNewFromCustomer(t), t).toBe(true);
  });
  it("her own words are new, also short ones and ones that open like a nudge", async () => {
    const { nothingNewFromCustomer } = await import("../services/reply-engine/gates");
    for (const t of ["אני לא טובה בלראות באתר וכו..", "אני לא זוכרת מאיזה מייל הזמנתי", "נו אז מה עם הצעיף", "כחול", "נושא אחר", "so what now", "wellness set"]) expect(nothingNewFromCustomer(t), t).toBe(false);
  });
  it("the same message again counts only against an earlier turn's message, punctuation aside", async () => {
    const { nothingNewFromCustomer } = await import("../services/reply-engine/gates");
    const said = "אני לא טובה בלראות באתר וכו..";
    expect(nothingNewFromCustomer(said, ["מחפשת צעיף", "אני לא טובה בלראות באתר וכו"])).toBe(true);
    expect(nothingNewFromCustomer(said, ["מחפשת צעיף", "אני לא טובה בלראות באתר, אפשר עזרה?"])).toBe(false);
    expect(nothingNewFromCustomer(said, [])).toBe(false);
  });
});

describe("a sentence that opens with a bare pronoun leans on the one before it (the 41805962 replay, Smoovee L511)", () => {
  it("★ the L511 opening and its forms lean; a word that only starts like a pronoun does not", async () => {
    const { LEANS_ON_BEFORE } = await import("../services/reply-engine/engine");
    for (const x of ["הוא במבצע עכשיו ב-₪129.15.", " והיא מגיעה בשלושה צבעים.", "הם במלאי.", "הן עשויות במבוק.", "It is on sale now at 129.15.", "They come in three colours."]) expect(LEANS_ON_BEFORE.test(x), x).toBe(true);
    for (const x of ["הואיל והמיקסר כבד, נדרש מעצור.", "המשטח במבצע עכשיו ב-₪129.15.", "למיקסר יש התאמות לפי דגם, איזה דגם יש לך?", "המשלוח הוא חינם.", "Items ship in three days.", "Theyre is no word."]) expect(LEANS_ON_BEFORE.test(x), x).toBe(false);
  });
});

// The customer's message, the draft and the sent text are the replay's own (prod replay 2026-11-22, a webchat
// conversation whose earlier turn had read the product at its sale price).
describe("prod replay 2026-11-22: a price said of a product an earlier turn showed", () => {
  const INCOMING = "איזה גוון מייקאפ יתאים לעור שלי?";
  const DRAFT = "יש לנו מייקאפ טינט שמתאים כמעט לכולן ומשנה גוון מלבן לצבע העור. אם הכוונה למייקאפ אחר, כתבי איזה מוצר ואכוון לפי הגוונים שלו.";
  const SENT = "מייקאפ טינט מתאים כמעט לכולן, הוא משנה גוון מלבן לצבע העור ומחירו 178 ₪. אם התכוונת למייקאפ אחר, כתבו איזה מוצר ואכוון אותך לפי הגוונים שלו.";
  // The price as the store wrote it and the state kept it.
  const SHOWN = [{ title: "מייקאפ טינט", price: "160.20" }];
  // The turn's only tool was the knowledge search, and the document gives the regular price.
  const DOCUMENT = [{ callId: "call_k", tool: "search_knowledge", outcome: "ok", content: "מייקאפ טינט, 178 ₪" }] as any;
  const STORE = ["search_knowledge", "woocommerce.list_products"];
  const run = async (reply: string, over: any = {}) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: DOCUMENT, grounding: "מייקאפ טינט, 178 ₪ 160.20 ₪", locale: "he", incomingMessage: INCOMING, isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: STORE, shopFloor: true, handedOff: false, approvalPending: false, ...over } as any).problems;
  };
  const kindsOf = (ps: any[]) => ps.map((p) => p.kind);

  it("★ the draft names the product an earlier turn showed: it is not \"products without a name\"", async () => {
    const { namelessProducts } = await import("../services/reply-engine/gates");
    // The defect: only this turn's products counted as names, and this turn read none.
    expect(namelessProducts(DRAFT, INCOMING, [], [], false)).toBe(true);
    expect(namelessProducts(DRAFT, INCOMING, [], ["מייקאפ טינט"], false)).toBe(false);
    expect(kindsOf(await run(DRAFT))).toContain("nameless_products");
    expect(kindsOf(await run(DRAFT, { carriedPrices: SHOWN }))).not.toContain("nameless_products");
    // A shown product the draft does not name leaves the draft nameless.
    expect(kindsOf(await run(DRAFT, { carriedPrices: [{ title: "סרום לילה", price: 90 }] }))).toContain("nameless_products");
    // A shown product whose price was never read is a name all the same.
    expect(kindsOf(await run(DRAFT, { carriedPrices: [{ title: "מייקאפ טינט", price: null }] }))).not.toContain("nameless_products");
  });

  it("★ the sent text: the document's 178 for a product read earlier at 160.20 is a price against the store", async () => {
    const { priceAgainstStore } = await import("../services/reply-engine/gates");
    expect(priceAgainstStore(SENT, [], DOCUMENT, true, SHOWN)).toEqual([SENT.split(". ")[0] + "."]);
    // The defect: without the earlier read, nothing named a product the gate knew.
    expect(priceAgainstStore(SENT, [], DOCUMENT, true)).toEqual([]);
    const flagged = (await run(SENT, { carriedPrices: SHOWN })).find((p) => p.kind === "price_against_store") as any;
    expect(flagged.claims).toHaveLength(1);
    expect(flagged.store).toEqual(["מייקאפ טינט: 160.20"]);
    expect(kindsOf(await run(SENT))).not.toContain("price_against_store");
    // The price read then passes, alone or beside the regular one.
    for (const ok of [SENT.replace("178", "160.20"), SENT.replace("178 ₪", "160.20 ₪ במקום 178 ₪"), SENT.replace("178 ₪", "‏160.2 ש\"ח")]) {
      expect(priceAgainstStore(ok, [], DOCUMENT, true, SHOWN), ok).toEqual([]);
      expect(kindsOf(await run(ok, { carriedPrices: SHOWN })), ok).not.toContain("price_against_store");
    }
    // It does not need a store search to be offered: the price was the store's own.
    expect(priceAgainstStore(SENT, [], DOCUMENT, false, SHOWN)).toHaveLength(1);
  });

  it("★ this turn's read is the newer one; a read that brought no product still read a price", async () => {
    const { priceAgainstStore } = await import("../services/reply-engine/gates");
    const now = [{ title: "מייקאפ טינט", price: 149 }];
    const read = [{ callId: "c1", tool: "woocommerce.list_products", outcome: "ok", content: "PRODUCT_1: \"מייקאפ טינט\" ₪149" }] as any;
    expect(priceAgainstStore("מייקאפ טינט עולה 149 ₪.", now, read, true, SHOWN)).toEqual([]);
    expect(priceAgainstStore("מייקאפ טינט עולה 160.20 ₪.", now, read, true, SHOWN)).toHaveLength(1);
    // A sentence that gives this turn's product its own price is that product's, though it names a shown one too.
    expect(priceAgainstStore("Velvet Foundation עולה 50 ₪, פחות ממייקאפ טינט.", [{ title: "Velvet Foundation", price: 50 }], [], true, SHOWN)).toEqual([]);
    // The same title in another letter case is the same product.
    expect(priceAgainstStore("Tint Makeup costs ₪160.20.", [{ title: "TINT MAKEUP", price: 149 }], read, true, [{ title: "Tint Makeup", price: 160.2 }])).toHaveLength(1);
    const one = [{ callId: "c2", tool: "woocommerce.get_product", outcome: "ok", content: "{\"name\":\"מייקאפ טינט\",\"price\":\"149\"}" }] as any;
    expect(priceAgainstStore("מייקאפ טינט עולה 149 ₪.", [], one, true, SHOWN)).toEqual([]);
    // A failed read, or the same number in a document, is no store price.
    expect(priceAgainstStore("מייקאפ טינט עולה 149 ₪.", [], [{ ...one[0], outcome: "error" }] as any, true, SHOWN)).toHaveLength(1);
    expect(priceAgainstStore("מייקאפ טינט עולה 149 ₪.", [], [{ callId: "k", tool: "search_knowledge", outcome: "ok", content: "149 ₪" }] as any, true, SHOWN)).toHaveLength(1);
  });

  it("★ a shipping price beside the product's name is not the product's; another product's price is not held to this one", async () => {
    const { priceAgainstStore } = await import("../services/reply-engine/gates");
    for (const ok of ["המשלוח של מייקאפ טינט עולה 30 ₪.", "משלוח עד הבית למייקאפ טינט: 30 ₪.", "מייקאפ טינט נשלח עם שליח ב-30 ₪.", "כתוב שהמשלוח של מייקאפ טינט עולה 30 ₪.", "ולמשלוחים של מייקאפ טינט יש מחיר: 30 ₪.", "Shipping for מייקאפ טינט is ₪30.", "Delivery of מייקאפ טינט costs ₪30."]) {
      expect(priceAgainstStore(ok, [], DOCUMENT, true, SHOWN), ok).toEqual([]);
    }
    // A word that only contains the letters is not shipping.
    expect(priceAgainstStore("מייקאפ טינט, המשלוחן ממליץ, עולה 178 ₪.", [], DOCUMENT, true, SHOWN)).toHaveLength(1);
    // A sentence that does not name the shown product is left to the other checks.
    expect(priceAgainstStore("קרם היום עולה 178 ₪.", [], DOCUMENT, true, SHOWN)).toEqual([]);
  });

  it("★ a shown product whose price was never read: a price for it needs a store read", async () => {
    const { priceAgainstStore } = await import("../services/reply-engine/gates");
    const unread = [{ title: "מייקאפ טינט", price: null }];
    expect(priceAgainstStore(SENT, [], DOCUMENT, true, unread)).toHaveLength(1);
    // No store to read from: the document is all there is.
    expect(priceAgainstStore(SENT, [], DOCUMENT, false, unread)).toEqual([]);
    // A store read this turn gave the number; so did another tool that is no document (her order).
    const read = [{ callId: "c3", tool: "woocommerce.get_product", outcome: "ok", content: "{\"price\":\"178\"}" }] as any;
    expect(priceAgainstStore(SENT, [], read, true, unread)).toEqual([]);
    expect(priceAgainstStore(SENT, [], [{ callId: "c5", tool: "woocommerce.get_order", outcome: "ok", content: "{\"total\":\"178\"}" }] as any, true, unread)).toEqual([]);
    expect(priceAgainstStore(SENT, [], [], true, unread)).toHaveLength(1);
    // A read of another product this turn did not read this one.
    expect(priceAgainstStore(SENT, [], [{ callId: "c6", tool: "woocommerce.list_products", outcome: "ok", content: "PRODUCT_1: \"סרום לילה\" ₪95" }] as any, true, unread)).toHaveLength(1);
    // One shown product with a read price and it is said: the unread one beside it is not the ground to flag.
    expect(priceAgainstStore("מייקאפ טינט וסרום לילה ב-160.20 ₪.", [], DOCUMENT, true, [...SHOWN, { title: "סרום לילה", price: null }])).toEqual([]);
  });

  it("★ a regular price alone is no price of a product on sale: it counts only beside the sale price", async () => {
    const { priceAgainstStore } = await import("../services/reply-engine/gates");
    const c = [{ title: "Velvet Foundation", price: 160.2, was: 178 }];
    const read = [{ callId: "c4", tool: "woocommerce.list_products", outcome: "ok", content: "[{\"price\":\"160.20\",\"regular_price\":\"178\"}]" }] as any;
    expect(priceAgainstStore("Velvet Foundation עולה 178 ₪.", c, read, true)).toHaveLength(1);
    expect(priceAgainstStore("Velvet Foundation במבצע ב-160.20 ₪ במקום 178 ₪.", c, read, true)).toEqual([]);
    // The sale price in another sentence of the same reply is beside it too.
    expect(priceAgainstStore("Velvet Foundation עולה בדרך כלל 178 ₪. עכשיו הוא ב-160.20 ₪.", c, read, true)).toEqual([]);
    // Another number in the reply is not the sale price.
    expect(priceAgainstStore("Velvet Foundation עולה 178 ₪. משלוח ב-30 ₪.", c, read, true)).toHaveLength(1);
  });

  it("★ the correction gives the store's price, and never asks for a price a document may hold", async () => {
    const { storePricesNamed } = await import("../services/reply-engine/gates");
    expect(storePricesNamed(SENT, [], SHOWN)).toEqual(["מייקאפ טינט: 160.20"]);
    // Each price in the form it was read in (that form grounds it); this turn's read before an earlier one of the same product.
    expect(storePricesNamed("Canvas Tote and Velvet Foundation", [{ title: "Canvas Tote", price: 79 }, { title: "Velvet Foundation", price: "160.20", was: 178 }], [{ title: "canvas tote", price: 99 }, { title: "Unnamed", price: 5 }])).toEqual(["Canvas Tote: 79", "Velvet Foundation: 160.20 (regular 178)"]);
    expect(storePricesNamed("Velvet Foundation", [], [{ title: "Velvet Foundation", price: 160.2 }])).toEqual(["Velvet Foundation: 160.2"]);
    expect(storePricesNamed("Velvet Foundation", [{ title: "Velvet Foundation", price: " 160.20 ", was: "178.00" }])).toEqual(["Velvet Foundation: 160.20 (regular 178.00)"]);
    // No price read, or a regular price that is the price: nothing to give, nothing to add.
    expect(storePricesNamed(SENT, [], [{ title: "מייקאפ טינט", price: null }])).toEqual([]);
    expect(storePricesNamed("Canvas Tote", [{ title: "Canvas Tote", price: 79, was: 79 }])).toEqual(["Canvas Tote: 79"]);
    const withPrice = correctionNote([{ kind: "price_against_store", claims: ["x"], store: ["מייקאפ טינט: 160.20"] }], "he");
    expect(withPrice).toContain("The store's price: מייקאפ טינט: 160.20. Give that one; a regular price only next to it, as the price before the sale.");
    expect(withPrice).not.toContain("Read the product");
    for (const none of [undefined, []]) {
      const n = correctionNote([{ kind: "price_against_store", claims: ["x"], store: none as any }], "he");
      expect(n).toContain("Read the product (search or get_product) and give the store's price.");
      expect(n).not.toContain("The store's price:");
    }
    expect(correctionNote([{ kind: "nameless_products" }], "he")).toContain("each with the price the search gave for it (never a price from a document)");
  });

  it("★ what the state carries into the check: each shown product with the price read then", async () => {
    const { carriedPricesOf } = await import("../services/reply-engine/engine");
    expect(carriedPricesOf([
      { title: " מייקאפ טינט ", price: "160.20" as any }, { title: "", price: 5 }, { title: "A", price: null }, { title: "B", price: 0 }, { title: "C", price: "soon" as any }, { title: null, price: 9 },
      { title: "D", price: 89 }, { title: "E", price: -5 },
    ])).toEqual([{ title: "מייקאפ טינט", price: "160.20" }, { title: "A", price: null }, { title: "B", price: null }, { title: "C", price: null }, { title: "D", price: 89 }, { title: "E", price: null }]);
    expect(carriedPricesOf(null)).toEqual([]);
    expect(carriedPricesOf(undefined)).toEqual([]);
  });
});
