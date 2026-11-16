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
    expect([...FACTUAL_KINDS].sort()).toEqual(["ungrounded_absence", "ungrounded_price", "unknown_product", "unsupported_action"]);
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
  });

  it("★ the engine's own lookups for a rewrite: the customer's words, two at most, none it cannot make", async () => {
    const { autoLookups } = await import("../services/reply-engine/gates");
    const a = autoLookups([{ kind: "ungrounded_absence", claims: ["x"] }, { kind: "unread_knowledge" }] as any, "יש משטחי במבוק?", STORE, []);
    expect(a.map((c) => [c.function.name, JSON.parse(c.function.arguments).query])).toEqual([["woocommerce.list_products", "יש משטחי במבוק?"], ["search_knowledge", "יש משטחי במבוק?"]]);
    const narrow = autoLookups([{ kind: "gave_up_search" }] as any, "תיקים", STORE, [{ tool: "woocommerce.list_products", outcome: "timeout", args: { query: "תיקי בד לחוף קיץ" } } as any]);
    expect(JSON.parse(narrow[0].function.arguments)).toEqual({ query: "תיקי בד", per_page: 5 });
    expect(autoLookups([{ kind: "unread_product" }, { kind: "unread_order" }] as any, "x", STORE, [])).toEqual([]);
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
