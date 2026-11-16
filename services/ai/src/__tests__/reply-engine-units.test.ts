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
  it("a read that timed out is not retried (it already took the whole budget: 2 x 8s on Smoovee searches)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../services/reply-engine/tools.ts"), "utf8");
    const retry = src.slice(src.indexOf("let first: any = await attempt();"), src.indexOf("let first: any = await attempt();") + 600);
    expect(retry).toMatch(/if \(isRead && first !== TIMEOUT && \("thrown" in first \|\| readErrored\(first\.r\?\.content\)\)\)/);
  });
});

describe("prod replay 2: what may stop a reply, and the cleanup", () => {
  it("only a price, a product or an action no tool backs is a FACT problem", async () => {
    const { factualProblems, FACTUAL_KINDS } = await import("../services/reply-engine/gates");
    expect([...FACTUAL_KINDS].sort()).toEqual(["ungrounded_price", "unknown_product", "unsupported_action"]);
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
