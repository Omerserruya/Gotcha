/** The independent rating of the 1b35c535 prod replay (replay e, 2026-11-18): the units. Every rule generic. */
import { describe, it, expect } from "vitest";
import { fixCardCount, dropOrphanAlso, ungroundedPositiveFit, neutralSecondPerson, cardReferences } from "../services/reply-engine/gates";
import { cutFragment, withoutSlashForms, productQuestionLine, oneTeamPass as onePass } from "../services/reply-engine/engine";
import { ungroundedAttribute, unlabelledInactiveOrders, videoAsk, productAskNow, caveatHolds, attributeOnlyAsk, fallbackQueryOf, withFocusNoun } from "../services/reply-engine/gates";
import { referredCandidates, focusTitle, purchaseWithoutSearch, simulationLeak, unreadProduct } from "../services/reply-engine/gates";
import { storeQueryOf, explanationAsk, autoLookups, derivedMeasure, stripFactProblems, wantsItSettled, nameSizeLines, colourList, howToLink } from "../services/reply-engine/gates";
import { cutLine } from "../scripts/replay-v2";
import { cutFields } from "../services/reply-engine/engine";
import { oneTeamPass, withoutCheckedClaims, selfSearch, withClosingQuestion, withNewDetails } from "../services/reply-engine/engine";

const WOO = ["woocommerce.list_products", "search_knowledge"];
const q = (calls: any[]) => calls.map((c) => [c.function.name, JSON.parse(c.function.arguments).query]);

describe("1: the store is searched by her product words, never her sentence", () => {
  it("★ the question around the product goes", () => {
    expect(storeQueryOf("מאיזה חומר השרשרת?")).toBe("השרשרת");
    expect(storeQueryOf("מאיזה חומר השרשרת?", { substring: true })).toBe("שרשרת");
    expect(storeQueryOf("יש משטחי במבוק?")).toBe("משטחי במבוק");
    expect(storeQueryOf("what material is the chain made of?")).toBe("chain");
    expect(storeQueryOf("המשטח מתאים לתמי 4?", { substring: true })).toBe("משטח לתמי 4");
    expect(storeQueryOf("desk lamp")).toBe("desk lamp");
  });
  it("★ nothing of hers to search: null (no random product for \"איזה מוצר מתאים לי\" or \"אפשר להזמין\")", () => {
    for (const s of ["איזה מוצר מתאים לי", "אפשר להזמין?", "אשמח לסרטון הדרכה"]) expect(storeQueryOf(s), s).toBeNull();
    expect(autoLookups([{ kind: "no_search" }] as any, "איזה מוצר מתאים לי", WOO, [])).toEqual([]);
    expect(autoLookups([{ kind: "no_search" }] as any, "אפשר להזמין?", WOO, [])).toEqual([]);
  });
  it("★ an explanation goes to the knowledge, never the store (NE'A: \"איך אדע מה התת גוון\" found a powder)", () => {
    expect(explanationAsk("איך אדע מה התת גוון")).toBe(true);
    expect(explanationAsk("מה זה תת גוון?")).toBe(true);
    expect(explanationAsk("how do I know my size")).toBe(true);
    expect(explanationAsk("איך מזמינים?")).toBe(false);
    expect(explanationAsk("יש לכם משטח למיקסר?")).toBe(false);
    expect(q(autoLookups([{ kind: "no_search" }] as any, "איך אדע מה התת גוון", WOO, []))).toEqual([["search_knowledge", "איך אדע מה התת גוון"]]);
    expect(autoLookups([{ kind: "no_search" }] as any, "איך אדע מה התת גוון", ["woocommerce.list_products"], [])).toEqual([]);
  });
  it("★ no product word of hers: the product in focus (NE'A: the marker lost to the literal sentence)", () => {
    expect(q(autoLookups([{ kind: "ungrounded_absence", claims: ["אין סרטון"] }] as any, "אשמח לסרטון הדרכה", WOO, [], "טוש גבות Miss eyebrows"))[0]).toEqual(["woocommerce.list_products", "טוש גבות Miss eyebrows"]);
  });
});

describe("1 (verify of d5f288f6): a prefix letter comes off only where the search matches inside titles", () => {
  // [sentence, as written for a word search (Shopify), for a substring search (WooCommerce)]
  const cases: Array<[string, string, string]> = [
    ["יש לכם בגדי הריון?", "בגדי הריון", "בגדי ריון"],
    ["מחפשת הלבשה תחתונה", "הלבשה תחתונה", "לבשה תחתונה"],
    ["היילייטר נוזלי", "היילייטר נוזלי", "יילייטר נוזלי"],
    ["יש הדפסה אישית על חולצה?", "הדפסה אישית חולצה", "דפסה אישית חולצה"],
    ["המלצה לשמפו לשיער יבש", "לשמפו לשיער יבש", "שמפו שיער יבש"],
    ["רוצה לקנות היפוך", "היפוך", "יפוך"],
  ];
  it("★ a word search keeps every word as written (a root ה is never lost)", () => {
    for (const [s, word] of cases) expect(storeQueryOf(s), s).toBe(word);
  });
  it("★ on a substring search the shorter form is inside the word as written: it can only add matches", () => {
    for (const [s, word, sub] of cases) {
      expect(storeQueryOf(s, { substring: true }), s).toBe(sub);
      sub.split(" ").forEach((w, i) => expect(word.split(" ")[i], s).toContain(w));
    }
  });
  it("★ the store decides: WooCommerce is substring, Shopify is not", () => {
    expect(q(autoLookups([{ kind: "no_search" }] as any, "יש לכם בגדי הריון?", ["shopify.search_products"], []))[0]).toEqual(["shopify.search_products", "בגדי הריון"]);
    expect(q(autoLookups([{ kind: "no_search" }] as any, "יש לכם בגדי הריון?", WOO, []))[0]).toEqual(["woocommerce.list_products", "בגדי ריון"]);
  });
  it("★ ask words never reach the store; an order, shipping or business ask searches no product", () => {
    expect(storeQueryOf("איפה ההזמנה שלי")).toBeNull();
    expect(storeQueryOf("כמה עולה משלוח לירושלים")).toBeNull();
    expect(storeQueryOf("יש הנחה על המשטח?")).toBe("המשטח");
    expect(storeQueryOf("מה המחיר של הסרום")).toBe("הסרום");
    expect(storeQueryOf("מה המחיר של הסרום", { substring: true })).toBe("סרום");
    // A colour's ב comes off ("באפור" matches inside "כרית אפורה" on a substring search).
    expect(storeQueryOf("הכרית הזאת קיימת באפור?")).toBe("הכרית אפור");
    // A size alone is no product: the product in focus is searched instead.
    expect(storeQueryOf("יש לכם את זה במידה 42?")).toBeNull();
    expect(q(autoLookups([{ kind: "no_search" }] as any, "יש לכם את זה במידה 42?", WOO, [], "שמלת ערב שחורה"))[0]).toEqual(["woocommerce.list_products", "שמלת ערב שחורה"]);
    expect(autoLookups([{ kind: "no_search" }] as any, "איפה ההזמנה שלי", WOO, [])).toEqual([]);
  });
});

describe("2: a full answer before a bare team line", () => {
  it("★ a question about the product itself: the engine reads the product in focus and the knowledge (Smoovee stopper)", () => {
    expect(q(autoLookups([{ kind: "unread_product" }, { kind: "no_search" }] as any, "יש לזה פקק?", WOO, [], "סמובי אליס"))).toEqual([["woocommerce.list_products", "סמובי אליס"], ["search_knowledge", "יש לזה פקק?"]]);
    expect(q(autoLookups([{ kind: "unread_product" }] as any, "יש לזה פקק?", WOO, [], "סמובי אליס"))[0]).toEqual(["woocommerce.list_products", "סמובי אליס"]);
    expect(q(autoLookups([{ kind: "unread_product" }] as any, "מאיזה חומר השרשרת?", WOO, []))[0]).toEqual(["woocommerce.list_products", "שרשרת"]);
    // Read already this turn: no second store read.
    expect(q(autoLookups([{ kind: "unread_product" }] as any, "יש לזה פקק?", WOO, [{ tool: "woocommerce.list_products", outcome: "ok", args: { query: "סמובי" } } as any], "סמובי אליס"))).toEqual([["search_knowledge", "יש לזה פקק?"]]);
  });
  it("★ a derived measure loses its clause, the stated measure stays (Tehila triangle)", () => {
    const src = "מטפחת משולש 70x70 ס\"מ";
    const r = "המטפחת היא בגודל 70x70 ס\"מ, כל צלע של המשולש היא בערך 70 ס\"מ. רוצה לקבל קישור?";
    const d = derivedMeasure(r, src);
    expect(d).toEqual(["כל צלע של המשולש היא בערך 70 ס\"מ"]);
    expect(stripFactProblems(r, [{ kind: "derived_measure", claims: d }] as any)).toBe("המטפחת היא בגודל 70x70 ס\"מ. רוצה לקבל קישור?");
    const joined = "המטפחת בגודל 70x70 ס\"מ וכל צלע של המשולש בערך 99.5 ס\"מ. רוצה לקבל קישור?";
    expect(stripFactProblems(joined, [{ kind: "derived_measure", claims: derivedMeasure(joined, src) }] as any)).toBe("המטפחת בגודל 70x70 ס\"מ. רוצה לקבל קישור?");
  });
  it("★ a decimal point is no sentence end: the whole derived sentence goes, nothing half-cut", () => {
    const r = "כל צלע של המשולש היא בערך 99.5 ס\"מ. רוצה לקבל קישור?";
    expect(stripFactProblems(r, [{ kind: "derived_measure", claims: derivedMeasure(r, "70x70") }] as any)).toBe("רוצה לקבל קישור?");
    expect(stripFactProblems("התיק עולה ₪99.90 בלבד. מתאים לך?", [{ kind: "ungrounded_price", prices: ["99.90"] }] as any)).toBe("מתאים לך?");
  });
});

describe("3: peace of mind in a hold", () => {
  it("★ \"להיות שקטה\" is peace of mind; a yes to the bot's own urgency question is the same", () => {
    expect(wantsItSettled("כן מעדיפה להיות שקטה", "")).toBe(true);
    expect(wantsItSettled("אני רוצה ראש שקט", "")).toBe(true);
    expect(wantsItSettled("כן", "החיוב בבדיקה. זה דחוף עבורך?")).toBe(true);
    expect(wantsItSettled("כן", "רוצה שאשלח קישור?")).toBe(false);
    expect(wantsItSettled("שקט פה היום", "")).toBe(false);
    expect(wantsItSettled("אפשר להחזיר?", "זה דחוף?")).toBe(false);
  });
});

describe("4: what the reply says was added is added", () => {
  const item = [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }];
  it("★ digits as before; her words, a file and the note when asked; a thanks adds nothing", () => {
    expect(withNewDetails(item, "חויבתי פעמיים ואין הזמנה", "4155")?.text).toMatch(/customer gave: 4155/);
    expect(withNewDetails(item, "חויבתי פעמיים ואין הזמנה", "שילמתי בביט")).toBeNull();
    expect(withNewDetails(item, "חויבתי פעמיים ואין הזמנה", "שילמתי בביט", { words: true })?.text).toMatch(/customer added: "שילמתי בביט"/);
    expect(withNewDetails(item, "חויבתי פעמיים ואין הזמנה", "תודה רבה", { words: true })).toBeNull();
    const one = withNewDetails(item, "חויבתי פעמיים ואין הזמנה", "[image]", { attachment: true })!;
    expect(one.text).toMatch(/customer sent 1 attachment\)/);
    expect(withNewDetails(one.pending, "חויבתי פעמיים ואין הזמנה", "[image]", { attachment: true })!.text).toMatch(/customer sent 2 attachments\)$/);
    expect(withNewDetails(item, "חויבתי פעמיים ואין הזמנה", "כן", { note: "the customer says it is urgent" })?.text).toMatch(/\(the customer says it is urgent\)$/);
    expect(withNewDetails(item, "משהו אחר לגמרי בנושא משלוח לאילת", "4155")).toBeNull();
  });
});

describe("5: the smaller ones", () => {
  it("★ a: one team pass, \"העברנו\" and \"הצוות יחזור\" included; \"we checked\" with nothing looked up goes", () => {
    const r = "העברנו את זה לצוות, והתשובה תגיע כאן בצ'אט. הצוות יחזור אלייך בהקדם.";
    expect(oneTeamPass(r)).toBe("העברנו את זה לצוות, והתשובה תגיע כאן בצ'אט.");
    expect(withoutCheckedClaims("ביררנו, ואפשר לשלם בביט בקופה.")).toBe("אפשר לשלם בביט בקופה.");
    expect(withoutCheckedClaims("בדקנו את זה.")).toBe("");
    expect(withoutCheckedClaims("אפשר לשלם בביט בקופה.")).toBe("אפשר לשלם בביט בקופה.");
  });
  it("★ d: \"I'll look myself\" is recognised", () => {
    for (const s of ["אני אחפש לבד", "אסתכל באתר", "I'll look myself", "אסתדר לבד"]) expect(selfSearch(s), s).toBe(true);
    for (const s of ["אני מחפשת משטח", "תחפשו לי בבקשה"]) expect(selfSearch(s), s).toBe(false);
  });
  it("★ b: the first draft's closing question when the rewrite dropped it; never one asked before, a link or a team line", () => {
    const orig = { reply: "כן, אפשר להזמין באתר. איזה מכשיר מחפשים עבורו משטח?" };
    expect(withClosingQuestion({ reply: "כן, אפשר להזמין באתר." }, orig, []).reply).toBe("כן, אפשר להזמין באתר. איזה מכשיר מחפשים עבורו משטח?");
    expect(withClosingQuestion({ reply: "כן, אפשר להזמין באתר." }, orig, ["איזה מכשיר מחפשים עבורו משטח?"]).reply).toBe("כן, אפשר להזמין באתר.");
    expect(withClosingQuestion({ reply: "כן. לאיזה מכשיר?" }, orig, []).reply).toBe("כן. לאיזה מכשיר?");
    expect(withClosingQuestion({ reply: "כן." }, { reply: "כן. רוצה שאעביר את זה לצוות?" }, []).reply).toBe("כן.");
    expect(withClosingQuestion({ reply: "כן." }, null, []).reply).toBe("כן.");
  });
  it("★ e: a link the bot itself sent is grounded for a later ask", () => {
    const earlier = "לפני השימוש כדאי להניח את הטוש עם הפקק כלפי מטה. יש גם סרטון הדרכה: https://youtu.be/MypUj_xxA24";
    expect(howToLink(earlier, ["אשמח לסרטון הדרכה\nאיך משתמשים בטוש הגבות?"])).toBe("https://youtu.be/MypUj_xxA24");
  });
  it("★ f: a size line names its tray, only when exactly one product has that size", () => {
    const c = [{ title: "סמובי גפן 40x50" }, { title: "סמובי אליס", details: "מידות: 45x55 ס\"מ" }, { title: "סמובי רון 30x40" }, { title: "סמובי דור 30x40" }];
    expect(nameSizeLines("- 40x50 ס\"מ\n- 55x45 ס\"מ\n- 30x40 ס\"מ", c)).toBe("- סמובי גפן 40x50: 40x50 ס\"מ\n- סמובי אליס: 55x45 ס\"מ\n- 30x40 ס\"מ");
    expect(nameSizeLines("סמובי גפן במידה 40x50 ס\"מ", c)).toBe("סמובי גפן במידה 40x50 ס\"מ");
  });
  it("★ g: \"יש כמה צבעים\" names them from the product's own data, never invents", () => {
    const c = [{ title: "מטפחת משי", details: "צבע: שחור, לבן, בורדו | חומר: משי" }];
    expect(colourList("המטפחת משי מגיעה בכמה צבעים.", c, "he")).toBe("המטפחת משי מגיעה בכמה צבעים. הצבעים: שחור, לבן, בורדו.");
    expect(colourList("יש כמה צבעים, שחור ולבן למשל.", c, "he")).toBe("יש כמה צבעים, שחור ולבן למשל.");
    expect(colourList("יש כמה צבעים.", [{ title: "x", details: "חומר: משי" }], "he")).toBe("יש כמה צבעים.");
    expect(colourList("יש כמה צבעים.", [...c, { title: "מטפחת כותנה", details: "צבע: כחול, ירוק" }], "he")).toBe("יש כמה צבעים.");
  });
});

describe("the replay printout shows what was cut", () => {
  it("★ cut count, rewrite cut, fallback kinds, the bot's cut words and the new markers", () => {
    expect(cutLine({ cutSentences: 1, rewriteCut: "budget", fallbackKinds: ["derived_measure"], cutText: ["כל צלע בערך 70 ס\"מ"], closingQuestionKept: true })).toBe(' | cutSentences=1 | rewriteCut=budget | fallback=derived_measure | cut: "כל צלע בערך 70 ס\\"מ" | closingQuestionKept');
    expect(cutLine({})).toBe("");
  });
});

describe("dev live round on 9480dfb2", () => {
  const hoodies = [{ title: "Heavyweight Hoodie (Black)" }, { title: "Zip Hoodie (Charcoal)" }, { title: "Pullover Hoodie" }];
  it("★ 1: a product named without its exact title is in focus: the model's intent or a distinctive word names it", () => {
    expect(referredCandidates(hoodies, "כן, יש קפוצ'ון שחור בגזרה כבדה.", "בדיקת צבעי Heavyweight Hoodie")).toEqual([0]);
    expect(referredCandidates(hoodies, "The Heavyweight one comes in black.", "")).toEqual([0]);
    // "Hoodie" is in every title: no product of its own.
    expect(referredCandidates(hoodies, "כן, יש לנו Hoodie.", "")).toEqual([]);
    expect(referredCandidates([{ title: "סמובי גפן" }], "כן, יש לנו משטח כזה במלאי.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "סמובי גפן" }], "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "")).toEqual([]);
  });
  it("★ 1 (verify): a colour or size word in a title is never a distinctive word; the variant part never counts", () => {
    // The reply speaks of the Zip in black: never the Heavyweight Hoodie (Black).
    expect(referredCandidates(hoodies, "יש לנו את ה-Zip Hoodie גם ב-Black.", "")).toEqual([1]);
    expect(referredCandidates(hoodies, "We have a black one too.", "")).toEqual([]);
    expect(referredCandidates([{ title: "Black Tee" }, { title: "Black Hoodie" }], "The black is popular.", "")).toEqual([]);
    // A colour word in the title itself (not the variant part) is still no distinctive word.
    expect(referredCandidates([{ title: "Black Runner Tee" }, { title: "Grey Classic Tee" }], "Our hoodie comes in black.", "")).toEqual([]);
    // The variant part never counts, whatever its word.
    expect(referredCandidates([{ title: "Heavyweight Hoodie (Organic)" }, { title: "Zip Hoodie (Recycled)" }], "The organic fabric is soft.", "")).toEqual([]);
  });
  it("★ 1 (verify): several products, none named by the intent and none shown: no focus, never the first of the list", () => {
    expect(focusTitle(hoodies.map((h) => h.title), "בירור צבעים", null)).toBeNull();
    expect(focusTitle(hoodies.map((h) => h.title), null, null)).toBeNull();
    expect(autoLookups([{ kind: "unread_product" }] as any, "מאיזה בד הוא עשוי?", ["woocommerce.list_products"], [], focusTitle(hoodies.map((h) => h.title), null, null))).toEqual([]);
  });
  it("★ 1: the focus for the engine's own lookup: the last lookup's product the intent names, else the last shown, else the only one", () => {
    const titles = hoodies.map((h) => h.title);
    expect(focusTitle(titles, "בירור הרכב הבד של Heavyweight Hoodie", null)).toBe("Heavyweight Hoodie (Black)");
    expect(focusTitle(titles, "בירור בד", "Pullover Hoodie")).toBe("Pullover Hoodie");
    expect(focusTitle(["Pullover Hoodie"], null, null)).toBe("Pullover Hoodie");
    expect(focusTitle(titles, null, null)).toBeNull();
    expect(q(autoLookups([{ kind: "unread_product" }] as any, "מאיזה בד הוא עשוי?", WOO, [], focusTitle(titles, "בירור הרכב הבד של Heavyweight Hoodie", null)))[0]).toEqual(["woocommerce.list_products", "Heavyweight Hoodie (Black)"]);
  });
  it("★ 1: \"no details\" and \"not checked\" on a colour ask with nothing read is an unread product", () => {
    expect(unreadProduct("הוצגו 3 צבעים לקפוצ'ון. שמות הצבעים והמלאי לא נבדקו, אז אין לי פירוט שלהם כרגע.", "יש כמה צבעים?", [], WOO, false)).toBe(true);
  });
  it("★ 2: a general \"can I order?\" needs no store search; a named product does", () => {
    expect(purchaseWithoutSearch("אפשר להזמין?", [], WOO)).toBe(false);
    expect(purchaseWithoutSearch("can I order?", [], ["shopify.search_products"])).toBe(false);
    expect(purchaseWithoutSearch("אפשר להזמין את משטח גפן?", [], WOO)).toBe(true);
  });
  it("★ 2: the gate counts no leak when the business's own knowledge says it", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    const base = { claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "אפשר להזמין?", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false } as any;
    const r = "אפשר להזמין באתר. זו סביבת בדיקות, וההזמנות לא מסופקות.";
    const codes = (o: any) => gate3({ ...base, reply: r, ...o }).problems.flatMap((p: any) => (p.kind === "style" ? p.codes : []));
    expect(codes({ knowledge: "" })).toContain("simulation_leak");
    expect(codes({ knowledge: "האתר הוא סביבת בדיקות: הזמנות לא מסופקות ולא מחויבות." })).not.toContain("simulation_leak");
  });
  it("★ 2: a test named in the business's own texts is no leak", () => {
    const r = "אפשר להזמין באתר. זו סביבת בדיקות, וההזמנות לא מסופקות.";
    expect(simulationLeak(r, "")).toBe(true);
    expect(simulationLeak(r, "האתר הוא סביבת בדיקות: הזמנות לא מסופקות ולא מחויבות.")).toBe(false);
  });
  it("★ leftovers: \"או\" never reaches the store; a 4-letter word with ה loses it on a substring search only", () => {
    expect(storeQueryOf("יש קרם או סרום לפנים?")).toBe("קרם סרום לפנים");
    expect(storeQueryOf("יש לכם את הקרם?", { substring: true })).toBe("קרם");
    expect(storeQueryOf("יש לכם את הקרם?")).toBe("הקרם");
  });
});

describe("the internal audit row carries the cut fields", () => {
  it("★ the bot's own cut words and markers only; nothing when nothing was cut", () => {
    expect(cutFields({ cutSentences: 2, rewriteCut: "budget", fallbackKinds: ["thin_or_empty"], cutText: ["a", "b", "c", "d", "e"], closingQuestionKept: true, checkedClaimCut: true, incomingMessage: "her words" })).toEqual({ cutSentences: 2, rewriteCut: "budget", fallbackKinds: ["thin_or_empty"], cutText: ["a", "b", "c", "d"], markers: ["closingQuestionKept", "checkedClaimCut"] });
    expect(cutFields({})).toBeUndefined();
  });
});

describe("b77ec0d1 verify: the focus rules", () => {
  const W = ["woocommerce.list_products"];
  const smoovee = [{ title: "גפן למכונות קפה" }, { title: "אריאל למכונות קפה" }, { title: "מלאני" }];
  it("★ 1: attribute and question words alone are no product: no store search without a subject", () => {
    for (const s of ["יש כמה צבעים?", "באילו מידות?", "מה המידות שלו?", "מאיזה בד הוא עשוי?"]) {
      expect(storeQueryOf(s), s).toBeNull();
      expect(autoLookups([{ kind: "unread_product" }] as any, s, W, [], null), s).toEqual([]);
    }
    // A product word with the attribute keeps the product only.
    expect(storeQueryOf("הקרם הזה מתאים לעור יבש? זה חשוב לי")).toBe("הקרם לעור יבש");
    expect(q(autoLookups([{ kind: "unread_product" }] as any, "הקרם הזה מתאים לעור יבש? זה חשוב לי", W, [], null))[0]).toEqual(["woocommerce.list_products", "קרם לעור יבש"]);
    expect(storeQueryOf("יש לכם מטפחת בצבע כחול?")).toBe("מטפחת כחול");
    // With a subject the product in focus is read.
    expect(q(autoLookups([{ kind: "unread_product" }] as any, "יש כמה צבעים?", W, [], "Heavyweight Hoodie (Black)"))[0]).toEqual(["woocommerce.list_products", "Heavyweight Hoodie (Black)"]);
  });
  it("★ 2: a 3-letter name unique to one title is distinctive, with up to two Hebrew prefix letters", () => {
    expect(referredCandidates(smoovee, "למכונה שלך מתאים משטח גפן.", "")).toEqual([0]);
    expect(referredCandidates(smoovee, "המשטח של מלאני מתאים.", "")).toEqual([2]);
    // The companion word carries a prefix letter in the reply ("למכונה" for "מכונות").
    expect(referredCandidates([{ title: "גפן מכונות קפה" }, { title: "אריאל מכונות קפה" }], "למכונה שלך מתאים גפן.", "")).toEqual([0]);
    // Joined by ו to another found name, a short name counts (b369e939 review, item 3).
    expect(referredCandidates(smoovee, "בגפן ובאריאל יש ידית.", "")).toEqual([0, 1]);
    expect(referredCandidates([{ title: "אסף לנינג'ה קריספי" }, { title: "גפן למכונות קפה" }], "אסף מתאים לנינג'ה.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "אסף למיקסר" }, { title: "גפן למכונות קפה" }], "וגם אסף מתאים.", "")).toEqual([]);
    expect(referredCandidates([{ title: "Zip Hoodie" }, { title: "Cropped Hoodie" }, { title: "Heavyweight Hoodie" }], "יש לנו zip וגם cropped", "")).toEqual([1]);
  });
  it("★ 3: a word two found titles share never counts; the same base marks both", () => {
    expect(referredCandidates(smoovee, "יש לנו כמה משטחים למכונות קפה.", "")).toEqual([]);
    expect(referredCandidates([{ title: "Runner Tee - Black" }, { title: "Runner Tee - White" }], "The runner tee is our best seller.", "")).toEqual([0, 1]);
  });
  it("★ 4: an intent that names two products is no single focus", () => {
    expect(focusTitle(["Cropped Hoodie", "Zip Hoodie", "Heavyweight Hoodie"], "השוואה בין Zip Hoodie ל-Cropped Hoodie", null)).toBeNull();
    expect(focusTitle(["Cropped Hoodie", "Zip Hoodie", "Heavyweight Hoodie"], "בירור Zip Hoodie", null)).toBe("Zip Hoodie");
    // Two named now outrank an older shown product: still no focus.
    expect(focusTitle(["Cropped Hoodie", "Zip Hoodie", "Heavyweight Hoodie"], "השוואה בין Zip Hoodie ל-Cropped Hoodie", "Heavyweight Hoodie")).toBeNull();
  });
});

describe("13afc633 verify: attribute words that are the product; ordinary speech", () => {
  it("★ must-fix: a bare attribute word beside another content word is the product and stays", () => {
    expect(storeQueryOf("יש לכם משקל מטבח?")).toBe("משקל מטבח");
    expect(storeQueryOf("יש לכם צבע לקיר בלבן?")).toBe("צבע לקיר לבן");
    expect(storeQueryOf("אני מחפשת בד כותנה לתפירה")).toBe("בד כותנה לתפירה");
    expect(storeQueryOf("יש לכם סרט מידה?")).toBe("סרט מידה");
    expect(storeQueryOf("יש לכם חומר ניקוי לנירוסטה?")).toBe("חומר ניקוי לנירוסטה");
  });
  it("★ must-fix: the attribute use still comes out (a ה or ב form, or nothing beside it)", () => {
    expect(storeQueryOf("יש לכם מטפחת בצבע כחול?")).toBe("מטפחת כחול");
    expect(storeQueryOf("מה האורך של השרשרת?")).toBe("השרשרת");
    expect(storeQueryOf("מה האורך של השרשרת?", { substring: true })).toBe("שרשרת");
    for (const s of ["יש כמה צבעים?", "באילו מידות?", "מה המידות שלו?", "מאיזה בד הוא עשוי?", "what material is it?"]) expect(storeQueryOf(s), s).toBeNull();
  });
  it("★ should-fix: a short everyday word or a person's name never marks a product", () => {
    expect(referredCandidates([{ title: "קרם יום לעור יבש" }, { title: "קרם לילה לעור יבש" }], "תוך יום עסקים נחזור אליך.", "")).toEqual([]);
    const smoovee = [{ title: "גפן למכונות קפה" }, { title: "אריאל למכונות קפה" }, { title: "מלאני" }];
    expect(referredCandidates(smoovee, "שלום אריאל, נשמח לעזור", "")).toEqual([]);
    expect(referredCandidates(smoovee, "נשמח לעזור, אריאל.", "", ["אריאל"])).toEqual([]);
    // Still a product with a word of its own title beside it.
    expect(referredCandidates([{ title: "קרם יום לעור יבש" }, { title: "קרם לילה לעור יבש" }], "קרם יום מתאים לעור יבש.", "")).toEqual([0]);
  });
});

describe("658a3e2e verify: title matches", () => {
  const tehila = [{ title: "בובון שטוח" }, { title: "בובון חצי שטוח" }, { title: "מטפחת ג'יני כחולה" }];
  const cosm = [{ title: "סרום ויטמין C" }, { title: "סרום לילה" }, { title: "קרם לחות" }];
  const tees = [{ title: "Classic Tee" }, { title: "Classic Tee Long Sleeve" }, { title: "Zip Hoodie" }];
  it("★ gap 1: every word of a title said (prefix letters allowed) marks it", () => {
    expect(referredCandidates(tehila, "לקשירה נמוכה מתאים הבובון השטוח.", "")).toEqual([0]);
    expect(referredCandidates(tehila, "הבובון החצי שטוח מתאים לך.", "")).toEqual([1]);
    expect(referredCandidates(cosm, "קרם הלחות שלנו במבצע.", "")).toEqual([2]);
  });
  it("★ gap 2: a title inside a longer one that is said: only the longer", () => {
    expect(referredCandidates(tees, "the Classic Tee Long Sleeve is in stock", "")).toEqual([1]);
    expect(referredCandidates(tees, "the long sleeve classic tee is in stock", "")).toEqual([1]);
    expect(referredCandidates(tees, "the classic tee is in stock", "")).toEqual([0]);
  });
  it("★ gaps 1-2: stays empty", () => {
    expect(referredCandidates(tehila, "יש לנו שני בובונים.", "")).toEqual([]);
    expect(referredCandidates(tees, "we have two tees", "")).toEqual([]);
    expect(referredCandidates(cosm, "הקרם במבצע.", "")).toEqual([]);
    expect(referredCandidates(cosm, "לילה טוב! נחזור אליך מחר.", "")).toEqual([]);
  });
  it("★ gap 3: a name with an apostrophe is one word; a colour of the same title is its companion", () => {
    expect(referredCandidates([{ title: "מטפחת ג'יני כחולה" }, { title: "מטפחת אלכסה" }], "יש את ג'יני בגווני כחול.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "מטפחת ג׳יני כחולה" }, { title: "מטפחת אלכסה" }], "מטפחת ג'יני במלאי.", "")).toEqual([0]);
    // The name alone, written with another apostrophe: one 5-character word, no companion needed.
    expect(referredCandidates([{ title: "מטפחת ג׳יני כחולה" }, { title: "מטפחת אלכסה" }], "יש את ג'יני.", "")).toEqual([0]);
    // A short name whose only companion is its title's colour.
    expect(referredCandidates([{ title: "טוש ליה שחור" }, { title: "טוש מיה" }], "ליה בשחור במלאי.", "")).toEqual([0]);
  });
  it("★ nits: a weight verb and a size number are no product words", () => {
    expect(storeQueryOf("כמה זה שוקל?")).toBeNull();
    expect(storeQueryOf("יש מידה 38 בנעל הלבנה?")).toBe("נעל הלבנה");
  });
});

describe("prod replay of 9480dfb2, Tehila: the cleanup", () => {
  const titles = ["נוטינג", "סוהו", "בובון שטוח", "ברוקלין"];
  const reply = "למטפחת יומיומית קלילה שמתאימה גם לכיסוי מלא וגם לחלקי, כדאי לבחור בנוטינג, מבד דמוי פשתן רך ונשפך. אם מתאים לך מראה שיפון צרוב, ברוקלין היא אפשרות קלילה ונשפכת גם כן.";
  it("★ a use is no device fit: the recommendation sentence is never cut as one", async () => {
    expect(ungroundedPositiveFit(reply, "מטפחה", titles, titles.join("\n"), "")).toEqual([]);
    const { gate3 } = await import("../services/reply-engine/gates");
    const r = gate3({ reply, claims: [], cards: ["PRODUCT_1", "PRODUCT_4"], candidateCount: 4, candidateTitles: titles, candidates: titles.map((title) => ({ title })), tools: [{ tool: "woocommerce.list_products", outcome: "ok", decision: "allow", args: { query: "מטפחת" } }], grounding: titles.join("\n"), locale: "he", incomingMessage: "מטפחה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: ["woocommerce.list_products"], shopFloor: false, handedOff: false, approvalPending: false, cardsChannel: true } as any);
    expect(r.problems.map((p: any) => p.kind)).not.toContain("ungrounded_positive_fit");
    // A device fit nothing backs is still a claim.
    expect(ungroundedPositiveFit("סמובי אליס מתאים לנינג'ה קריספי.", "יש לכם משטח?", ["סמובי אליס", "סמובי גפן"], "סמובי אליס 40x50", "")).toHaveLength(1);
  });
  it("★ \"גם כן\" left after a cut goes", () => {
    expect(dropOrphanAlso("אם מתאים לך מראה שיפון צרוב, ברוקלין היא אפשרות קלילה ונשפכת גם כן.")).toBe("אם מתאים לך מראה שיפון צרוב, ברוקלין היא אפשרות קלילה ונשפכת.");
    expect(dropOrphanAlso("The Zip is soft as well.")).toBe("The Zip is soft.");
    expect(dropOrphanAlso("גם כן יש לנו משלוח.")).toBe("גם כן יש לנו משלוח.");
  });
  it("★ the count of the offer is the cards' count", () => {
    expect(fixCardCount("בטח 😊 הנה 4 הצעות: מטפחת קלילה ורכה, או עגילי וינטג' קטנים.", 2)).toBe("בטח 😊 הנה 2 הצעות: מטפחת קלילה ורכה, או עגילי וינטג' קטנים.");
    expect(fixCardCount("הנה שלוש אפשרויות שמתאימות.", 3)).toBe("הנה שלוש אפשרויות שמתאימות.");
    expect(fixCardCount("here are four options", 2)).toBe("here are 2 options");
    expect(fixCardCount("הנה 4 הצעות", 0)).toBe("הנה 4 הצעות");
    expect(fixCardCount("הנה 4 הצעות", 1)).toBe("הנה 4 הצעות");
  });
  it("★ the audit row and the replay line say which check cut", () => {
    expect(cutFields({ cutSentences: 1, cutWhy: ["ungrounded_positive_fit"], cutText: ["x"] })).toMatchObject({ cutWhy: ["ungrounded_positive_fit"] });
    expect(cutLine({ cutSentences: 1, cutWhy: ["ungrounded_positive_fit"] })).toContain("cutWhy=ungrounded_positive_fit");
  });
});

describe("f0986322 verify: near, never anywhere", () => {
  const cosm = [{ title: "סרום ויטמין C" }, { title: "סרום לילה" }, { title: "קרם לחות" }, { title: "קרם יום" }];
  it("★ two everyday words far apart mark nothing", () => {
    expect(referredCandidates(cosm, "תוך יום עסקים נשלח את הקרם.", "")).toEqual([]);
    expect(referredCandidates(cosm, "הקרם שומר על לחות העור לאורך היום.", "")).toEqual([]);
  });
  it("★ still marked: near words, one filler, the companion within three words", () => {
    expect(referredCandidates(cosm, "קרם הלחות שלנו במבצע.", "")).toEqual([2]);
    expect(referredCandidates([{ title: "בובון שטוח" }, { title: "בובון חצי שטוח" }, { title: "מטפחת ג'יני כחולה" }], "הבובון שלנו שטוח לגמרי ונוח.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "Classic Tee" }, { title: "Classic Tee Long Sleeve" }, { title: "Zip Hoodie" }], "the long sleeve classic tee is in stock", "")).toEqual([1]);
    expect(referredCandidates([{ title: "אסף לנינג'ה קריספי" }, { title: "גפן למכונות קפה" }], "אסף מתאים לנינג'ה.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "גפן למכונות קפה" }, { title: "אריאל למכונות קפה" }, { title: "מלאני" }], "למכונה שלך מתאים משטח גפן.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "מטפחת ג'יני כחולה" }, { title: "מטפחת אלכסה" }], "יש את ג'יני בגווני כחול.", "")).toEqual([0]);
    // Chosen: marked, the companion "סרום" is within three words of "לילה".
    expect(referredCandidates(cosm, "הסרום מתאים גם ללילה.", "")).toEqual([1]);
  });
  it("★ nit: a size and its value are no title text; the ב comes off the word after them", () => {
    expect(storeQueryOf("יש מידה 38 בנעל הלבנה?", { substring: true })).toBe("נעל לבנה");
    expect(storeQueryOf("יש לכם מידה 42 בשמלה השחורה?", { substring: true })).toBe("שמלה שחורה");
    expect(storeQueryOf("יש מידה 38?")).toBeNull();
  });
});

describe("rating of the 9480dfb2 prod replay", () => {
  it("★ blocker 1: a media file is never the link; a video ask takes a video link only", () => {
    const kb = "Miss eyebrows טוש גבות: https://chanivainberger.co.il/wp-content/uploads/2025/12/Miss-eyebrows.webp";
    expect(howToLink(kb, ["אשמח לסרטון הדרכה לטוש הגבות"], true)).toBeNull();
    expect(howToLink(kb, ["קישור לטוש הגבות"], false)).toBeNull();
    const page = "Miss eyebrows טוש גבות: https://chanivainberger.co.il/product/miss-eyebrows";
    expect(howToLink(page, ["אשמח לסרטון הדרכה לטוש הגבות"], true)).toBeNull();
    expect(howToLink(page, ["קישור לטוש הגבות"], false)).toBe("https://chanivainberger.co.il/product/miss-eyebrows");
    expect(howToLink(`${kb}\nסרטון הדרכה לטוש הגבות: https://youtu.be/MypUj_xxA24`, ["אשמח לסרטון הדרכה לטוש הגבות"], true)).toBe("https://youtu.be/MypUj_xxA24");
  });
  it("★ blocker 2: a fragment after a cut is no reply; a derived clause never leaves a connector", () => {
    expect(cutFragment("וכשמקפלים אותה מתקבל משולש.")).toBe(true);
    expect(cutFragment("אבל זה תלוי בדגם.")).toBe(true);
    expect(cutFragment("המטפחת בגודל 70x70 ס\"מ.")).toBe(false);
    // The stated measure stays when the derived clause comes after it; a connector left in front goes whole.
    const r = "המטפחת בגודל 70x70 ס\"מ, וכשמקפלים אותה מתקבל משולש בערך 99 ס\"מ.";
    expect(stripFactProblems(r, [{ kind: "derived_measure", claims: derivedMeasure(r, "70x70 ס\"מ") }] as any)).toBe("המטפחת בגודל 70x70 ס\"מ.");
    const r2 = "כל צלע בערך 99 ס\"מ, וכשמקפלים אותה מתקבל משולש.";
    expect(stripFactProblems(r2, [{ kind: "derived_measure", claims: ["כל צלע בערך 99 ס\"מ"] }] as any)).toBe("");
  });
  it("★ blocker 2: the plural reaches the whole sentence (\"כתבו ... לכם\")", () => {
    expect(neutralSecondPerson("כתבי איזה גוון עור יש לך.")).toBe("כתבו איזה גוון עור יש לכם.");
    expect(neutralSecondPerson("יש לך משלוח חינם.")).toBe("יש לך משלוח חינם.");
  });
  it("★ near-blocker 3: a credit card is no product card; a rounded stated measure stays; a caveat is never an absence", async () => {
    expect(cardReferences("אפשר לשלם באתר בכרטיס אשראי ישראלי או ב-PayPal.", false)).toEqual([]);
    expect(cardReferences("רואים את זה בכרטיס.", false)).toHaveLength(1);
    expect(derivedMeasure("המטפחת במידה 70 ס\"מ על כ-2 מטר.", "סולו כחולה 70x200 ס\"מ")).toEqual([]);
    expect(derivedMeasure("כל צלע בערך 99 ס\"מ.", "70x70 ס\"מ")).toHaveLength(1);
    const { gate3 } = await import("../services/reply-engine/gates");
    const base = { claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "אני רוצה גוון חום למתחת לעיניים", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false } as any;
    const caveat = "יש לנו טוש בגוון חום. אין לנו אישור שהוא מתאים לשימוש מתחת לעיניים.";
    const withTool = { ...base, candidateCount: 1, candidateTitles: ["טוש גבות Miss eyebrows"], tools: [{ tool: "woocommerce.list_products", outcome: "ok", decision: "allow", args: { query: "טוש" } }], grounding: "טוש גבות Miss eyebrows", toolsOffered: ["woocommerce.list_products", "search_knowledge"] };
    const v = gate3({ ...withTool, reply: caveat });
    expect(v.problems.map((p: any) => p.kind)).not.toContain("ungrounded_absence");
    // Whatever else flags it, the cleanup keeps the caveat.
    expect(stripFactProblems(caveat, v.problems)).toContain("אין לנו אישור שהוא מתאים לשימוש מתחת לעיניים.");
    // A real absence stays a claim.
    expect(gate3({ ...withTool, reply: "יש טוש חום, אבל אין לנו מוצר שמאושר לשימוש מתחת לעיניים." }).problems.map((p: any) => p.kind)).toContain("ungrounded_absence");
  });
});

describe("b369e939 next-round items", () => {
  it("★ a size letter or adjective goes with the size word; the ב comes off an apostrophe word after them", () => {
    expect(storeQueryOf("יש מידה L בקפוצ'ון?")).toBe("קפוצ'ון");
    expect(storeQueryOf("יש מידה L בקפוצ'ון?", { substring: true })).toBe("קפוצ'ון");
    expect(storeQueryOf("יש לכם מידה גדולה בחולצה?")).toBe("חולצה");
    expect(storeQueryOf("יש לכם סרט מידה?")).toBe("סרט מידה");
    expect(storeQueryOf("יש מידה 38 בנעל הלבנה?", { substring: true })).toBe("נעל לבנה");
  });
  it("★ a short name by its place: after a choice word, or joined by ו to another found name", () => {
    const smoovee = [{ title: "גפן למכונות קפה" }, { title: "אריאל למכונות קפה" }, { title: "מלאני" }];
    expect(referredCandidates(smoovee, "למכונת קפה קטנה כדאי לבחור בגפן.", "")).toEqual([0]);
    expect(referredCandidates(smoovee, "בגפן ובאריאל יש ידית.", "")).toEqual([0, 1]);
    expect(referredCandidates([{ title: "אסף לנינג'ה קריספי" }, { title: "גפן למכונות קפה" }], "אנחנו ממליצים על אסף.", "")).toEqual([0]);
    // An everyday name by place marks nothing; it marks only through the all-words and companion rules.
    expect(referredCandidates([{ title: "קרם יום" }, { title: "קרם לילה" }], "כדאי לבחור ביום אחר למשלוח.", "")).toEqual([]);
    expect(referredCandidates([{ title: "קרם יום" }, { title: "קרם לילה" }], "כדאי לבחור בקרם יום.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "Classic Tee Black" }, { title: "Zip Hoodie" }], "we recommend black for winter.", "")).toEqual([]);
    // A time word is never the other name a short name is joined to ("בגפן ויום").
    expect(referredCandidates([{ title: "גפן למכונות קפה" }, { title: "קרם יום" }], "בגפן ויום אחד נסדר את זה.", "")).toEqual([]);
    // Ordinary speech still marks nothing.
    expect(referredCandidates([{ title: "סרום ויטמין C" }, { title: "סרום לילה" }, { title: "קרם לחות" }, { title: "קרם יום" }], "תוך יום עסקים נשלח את הקרם.", "")).toEqual([]);
  });
  it("★ an instructions PDF answers a plain how-to ask, never a video ask; an image never", () => {
    const kb = "הוראות שימוש במסקרה: https://shop.example/wp-content/uploads/2025/10/guide.pdf\nתמונת מסקרה: https://shop.example/wp-content/uploads/2025/10/mascara.jpg";
    expect(howToLink(kb, ["איך משתמשים במסקרה? יש הוראות?"], false)).toBe("https://shop.example/wp-content/uploads/2025/10/guide.pdf");
    expect(howToLink(kb, ["אשמח לסרטון הדרכה למסקרה"], true)).toBeNull();
  });
});

describe("rating of the b369e939 prod replay", () => {
  const base = { claims: [], cards: [], candidateCount: 1, candidateTitles: ["טוש גבות חום"], tools: [{ tool: "woocommerce.list_products", outcome: "ok", decision: "allow", args: { query: "טוש" } }], grounding: "טוש גבות חום", locale: "he", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: ["woocommerce.list_products", "search_knowledge"], shopFloor: false, handedOff: false, approvalPending: false } as any;
  it("★ blocker 1 (NE'A \"טוש אני רוצה\"): \"ולא מצוין שהוא מתאים למתחת לעיניים\" is a caveat: no absence, no fit claim, never cut", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    const reply = "הטוש החום שמופיע כאן מיועד למילוי גבות, ולא מצוין שהוא מתאים למתחת לעיניים.";
    // On the cards channel the product is shown ("שמופיע כאן" points at its card).
    const v = gate3({ ...base, cards: ["PRODUCT_1"], cardsChannel: true, reply, incomingMessage: "טוש אני רוצה" });
    const kinds = v.problems.map((p: any) => p.kind);
    expect(kinds).not.toContain("ungrounded_absence");
    expect(kinds).not.toContain("ungrounded_positive_fit");
    expect(stripFactProblems(reply, v.problems)).toContain("ולא מצוין שהוא מתאים למתחת לעיניים");
    expect(ungroundedPositiveFit("הטוש החום לא מתאים למתחת לעיניים לפי היצרן.", "טוש", ["טוש גבות חום"], "", "")).toEqual([]);
  });
  it("★ blocker 1 (NE'A \"איך אדע מה התת גוון\"): the veins' colours in an explanation are no product attribute", () => {
    expect(ungroundedAttribute("בודקים את צבע הוורידים בפרק כף היד: כחול או סגול מעיד על תת גוון קר, ירוק על חם.", "", "איך אדע מה התת גוון")).toEqual([]);
    // A product's colour the data does not give is still a claim.
    expect(ungroundedAttribute("הטוש מגיע גם בכחול.", "טוש גבות חום", "יש לכם טוש?")).toHaveLength(1);
  });
  it("★ blocker 2 (run B, five appliances): a size or a price opening the remnant is a fragment; a decimal is never a sentence end", () => {
    expect(cutFragment("15.4×23 ס\"מ, ב-₪69. למיקסר צריך להוסיף מעצור.")).toBe(true);
    expect(cutFragment("ב-₪69 בלבד.")).toBe(true);
    expect(cutFragment("סמובי אליס 15.4×23 ס\"מ מתאים למיקסר.")).toBe(false);
    const r = "למיקסר מתאים סמובי אליס 15.4×23 ס\"מ, ב-₪69. לטוסטר מתאים גפן.";
    expect(stripFactProblems(r, [{ kind: "echoed_size", claims: ["למיקסר מתאים סמובי אליס 15.4×23 ס\"מ, ב-₪69."] }] as any)).toBe("לטוסטר מתאים גפן.");
  });
  it("★ near: a cancelled order said as cancelled is labelled, a date in it splits nothing", () => {
    expect(unlabelledInactiveOrders("הזמנה 97858 מסומנת כמבוטלת, והבירור עדיין בטיפול הצוות.", [], ["97858"])).toEqual([]);
    expect(unlabelledInactiveOrders("נמצאה הזמנה 97858 מתאריך 15.11, והיא מסומנת כמבוטלת.", [], ["97858"])).toEqual([]);
    expect(unlabelledInactiveOrders("נמצאה הזמנה 97858 מתאריך 15.11.", [], ["97858"])).toHaveLength(1);
  });
  it("★ near: \"no restock date\" is honest, never an absence claim; \"יש חדש?\" searches no product", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    const kinds = gate3({ ...base, reply: "אין לנו כרגע תאריך לחידוש המלאי של הדגם השחור.", incomingMessage: "מתי יחזור למלאי השחור?" }).problems.map((p: any) => p.kind);
    expect(kinds).not.toContain("ungrounded_absence");
    expect(storeQueryOf("יש חדש?")).toBeNull();
    expect(storeQueryOf("יש עדכון?")).toBeNull();
    expect(storeQueryOf("יש לכם קולקציה חדשה של מטפחות?")).not.toBeNull();
  });
  it("★ near: slash forms and the product question in a store with no models", () => {
    expect(withoutSlashForms("אם תשלחו/י את רוחב ועומק הבסיס, נבדוק.")).toBe("אם תשלחו את רוחב ועומק הבסיס, נבדוק.");
    expect(withoutSlashForms("נכון/ת, קודם לא דייקנו.")).toBe("נכון, קודם לא דייקנו.");
    expect(withoutSlashForms("https://shop.example/a/ת")).toBe("https://shop.example/a/ת");
    expect(productQuestionLine("he")).not.toMatch(/דגם|מידה/);
  });
});

describe("48f3a261 verify", () => {
  const titles = ["סמובי אסף", "סמובי אליס"];
  const ask = "מה מתאים לנינג'ה קריספי?";
  it("★ must-fix 1: a set phrase across a comma never clears a device fit", () => {
    for (const r of ["אין בעיה, סמובי אסף מתאים לנינג'ה קריספי.", "לא רק זה, סמובי אסף גם מתאים לנינג'ה קריספי.", "אם לא מצאת, סמובי אסף מתאים לנינג'ה קריספי.", "ללא ספק סמובי אסף מתאים לנינג'ה קריספי.", "אין צורך למדוד, סמובי אסף מתאים לנינג'ה קריספי.", "לא לדאוג, סמובי אליס יתאים לנינג'ה קריספי."]) {
      expect(ungroundedPositiveFit(r, ask, titles, "", ""), r).toHaveLength(1);
    }
  });
  it("★ must-fix 1: a negation that governs the fit stays unflagged", () => {
    for (const r of ["הטוש החום שמופיע כאן מיועד למילוי גבות, ולא מצוין שהוא מתאים למתחת לעיניים.", "לא מצוין שסמובי אסף מתאים לנינג'ה קריספי.", "אין לנו אישור שסמובי אסף מתאים לנינג'ה קריספי.", "סמובי אסף לא מתאים לנינג'ה קריספי."]) {
      expect(ungroundedPositiveFit(r, ask, titles, "", ""), r).toEqual([]);
    }
  });
  it("★ must-fix 2: a colour said of a product is checked on an explanation ask too", () => {
    const ev = "מייקאפ Cover me גוונים: Sand, Beige. שמלת ערב צבעים: שחור, אדום";
    expect(ungroundedAttribute("המייקאפ מגיע גם בגוון כחול.", ev, "איך אדע מה התת גוון")).toHaveLength(1);
    expect(ungroundedAttribute("השמלה מגיעה גם בכחול ובירוק.", ev, "איך אדע איזה צבעים יש לשמלה?")).toHaveLength(1);
    expect(ungroundedAttribute("שמלת הערב מגיעה גם בירוק.", ev, "איך יודעים איזה צבע מתאים לי?")).toHaveLength(1);
    // A product named as the subject, with no "מגיע": still a claim.
    expect(ungroundedAttribute("המייקאפ בגוון כחול עמוק.", ev, "איך אדע מה התת גוון")).toHaveLength(1);
    expect(ungroundedAttribute("אפשר לבדוק את הוורידים בפרק כף היד: כחולים או סגולים מצביעים על תת-גוון קר, ירוקים על חם.", ev, "איך אדע מה התת גוון")).toEqual([]);
  });
  it("★ 3: a video word heads a video ask; one that qualifies a product does not", () => {
    expect(videoAsk("יש לכם מעמד לצילום סרטונים?")).toBe(false);
    expect(productAskNow("יש לכם מעמד לצילום סרטונים?")).toBe(true);
    for (const v of ["יש לכם סרטון הדרכה לכביסה?", "אשמח לסרטון הדרכה", "איפה הסרטון", "אשמח להסבר /סרטון", "do you have a video for it?"]) expect(videoAsk(v), v).toBe(true);
  });
  it("★ 4: a full sentence that opens with a size or a price is no fragment", () => {
    expect(cutFragment("20×30 ס\"מ היא המידה של אליס.")).toBe(false);
    expect(cutFragment("ב-₪69 אפשר לקבל את אסף.")).toBe(false);
    expect(cutFragment("15.4×23 ס\"מ, ב-₪69. למיקסר צריך להוסיף מעצור.")).toBe(true);
    expect(cutFragment("ב-₪69 בלבד.")).toBe(true);
  });
  it("★ 5: an adjective after the word makes it a common noun, never a name by place", () => {
    const cosm = [{ title: "קרם יום" }, { title: "סרום לילה" }, { title: "קרם לחות" }];
    expect(referredCandidates(cosm, "כדאי לבחור בלחות גבוהה.", "")).toEqual([]);
    const smoovee = [{ title: "גפן למכונות קפה" }, { title: "אריאל למכונות קפה" }, { title: "מלאני" }];
    expect(referredCandidates(smoovee, "כדאי לבחור בגפן.", "")).toEqual([0]);
    expect(referredCandidates(smoovee, "בגפן ובאריאל יש ידית.", "")).toEqual([0, 1]);
  });
  it("★ 6: \"no date yet\" holds only while no source gives a date", async () => {
    const x = "אין לנו כרגע תאריך לחידוש המלאי של הדגם השחור.";
    expect(caveatHolds(x, "")).toBe(true);
    expect(caveatHolds(x, "הדגם השחור יחזור למלאי ב-12.12")).toBe(false);
    expect(stripFactProblems(x, [{ kind: "ungrounded_absence", claims: [x] }] as any)).toBe("");
  });
});

describe("92486ac8 verify, with the inputs of a real turn", () => {
  const KB = "מייקאפ Cover me לכל סוגי העור, כיסוי בינוני. אפשר למרוח עם מברשת או ספוגית. מתאים לעור יבש. גוונים: Sand, Beige.\nטוש גבות Miss eyebrows למילוי גבות, עמיד במים. מומלץ לבדוק את הגוון על פרק כף היד לפני קנייה.";
  const g3 = async (reply: string, incoming: string) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, candidateTitles: [], tools: [], grounding: "", knowledge: KB, locale: "he", incomingMessage: incoming, isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: ["search_knowledge"], shopFloor: false, handedOff: false, approvalPending: false } as any).problems.map((p: any) => p.kind);
  };
  it("★ A: the vein explanation passes with the whole knowledge as evidence; product colours never do", async () => {
    expect(await g3("אפשר לבדוק את הוורידים בפרק כף היד: כחולים או סגולים מצביעים על תת-גוון קר, ירוקים על חם.", "איך אדע מה התת גוון")).not.toContain("ungrounded_attribute");
    for (const r of ["המייקאפ מגיע גם בגוון כחול.", "המייקאפ בגוון כחול עמוק.", "ל-Cover me יש גם גוון ורוד.", "Cover me קיים גם בחום כהה.", "Cover me בגוון ורוד עמוק.", "למייקאפ יש גם גוון ורוד."]) {
      expect(await g3(r, "איך אדע מה התת גוון"), r).toContain("ungrounded_attribute");
    }
    // A body or attribute word opening the sentence is no product, even when the evidence has it.
    expect(ungroundedAttribute("העור שלך בתת גוון חם אם הוורידים ירוקים.", "עור יבש זקוק ללחות.", "איך אדע מה התת גוון")).toEqual([]);
  });
  it("★ B: only a restock statement for the item the caveat names makes it false; numbers never", () => {
    const x = "אין לנו כרגע תאריך לחידוש המלאי של אליס שחור.";
    for (const src of ["סמובי אליס 20×30 ס\"מ במחיר 69.90 ש\"ח. אליס שחור אזל מהמלאי.", "שירות לקוחות 24/7. משלוח תוך 3-5 ימי עסקים.", "אריאל 15.4×23 ס\"מ. אליס שחור אזל.", "הזמנה 97858 מתאריך 15.11 בוטלה.", "גפן לבן יחזור למלאי ב-01.12. אליס שחור אזל."]) {
      expect(caveatHolds(x, src), src).toBe(true);
    }
    expect(caveatHolds(x, "אליס שחור יחזור למלאי ב-01.12.")).toBe(false);
  });
  it("★ C: a video ask in real phrasing; a video word that qualifies another noun is none", () => {
    for (const v of ["היי, אשמח לקבל סרטון הדרכה", "אפשר לקבל סרטון הדרכה לטוש?", "תוכלי לשלוח לי סרטון הדרכה?", "שלחי לי סרטון בבקשה", "יש לך אולי סרטון הדרכה?", "איך משתמשים בזה? יש סרטון?", "מחפשת סרטון הדרכה לטוש הגבות", "ראיתי שיש סרטון, אפשר קישור?", "is there a tutorial for the brow pen?", "יש לכם סרטון הדרכה לכביסה?", "איפה הסרטון", "אשמח להסבר /סרטון"]) {
      expect(videoAsk(v), v).toBe(true);
      expect(productAskNow(v), v).toBe(false);
    }
    for (const v of ["יש לכם מעמד לצילום סרטונים?", "מחפשת תאורה לסרטונים", "יש לכם חצובה לסרטוני טיקטוק?", "יש לכם מצלמת וידאו?", "אשמח להסבר על המוצר"]) expect(videoAsk(v), v).toBe(false);
  });
  it("★ D: the ש must open the clause that holds the fit verb; \"לא בטוח ש\" is a caveat", () => {
    const titles = ["סמובי אסף", "סמובי אליס"];
    for (const r of ["אין מידע על שינוי במידות, סמובי אסף מתאים לנינג'ה קריספי.", "אין לנו מידע שסותר את זה: סמובי אסף מתאים לנינג'ה קריספי.", "לא ידוע על שום בעיה וסמובי אסף מתאים לנינג'ה קריספי."]) {
      expect(ungroundedPositiveFit(r, "מה מתאים לנינג'ה קריספי?", titles, "", ""), r).toHaveLength(1);
    }
    expect(ungroundedPositiveFit("לא בטוח שסמובי אסף מתאים לנינג'ה קריספי.", "מה מתאים לנינג'ה קריספי?", titles, "", "")).toEqual([]);
    // A ו that opens a new clause ends the ש clause: the fit after it is a claim.
    expect(ungroundedPositiveFit("לא מצוין שהוא קטן וסמובי אסף מתאים לנינג'ה קריספי.", "מה מתאים לנינג'ה קריספי?", titles, "", "")).toHaveLength(1);
  });
  it("★ E: a definite adjective after a bare word marks the name; an indefinite one a common noun", () => {
    const smoovee = [{ title: "גפן למכונות קפה" }, { title: "אריאל למכונות קפה" }, { title: "מלאני" }];
    expect(referredCandidates(smoovee, "ממליצים על גפן הקטנה.", "")).toEqual([0]);
    expect(referredCandidates([{ title: "קרם יום" }, { title: "סרום לילה" }, { title: "קרם לחות" }], "כדאי לבחור בלחות גבוהה.", "")).toEqual([]);
    expect(referredCandidates([{ title: "מלאני גדולה" }, { title: "מלאני קטנה" }, { title: "גפן למכונות קפה" }], "כדאי לבחור במלאני גדולה.", "")).toEqual([0]);
  });
});

describe("rating of the d2f10620 prod replay: units", () => {
  it("★ B1e: a team line behind an emoji is the same pass: one team line", () => {
    const r = "בטח, אבדוק את זה והתשובה תגיע כאן בצ'אט 😊 העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.";
    expect((onePass(r).match(/תגיע כאן/g) ?? []).length).toBe(1);
    expect(onePass("יש לנו 😊 עוד משהו.")).toBe("יש לנו 😊 עוד משהו.");
  });
  it("★ queue 1: a colour in another clause than the product is never checked", () => {
    const titles = ["מייקאפ - Cover me by light foundation"];
    expect(ungroundedAttribute("כדי לבחור גוון מייקאפ אפשר לבדוק את הוורידים: כחולים או סגולים מצביעים על תת-גוון קר, ירוקים על חם.", "מייקאפ Cover me גוונים: Sand, Beige", "איך אדע מה התת גוון", titles)).toEqual([]);
    expect(ungroundedAttribute("המייקאפ בגוון כחול עמוק.", "מייקאפ Cover me גוונים: Sand, Beige", "איך אדע מה התת גוון", titles)).toHaveLength(1);
  });
  it("★ queue 2: plural video asks after a pronoun or an infinitive", () => {
    for (const v of ["יש לכם סרטונים?", "אפשר לקבל סרטונים?", "יש לכם קורס הדרכה לאיפור?"]) { expect(videoAsk(v), v).toBe(true); expect(productAskNow(v), v).toBe(false); }
    expect(videoAsk("יש לכם מעמד לצילום סרטונים?")).toBe(false);
  });
  it("★ queue 3: \"צפוי לחזור למלאי\" is a restock statement", () => {
    expect(caveatHolds("אין לנו כרגע תאריך לחידוש המלאי של סמובי אליס שחור.", "סמובי אליס בצבע שחור צפוי לחזור למלאי בתחילת דצמבר.")).toBe(false);
  });
  it("★ queue 4: two sizes of one name are marked by the size word beside the name", () => {
    const t = [{ title: "משטח הזזה סמובי מלאני גדולה" }, { title: "משטח הזזה סמובי מלאני קטנה" }];
    expect(referredCandidates(t, "סמובי מלאני גדולה מתאים למיקסר.", "")).toEqual([0]);
    expect(referredCandidates(t, "כדאי לבחור במלאני גדולה.", "")).toEqual([0]);
    expect(referredCandidates(t, "יש לנו משטחים בכמה גדלים.", "")).toEqual([]);
  });
});

describe("the price cut takes only its own sentence (stripPrices trims)", () => {
  it("★ one made-up price never wipes the other sentences", () => {
    expect(stripFactProblems("יש לנו את Canvas Tote, תיק בד חזק ונוח לשימוש יומיומי וגם לקניות. הוא עולה ₪999.", [{ kind: "ungrounded_price", prices: ["999"] }] as any)).toBe("יש לנו את Canvas Tote, תיק בד חזק ונוח לשימוש יומיומי וגם לקניות.");
    expect(stripFactProblems("התיק עולה ₪120. מתאים לך?", [{ kind: "ungrounded_price", prices: ["120"] }] as any)).toBe("מתאים לך?");
  });
});

describe("7100b0b6 pre-check: the real messages", () => {
  const L224 = "הי, אני רוצה להזמין את המוצרים שלכם, יש לי שאלה לגבי המעצור.. האם יש מעצור לכל מתקן? כדי שמוצר שהוא לא כבד, לא יחלק או יתגלגל?";
  const L789 = "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית";
  const HARISH = "יערה שלום. במכירה בחריש הייתה מטפחת חגגית מאוד שהיה בה גווני כחול, היא עדיין יישנה?";
  it("★ MISS 1 (L224): the question sentence decides: a stopper question is attribute-only, the list never goes", () => {
    expect(attributeOnlyAsk(L224)).toBe(true);
    expect(attributeOnlyAsk("מאיזה חומר עשויות השרשראות?")).toBe(true);
    expect(attributeOnlyAsk("יש לכם מעצור למיקסר?")).toBe(false);
    expect(attributeOnlyAsk("מחפשת משטח עם ידית")).toBe(false);
    expect(storeQueryOf(L224)).not.toMatch(/הי|מוצרים|שאלה|לגבי/);
  });
  it("★ MISS 2 (L789 and the Harish turn): only product words; describing words alone take the conversation's noun", () => {
    expect(storeQueryOf(L789)).toBe("חגיגי כחול");
    expect(storeQueryOf(L789, { substring: true })).toBe("חגיגי כחול");
    expect(fallbackQueryOf(L789, ["יש לכם מטפחת חגיגית לחתונה?"], null, { substring: true })).toBe("מטפחת חגיגי כחול");
    expect(fallbackQueryOf(L789, [], "מטפחת חגיגית בגווני כחול", { substring: true })).toBe("מטפחת חגיגי כחול");
    expect(storeQueryOf(HARISH)).toBe("מטפחת חגגית כחול");
    expect(storeQueryOf("אני רוצה גוון חום למתחת לעיינים")).toBe("חום לעיינים");
    expect(storeQueryOf("אני רוצה גוון חום למתחת לעיינים", { substring: true })).toBe("חום עיינים");
    // The article never comes off a verb; a word with ב of its own stays; no product word at all gives no query.
    expect(storeQueryOf("הייתה פה מטפחת", { substring: true })).toBe("מטפחת");
    expect(storeQueryOf("הגיעו מטפחות לחג?", { substring: true })).toMatch(/^הגיעו /);
    expect(storeQueryOf("יש לכם בגדי הריון?")).toBe("בגדי הריון");
    expect(storeQueryOf("יש משטחי במבוק?")).toBe("משטחי במבוק");
    expect(storeQueryOf("ראיתי באינסטגרם בחנות שלכם")).toBeNull();
    expect(fallbackQueryOf("הייתה אחת מאוד יפה", [], null)).toBeNull();
  });
  it("★ note: \"מעמד לצילום סרטונים\" with the want-word is a product ask; bare it is no ask at all", () => {
    expect(productAskNow("יש לכם מעמד לצילום סרטונים?")).toBe(true);
    expect(videoAsk("יש לכם מעמד לצילום סרטונים?")).toBe(false);
  });
});

describe("d874dc87 pre-check: the noun is lent only by a product source", () => {
  const L789 = "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית";
  const HARISH = "יערה שלום. במכירה בחריש הייתה מטפחת חגגית מאוד שהיה בה גווני כחול, היא עדיין יישנה?";
  it("★ the real sequence, newest first: the noun comes from the message about a product, never from a first-person state", () => {
    const q = fallbackQueryOf(L789, ["אני לא טובה בלראות באתר וכו..", HARISH], null, { substring: true });
    expect(q).toMatch(/מטפחת/);
    expect(q).not.toMatch(/טובה/);
    expect(q).toBe("מטפחת חגיגי כחול");
  });
  it("★ a previous message with no product in it lends nothing: no search", () => {
    for (const prev of ["בדקתי עכשיו שוב- ואין", "הי , נראה לי ששכחתם אותי 😅", "אני לא טובה בלראות באתר וכו.."]) {
      expect(fallbackQueryOf(L789, [prev], null), prev).toBeNull();
    }
  });
  it("★ the product in focus and the intent lend first; a title word lends too", () => {
    expect(fallbackQueryOf(L789, ["אני לא טובה בלראות באתר וכו.."], null, {}, { focus: "מטפחת אנה כחולה" })).toBe("מטפחת חגיגי כחול");
    expect(fallbackQueryOf(L789, [], "בירור מטפחת חגיגית")).toBe("מטפחת חגיגי כחול");
    expect(fallbackQueryOf(L789, ["והמטפחת ההיא עוד קיימת?"], null, {}, { titles: ["מטפחת אנה", "מטפחת סולו"] })).toBe("מטפחת חגיגי כחול");
  });
  it("★ the early lookup takes the focus product's noun for describing words alone", () => {
    expect(withFocusNoun("חגיגי כחול", "מטפחת אנה כחולה")).toBe("מטפחת חגיגי כחול");
    expect(withFocusNoun("משטח לתמי 4", "סמובי אליס")).toBe("משטח לתמי 4");
    expect(withFocusNoun("חגיגי כחול", null)).toBe("חגיגי כחול");
    expect(q(autoLookups([{ kind: "no_search" }] as any, L789, WOO, [], "מטפחת אנה כחולה"))[0]).toEqual(["woocommerce.list_products", "מטפחת חגיגי כחול"]);
  });
});
