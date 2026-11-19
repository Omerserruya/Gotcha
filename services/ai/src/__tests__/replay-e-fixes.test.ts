/** The independent rating of the 1b35c535 prod replay (replay e, 2026-11-18): the units. Every rule generic. */
import { describe, it, expect } from "vitest";
import { fixCardCount, dropOrphanAlso, ungroundedPositiveFit, neutralSecondPerson, cardReferences } from "../services/reply-engine/gates";
import { cutFragment, withoutSlashForms, productQuestionLine, oneTeamPass as onePass, cutTheAnswer } from "../services/reply-engine/engine";
import { optionClaimsWithoutVariations, cleanStoreQuery, withoutPointer, claimsOrPromisesUnsearched, storeQueryWords, asksAboutProduct, danglingReferences, ungroundedAbsence, notFoundReply, namesAModel } from "../services/reply-engine/gates";
import { sharedTitleNoun } from "../services/reply-engine/engine";
import { buildTurnPart } from "../services/reply-engine/prompt";
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
    // The intent lends only by a catalogue title word or a find/want verb (7a3bc2a3 pre-check).
    expect(fallbackQueryOf(L789, [], "מטפחת חגיגית בגווני כחול", { substring: true }, { titles: ["מטפחת אנה"] })).toBe("מטפחת חגיגי כחול");
    expect(fallbackQueryOf(L789, [], "מטפחת חגיגית בגווני כחול", { substring: true })).toBeNull();
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
    expect(fallbackQueryOf(L789, [], "בירור מטפחת חגיגית", {}, { titles: ["מטפחת אנה"] })).toBe("מטפחת חגיגי כחול");
    expect(fallbackQueryOf(L789, [], "בירור מטפחת חגיגית")).toBeNull();
    expect(fallbackQueryOf(L789, ["והמטפחת ההיא עוד קיימת?"], null, {}, { titles: ["מטפחת אנה", "מטפחת סולו"] })).toBe("מטפחת חגיגי כחול");
  });
  it("★ the early lookup takes the focus product's noun for describing words alone", () => {
    expect(withFocusNoun("חגיגי כחול", "מטפחת אנה כחולה")).toBe("מטפחת חגיגי כחול");
    expect(withFocusNoun("משטח לתמי 4", "סמובי אליס")).toBe("משטח לתמי 4");
    expect(withFocusNoun("חגיגי כחול", null)).toBe("חגיגי כחול");
    expect(q(autoLookups([{ kind: "no_search" }] as any, L789, WOO, [], "מטפחת אנה כחולה"))[0]).toEqual(["woocommerce.list_products", "מטפחת חגיגי כחול"]);
  });
});

describe("7a3bc2a3 pre-check: the intent lends only like a message (26 real intents)", () => {
  const titles = ["טוש טינט חום", "מטפחת אנה"];
  const nulls = ["מחפשת המלצה למוצר מתאים", "קושי להוסיף את בנדנת סוליקה פוקסיה לסל", "לברר מידות מדויקות של הקייס", "לברר על ההבדל בין טושי נמשים", "לברר מועד מלאי של מוצר נינג'ה שחור", "שואלת איך להשתמש במעצור של סמובי גפן", "בירור אופן השימוש במעצור של סמובי גפן", "בירור תפקיד החלקים ואופן חיבור STOOPEE", "בירור שקיפות המשטחים והנחת כמות", "תיאום מסירה, SMS לפני הגעה", "אישור התאמה לסמובי אלכסה", "לבדוק סף למשלוח חינם", "לקבל קישור לסמובי אלכסה", "לקבל את מידות המשטחים", "מבקשת מענה מהיר והחלפת משטח שבור", "החזרת סמובי מוניקה לבן וקבלת זיכוי", "בדיקת אפשרות להחזרת הסמובי", "מחפשת חלופה למייקאפ", "התאמת גוון מייקאפ", "לברר קוד קופון להנחה", "בירור איך לבצע הזמנה באתר", "המשתמשת מסרה כתובת מייל"];
  it("★ a frame, verb or abstract word is never lent: no noun, no search", () => {
    for (const i of nulls) {
      expect(fallbackQueryOf("רוצה לבן", [], i, { substring: true }, { titles }), i).toBeNull();
      expect(fallbackQueryOf("רוצה לבן", [], i, {}, { titles }), i).toBeNull();
    }
  });
  it("★ a find or want verb's object, or a catalogue title word, is lent bare", () => {
    expect(fallbackQueryOf("רוצה לבן", [], "למצוא משטחי הזזה מתאימים לתמי 4, מיקסר ומכונת קפה")).toBe("משטחי לבן");
    expect(fallbackQueryOf("רוצה לבן", [], "בירור שם של טוש טינט חום", {}, { titles })).toBe("טוש לבן");
    expect(fallbackQueryOf("רוצה לבן", [], "האם המטפחת החגיגית בגווני כחול עדיין קיימת", {}, { titles })).toBe("מטפחת לבן");
    expect(fallbackQueryOf("רוצה לבן", [], "הלקוחה מחפשת מטפחת חגיגית כחולה")).toBe("מטפחת לבן");
    // The early lookup's focus noun goes out bare as well.
    expect(withFocusNoun("חגיגי כחול", "המטפחת החגיגית")).toBe("מטפחת חגיגי כחול");
  });
  it("★ queue: a governed infinitive, adverb or abstract word in an earlier message lends nothing", () => {
    for (const p of ["אשמח להתיחסות שלכם", "מה יש כרגע במלאי?", "אשמח לקבל הודעה כשיגיע", "והאם יש עלות משלוח לאזור ירושלים?", "מחפשת למיקסר שלי"]) {
      expect(fallbackQueryOf("רוצה לבן", [p], null), p).toBeNull();
    }
    // An abstract word lends nothing even when a catalogue title has it.
    expect(fallbackQueryOf("רוצה לבן", ["חלופה טובה?"], null, {}, { titles: ["חלופה לסוכר"] })).toBeNull();
  });
});

describe("dev live round on dcf2158e: option claims", () => {
  const draft = "בשחור יש את ה-Heavyweight Hoodie, מקפוצ'ון כותנה אורגנית עבה. ה-Zip Hoodie הוא בצבע Charcoal, לא שחור.";
  const gp = (id: string, name: string, extra = "") => ({ tool: "woocommerce.get_product", outcome: "ok", decision: "allow", args: { product_id: id }, content: JSON.stringify({ ok: true, result: { id, name, description: extra } }) }) as any;
  it("★ (a) the cut sentence held her ask and what is left says it only negated: the answer was cut", () => {
    expect(cutTheAnswer(["בשחור יש את ה-Heavyweight Hoodie, מקפוצ'ון כותנה אורגנית עבה."], "ה-Zip Hoodie הוא בצבע Charcoal, לא שחור.", "רוצה שחור")).toBe(true);
    expect(cutTheAnswer(["התיק עולה ₪999."], "יש לנו תיק בד בשחור, חזק ונוח.", "רוצה תיק שחור")).toBe(false);
    // A short follow-up with no product word: the colour, the size or the price is her ask.
    expect(cutTheAnswer(["בשחור יש את ה-Heavyweight Hoodie."], "ה-Zip Hoodie הוא בצבע Charcoal, לא שחור.", "יש בשחור?")).toBe(true);
    expect(cutTheAnswer(["במידה L יש את ה-Heavyweight Hoodie."], "ה-Zip Hoodie אזל.", "ויש L?")).toBe(true);
    expect(cutTheAnswer(["ה-Heavyweight Hoodie עולה ₪249."], "הוא עשוי כותנה אורגנית עבה ונעים מאוד.", "כמה זה עולה?")).toBe(true);
    expect(cutTheAnswer(["הוא גם נוח לכביסה."], "ה-Heavyweight Hoodie עולה ₪249.", "כמה זה עולה?")).toBe(false);
    expect(cutTheAnswer(["הוא גם נוח לכביסה."], "בשחור יש את ה-Heavyweight Hoodie.", "יש בשחור?")).toBe(false);
    expect(cutTheAnswer(["הוא עולה ₪999."], "יש לנו את Canvas Tote.", "יש לכם תיק בד?")).toBe(false);
  });
  it("★ (b) the variations of the product the claim names are read; a product read listing the colour grounds an existence claim", async () => {
    const reads = [gp("77", "Heavyweight Hoodie"), gp("78", "Zip Hoodie"), gp("77", "Heavyweight Hoodie")];
    const claims = optionClaimsWithoutVariations(draft, "רוצה שחור", reads);
    expect(claims).toHaveLength(1);
    const calls = autoLookups([{ kind: "option_without_variation", claims }] as any, "רוצה שחור", ["woocommerce.list_products", "woocommerce.list_product_variations"], reads);
    expect(calls[0].function.name).toBe("woocommerce.list_product_variations");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ product_id: "77" });
    // The product's own read lists the colour: "יש בשחור" is grounded; "במלאי בשחור" still needs the variations.
    const listed = [gp("77", "Heavyweight Hoodie", "Color: Black, Sand")];
    expect(optionClaimsWithoutVariations("בשחור יש את ה-Heavyweight Hoodie.", "רוצה שחור", listed)).toEqual([]);
    expect(optionClaimsWithoutVariations("ה-Heavyweight Hoodie בשחור במלאי.", "רוצה שחור", listed)).toHaveLength(1);
    // Per product: Black on another product's read never grounds this one (3 reads, Black only on the Zip).
    const other = [gp("77", "Heavyweight Hoodie", "Color: Sand"), gp("78", "Zip Hoodie", "Color: Black, Charcoal"), gp("77", "Heavyweight Hoodie", "Color: Sand")];
    expect(optionClaimsWithoutVariations("בשחור יש את ה-Heavyweight Hoodie.", "רוצה שחור", other)).toHaveLength(1);
    expect(optionClaimsWithoutVariations("בשחור יש את ה-Zip Hoodie.", "רוצה שחור", other)).toEqual([]);
    // No product named and several read: nothing grounds it.
    expect(optionClaimsWithoutVariations("בשחור יש את ה-Pullover.", "רוצה שחור", other)).toHaveLength(1);
  });
});

describe("rating of the dcf2158e prod replay: units", () => {
  it("★ B: a dangling pointer loses only its pointing words", () => {
    const r = "השרשראות שמופיעות כאן עשויות מפלדת אל חלד (Stainless Steel). בחלק מהדגמים מצוין גם תליון מאבני חן.";
    expect(stripFactProblems(r, [{ kind: "dangling_reference", claims: ["השרשראות שמופיעות כאן עשויות מפלדת אל חלד (Stainless Steel)."] }] as any)).toBe("השרשראות עשויות מפלדת אל חלד (Stainless Steel). בחלק מהדגמים מצוין גם תליון מאבני חן.");
    expect(withoutPointer("בחר באחד מהמוצרים שמופיעים כאן.")).toBe("בחר באחד מהמוצרים.");
    expect(withoutPointer("שמופיעים כאן.")).toBe("");
  });
  it("★ F: a payment card is never a product card", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    for (const r of ["אבקש מהצוות לבדוק את החיוב בכרטיס ואת סטטוס ההזמנה, ויענו כאן בצ'אט.", "צוות השירות כבר בודק את החיוב בכרטיס, אפשר לצרף כאן אישור עסקה בלי פרטי כרטיס מלאים.", "כרגע הבדיקה מול הצוות היא האם נרשם חיוב בכרטיס ומה אפשר לעשות לגבי ההזמנה שבוטלה."]) {
      const p = gate3({ reply: r, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: "חויבתי ואין הזמנה", isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false, teamQuestion: "חיוב", openTeamText: "חיוב" } as any).problems;
      expect(p.map((x: any) => x.kind), r).not.toContain("card_reference");
      expect(p.flatMap((x: any) => (x.kind === "style" ? x.codes : [])), r).not.toContain("card_narration");
    }
  });
  it("★ G: a period inside an email, a domain, a decimal or a size is no sentence end", () => {
    const r = "אפשר לכתוב ל-support@gmail.com או לבקר ב-shop.example.co.il. המשטח 15.4x23 ס\"מ עולה ₪999.";
    const out = stripFactProblems(r, [{ kind: "ungrounded_price", prices: ["999"] }] as any);
    expect(out).toBe("אפשר לכתוב ל-support@gmail.com או לבקר ב-shop.example.co.il.");
    expect(out).not.toMatch(/gmail\. com|example\. co/);
  });
  it("★ H: a store query never holds a question, stop or talk word", () => {
    expect(cleanStoreQuery("להזמין סמובי")).toBe("סמובי");
    expect(cleanStoreQuery("אילו קרמים ליום")).toBe("קרמים ליום");
    expect(cleanStoreQuery("מאיזה חומר השרשרת")).toBe("חומר השרשרת");
    expect(cleanStoreQuery("Canvas Tote")).toBe("Canvas Tote");
  });
  it("★ I: an absence line is not the answer when what is left names products or asks a focused question", () => {
    expect(cutTheAnswer(["לא מצאתי את נינג'ה קריספי בשם הזה."], "המשטחים שמופיעים להתאמות נינג'ה הם אריאל, גפן, אליס, אסף וכריסטינה. אפשר לבדוק התאמה לפי רוחב ועומק בסיס המכשיר, מה המידות?", "ולנינגה קריספי")).toBe(false);
    expect(cutTheAnswer(["בשחור יש את ה-Heavyweight Hoodie."], "ה-Zip Hoodie הוא בצבע Charcoal, לא שחור.", "רוצה שחור")).toBe(true);
  });
});

describe("pre-check of 51d0273e: the follow-ups", () => {
  const W = ["woocommerce.list_products", "search_knowledge"];
  it("★ 1: a policy answer is no product claim; a product claim still is", () => {
    expect(claimsOrPromisesUnsearched("יש לנו משלוח חינם מעל 300 ש\"ח.", "יש לכם משלוח חינם על המטפחות?", [], W)).toBe(false);
    expect(claimsOrPromisesUnsearched("יש לנו אחריות לשנה על כל המוצרים.", "יש אחריות על הבלנדר?", [], W)).toBe(false);
    // "יש כמה" before a policy word is no product claim either.
    expect(claimsOrPromisesUnsearched("יש לנו כמה מבצעים החודש.", "יש לכם מבצע על המטפחות?", [], W)).toBe(false);
    expect(claimsOrPromisesUnsearched("היי! יש כמה מטפחות חגיגיות בגווני כחול, אבל אין לי דרך לזהות.", "יערה שלום. במכירה בחריש הייתה מטפחת חגגית מאוד שהיה בה גווני כחול, היא עדיין יישנה?", [], W)).toBe(true);
    expect(claimsOrPromisesUnsearched("ברור, נחפש דווקא מטפחת חגיגית בגווני כחול.", "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית", [], W)).toBe(true);
  });
  it("★ 2: in a payment conversation \"בכרטיס\" is her card; a product card line elsewhere still is a card reference", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    const g = (reply: string, incoming: string) => gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: incoming, recentInbound: [incoming], isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false } as any).problems;
    for (const r of ["אישור בכרטיס לא בהכרח אומר שההזמנה הושלמה.", "כן, ייתכן שיופיע אישור בכרטיס גם אם ההזמנה לא הושלמה באתר.", "לפי התקנון רכישה תקפה רק אחרי אישור החברה והפקת חשבונית, ולכן אישור בכרטיס לבדו לא מאשר שההזמנה הושלמה."]) {
      const p = g(r, "בכרטיס רשום שאושר");
      expect(p.map((x: any) => x.kind), r).not.toContain("card_reference");
      expect(p.flatMap((x: any) => (x.kind === "style" ? x.codes : [])), r).not.toContain("card_narration");
    }
    expect(g("רואים את זה בכרטיס המוצר למטה.", "יש לכם משטח למיקסר?").map((x: any) => x.kind)).toContain("card_reference");
  });
  it("★ 3: a query keeps the geresh, the curly apostrophe and a closing apostrophe", () => {
    expect(cleanStoreQuery("נינג׳ה קרמה 28x18")).toBe("נינג'ה קרמה 28x18");
    expect(cleanStoreQuery("ג׳ינס שחור")).toBe("ג'ינס שחור");
    expect(cleanStoreQuery("קפוצ’ון שחור")).toBe("קפוצ'ון שחור");
    expect(cleanStoreQuery("משטח בז'")).toBe("משטח בז'");
    expect(storeQueryOf("יש לכם משטח בז'?")).toBe("משטח בז'");
  });
  it("★ 4: more conversation words never reach the store", () => {
    expect(cleanStoreQuery("אילו מוצרים מומלצים לעדינות ומראה יומי?")).toBe("לעדינות ומראה יומי");
    expect(storeQueryWords("הי מה נשמע? לא קיבלתי ממך עדכון")).toBeNull();
    expect(cleanStoreQuery("לא מצליח לשלם עם ביימי")).toBe("ביימי");
    expect(storeQueryOf("קניתי טוש למילוי גבות, אשמח להסבר /סרטון איך להשתמש?")).not.toMatch(/הסבר/);
  });
});

describe("abed8d54 rerun: the payment-card waiver is per sentence", () => {
  const g = async (reply: string, incoming: string) => {
    const { gate3 } = await import("../services/reply-engine/gates");
    return gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: incoming, recentInbound: [incoming], isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false } as any).problems;
  };
  const refs = (p: any[]) => p.filter((x) => x.kind === "card_reference").flatMap((x) => x.claims);
  it("★ a bare payment-card mention is waived; a sentence that names or points at a product card is not", async () => {
    expect(refs(await g("אישור בכרטיס לא בהכרח אומר שההזמנה הושלמה.", "אין לי מספר הזמנה אבל בכרטיס רשום שאושר"))).toEqual([]);
    expect(refs(await g("אפשר לראות את המחיר בכרטיס המוצר למטה.", "מה אפשרויות התשלום?"))).toHaveLength(1);
    const mixed = refs(await g("החיוב בכרטיס יופיע תוך שלושה ימים. תראי בכרטיס הראשון את הדגם.", "שילמתי בכרטיס אשראי"));
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatch(/הראשון/);
    for (const r of ["הפרטים המלאים מופיעים בכרטיס.", "בכרטיס שלמעלה רואים את הצבעים.", "תראי בכרטיס הראשון."]) {
      expect(refs(await g(r, "יש לכם משטח למיקסר?")), r).toHaveLength(1);
    }
    for (const r of ["הפרטים המלאים מופיעים בכרטיס.", "בכרטיס שלמעלה רואים את הצבעים.", "תראי בכרטיס הראשון.", "אפשר לראות את המחיר בכרטיס המוצר למטה."]) {
      expect(refs(await g(r, "מה אפשרויות התשלום?")), r).toHaveLength(1);
    }
    // Card narration stays raised when a sentence narrates the product cards, payment talk or not.
    const codes = (await g("מתחת מופיעים הכרטיסים עם הפרטים.", "מה אפשרויות התשלום?")).flatMap((x: any) => (x.kind === "style" ? x.codes : []));
    expect(codes).toContain("card_narration");
    // A bare charge on her card in the same payment talk stays waived.
    expect(refs(await g("החיוב בכרטיס יופיע תוך שלושה ימים.", "מה אפשרויות התשלום?"))).toEqual([]);
  });
});

describe("dev live round on 51d0273e (round k)", () => {
  const W = ["woocommerce.list_products", "search_knowledge"];
  it("★ 1: the noun the last search's products share", () => {
    expect(sharedTitleNoun(["Heavyweight Hoodie (Black)", "Zip Hoodie", "Pullover Hoodie"])).toBe("Hoodie");
    expect(sharedTitleNoun(["Zip Hoodie"])).toBeNull();
    expect(fallbackQueryOf("רוצה שחור", [], null, { substring: true }, { focus: "Hoodie" })).toBe("Hoodie שחור");
  });
  it("★ 2: \"ראיתי אצלכם X, היא עדיין ישנה?\" is about a product; a place word never hides a claim; no-stock-info with no search is unsearched", () => {
    const her = "ראיתי אצלכם חולצה מאוד יפה בגווני כחול, היא עדיין ישנה?";
    expect(asksAboutProduct(her)).toBe(true);
    expect(claimsOrPromisesUnsearched("יש באתר כמה חולצות, אבל אין מידע מאומת על גווני הכחול או על המלאי העדכני.", her, [], W)).toBe(true);
    expect(claimsOrPromisesUnsearched("יש אצלנו כמה חולצות כחולות.", her, [], W)).toBe(true);
    expect(claimsOrPromisesUnsearched("יש בחנות מגוון חולצות.", "יש לכם חולצה כחולה?", [], W)).toBe(true);
    expect(claimsOrPromisesUnsearched("אין לנו מידע מאומת על המלאי של החולצה.", her, [], W)).toBe(true);
    // With a store read this turn none of it fires.
    expect(claimsOrPromisesUnsearched("יש אצלנו כמה חולצות כחולות.", her, [{ tool: "woocommerce.list_products", outcome: "ok" } as any], W)).toBe(false);
  });
  it("★ 3: an English catalogue grounds the Hebrew colour; a plural pointer with nothing attached dangles", () => {
    const ev = "Oxford Button-Down Shirt Color: Light Blue, White\nStriped Cotton Shirt Color: Blue Stripe. A fine blue-and-white bengal stripe shirt";
    const her = "ראיתי אצלכם חולצה מאוד יפה בגווני כחול, היא עדיין ישנה?";
    expect(ungroundedAttribute("בטח, יש חולצת אוקספורד בתכלת וגם חולצת כותנה בפסים כחול-לבן.", ev, her, ["Oxford Button-Down Shirt", "Striped Cotton Shirt"])).toEqual([]);
    expect(ungroundedAttribute("יש חולצת אוקספורד בכחול בהיר.", ev, her, ["Oxford Button-Down Shirt"])).toEqual([]);
    expect(ungroundedAttribute("יש חולצת אוקספורד בירוק.", ev, her, ["Oxford Button-Down Shirt"])).toHaveLength(1);
    expect(danglingReferences("חולצת האוקספורד כרגע במבצע, אז אפשר להיכנס לאחת מהן ולראות אם זו החולצה שראית.", false)).toHaveLength(1);
    expect(danglingReferences("אפשר להיכנס לאחת מהן.", true)).toEqual([]);
    expect(danglingReferences("האם גם אחד מהם נכשל?", false)).toEqual([]);
  });
  it("★ 4: an English message gets the reply-language line", () => {
    expect(buildTurnPart({ stateText: "-", summary: null, knowledge: null, page: null, closedHours: null, pendingApprovals: [], customer: null, nowIso: "x", replyLanguage: "English" })).toMatch(/reply in English/);
    expect(buildTurnPart({ stateText: "-", summary: null, knowledge: null, page: null, closedHours: null, pendingApprovals: [], customer: null, nowIso: "x" })).not.toMatch(/Reply language/);
  });
  it("★ 5: her approval on her card (\"אישור מופיע בכרטיס\") is no product card; a pointed product card still is", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    const her = "אין לי מספר הזמנה אבל בכרטיס רשום שאושר";
    const g = (reply: string) => gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [], grounding: "", locale: "he", incomingMessage: her, recentInbound: [her], isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: [], shopFloor: false, handedOff: false, approvalPending: false } as any).problems.map((x: any) => x.kind);
    expect(g("מבינים, אבל אישור שמופיע בכרטיס לא מאשר שההזמנה נקלטה.")).not.toContain("card_reference");
    expect(g("אישור מופיע בכרטיס, אבל ההזמנה עוד לא נקלטה.")).not.toContain("card_reference");
    expect(g("תראי בכרטיס הראשון את הדגם.")).toContain("card_reference");
  });
});

describe("dev recheck on 6320af2f", () => {
  it("★ 8: the Hebrew colours of an English catalogue are the same fact; a lone plural pointer dangles", () => {
    const ev = "Oxford Button-Down Shirt Color: Light Blue, White\nStriped Cotton Shirt Color: Blue Stripe. A fine blue-and-white bengal stripe shirt\nCropped Hoodie Color: Ecru, Dusty Rose\nZip Hoodie Color: Charcoal";
    expect(ungroundedAttribute("יש באתר חולצת אוקספורד בתכלת, וגם חולצת כותנה בפסים כחול-לבן.", ev, "ראיתי אצלכם חולצה מאוד יפה בגווני כחול, היא עדיין ישנה?", ["Oxford Button-Down Shirt", "Striped Cotton Shirt"])).toEqual([]);
    expect(ungroundedAttribute("ה-Cropped Hoodie מגיע באקרו או ורוד מעושן, וה-Zip Hoodie בפחם.", ev, "יש לכם קפוצ'ון?", ["Cropped Hoodie", "Zip Hoodie"])).toEqual([]);
    expect(danglingReferences("לא בטוח איזו מהן ראית, תוכלו לתאר אם היא חלקה או מפוספסת?", false)).toHaveLength(1);
    // With the items named before it, the pointer has its antecedent.
    expect(danglingReferences("יש חולצת אוקספורד בתכלת וחולצת כותנה בפסים. לא בטוח איזו מהן ראית, תוכלו לתאר?", false)).toEqual([]);
    expect(danglingReferences("לא בטוח איזו מהן ראית?", true)).toEqual([]);
  });
  it("★ 9: an empty search of the product word backs \"no black jeans\"; a narrower empty search still does not", () => {
    const e = (q: string) => ({ tool: "woocommerce.list_products", args: { query: q }, outcome: "empty", content: "[]" }) as any;
    const ok = (q: string, c: string) => ({ tool: "woocommerce.list_products", args: { query: q }, outcome: "ok", content: c }) as any;
    expect(ungroundedAbsence("לא מצאנו ג'ינס שחור בקטלוג.", [e("ג'ינס"), ok("black", '[{"name":"Heavyweight Hoodie"}]')])).toEqual([]);
    expect(ungroundedAbsence("אין לנו סנובורד.", [e("snowboard beginner"), e("סנובורד למתחילים")])).toHaveLength(1);
    // Every query word counts, a short one too: "משטח עץ" is narrower than "משטחי במבוק".
    expect(ungroundedAbsence("משטחי במבוק אנחנו לא מוכרים.", [e("משטח עץ")])).toHaveLength(1);
    // A search of the same turn that returned black jeans contradicts it (the Supervisor's probe of d9f7c248).
    expect(ungroundedAbsence("לא מצאנו ג'ינס שחור בקטלוג.", [e("ג'ינס"), ok("ג'ינס", '[{"name":"ג\'ינס שחור"}]')])).toHaveLength(1);
  });
  it("★ 9: the not-found line fits a kind of product; a named model keeps its own", () => {
    expect(notFoundReply("he", "יש לכם ג'ינס שחור?")).not.toMatch(/דגם בשם הזה|נחוץ/);
    expect(notFoundReply("he", "יש לכם ג'ינס שחור?")).toMatch(/לא מצאתי את זה בקטלוג/);
    expect(notFoundReply("he", "יש לכם משטח לתמי 4?")).toMatch(/דגם בשם הזה/);
    expect(notFoundReply("he", "יש לכם KitchenAid Artisan?")).toMatch(/דגם בשם הזה/);
    // The engine hands it her message (the branch sits behind a failed rewrite; checked in the source).
    const { readFileSync } = require("fs");
    expect(readFileSync("src/services/reply-engine/engine.ts", "utf8")).toMatch(/reply: notFoundReply\(locale, String\(opts\.incomingMessage \?\? ""\)\)/);
  });
});

describe("dev round on 6320af2f, item 7: a list block is whole", () => {
  it("★ two hoodies at ₪299, both in stock, each keep their price and stock line", async () => {
    const { assembleOnce } = await import("../services/reply-engine/engine");
    const list = "Cropped Hoodie\n₪299\nבמלאי\nhttps://shop.example/cropped\n\nZip Hoodie\n₪299\nבמלאי\nhttps://shop.example/zip\n\nHeavyweight Hoodie\n₪359\nבמלאי\nhttps://shop.example/heavy";
    const out = assembleOnce("יש כמה קפוצ'ונים, ה-Zip Hoodie כרגע במבצע.", list, ["Cropped Hoodie", "Zip Hoodie", "Heavyweight Hoodie"]);
    expect(out).toContain("Zip Hoodie\n₪299\nבמלאי\nhttps://shop.example/zip");
    expect(out).toContain("Heavyweight Hoodie\n₪359\nבמלאי");
    expect(out.match(/₪299/g)).toHaveLength(2);
    // The text still never says a line twice, and a block never goes out twice.
    expect(assembleOnce("הנה מה שמצאתי:\nהנה מה שמצאתי.", "A\n₪10\n\nA\n₪10", ["A"]).match(/הנה מה שמצאתי/g)).toHaveLength(1);
    expect(assembleOnce("שלום", "A\n₪10\n\nA\n₪10", ["A"]).match(/₪10/g)).toHaveLength(1);
  });
});

describe("probe of d9f7c248", () => {
  const W = ["woocommerce.list_products", "search_knowledge"];
  it("★ 1: the shared word must be a real noun; else the subject lends as before", () => {
    expect(sharedTitleNoun(["קרם לחות לפנים", "סרום לפנים"])).toBeNull();
    expect(sharedTitleNoun(["כיסוי למכונת קפה", "מעמד למכונת קפה"])).toBe("קפה");
    expect(sharedTitleNoun(["Black Hoodie", "Black Jeans"])).toBeNull();
    expect(sharedTitleNoun(["T-Shirt with logo", "Hoodie with zip"])).toBeNull();
    expect(sharedTitleNoun(["שרשרת זהב עם תליון", "צמיד זהב עם תליון"])).toBe("תליון");
    expect(sharedTitleNoun(["Heavyweight Hoodie (Black)", "Zip Hoodie", "Pullover Hoodie"])).toBe("Hoodie");
    // A material is no subject; a noun opening with מ or ב is one.
    expect(sharedTitleNoun(["עור תיק גדול", "עור ארנק קטן"])).toBeNull();
    expect(sharedTitleNoun(["Cotton Shirt", "Cotton Pants"])).toBeNull();
    expect(sharedTitleNoun(["משטח הזזה גדול", "משטח הזזה קטן"])).toBe("משטח");
    expect(sharedTitleNoun(["בקבוק מים 1 ליטר", "בקבוק מים 2 ליטר"])).toBe("בקבוק");
  });
  it("★ 2: an empty search never backs an absence a search of the same turn contradicts", () => {
    const e = (q: string) => ({ tool: "woocommerce.list_products", args: { query: q }, outcome: "empty", content: "[]" }) as any;
    const ok = (q: string, c: string) => ({ tool: "woocommerce.list_products", args: { query: q }, outcome: "ok", content: c }) as any;
    expect(ungroundedAbsence("לא מצאנו ג'ינס שחור בקטלוג.", [e("ג'ינס"), ok("ג׳ינס שחור", "ג'ינס שחור סלים | 249 | במלאי")])).toHaveLength(1);
    expect(ungroundedAbsence("אין לנו משטח לתמי 4.", [e("תמי"), ok("משטח", "משטח הזזה לתמי 4 | 89")])).toHaveLength(1);
    expect(ungroundedAbsence("לא מצאנו ג'ינס שחור בקטלוג.", [e("ג'ינס"), ok("black", '[{"name":"Heavyweight Hoodie"}]')])).toEqual([]);
  });
  it("★ 3: a plural pointer with its items named, or at her own two things, does not dangle", () => {
    expect(danglingReferences("ההבדל ביניהם הוא בגודל.", false, "מה ההבדל בין המשטח הקטן לגדול?")).toEqual([]);
    expect(danglingReferences("איזה מהם ניסית, אשראי או ביט?", false)).toEqual([]);
    expect(danglingReferences("אפשר לשלם באחד מהם: אשראי, ביט או פייפאל.", false)).toEqual([]);
    expect(danglingReferences("לא בטוח איזו מהן ראית, תוכלו לתאר אם היא חלקה או מפוספסת?", false, "ראיתי אצלכם חולצה מאוד יפה בגווני כחול, היא עדיין ישנה?")).toHaveLength(1);
    expect(danglingReferences("ביניהן יש גם דגם מפוספס.", false, "יש לכם חולצות?")).toHaveLength(1);
  });
  it("★ 4: a clause opener is no product noun; plural policy nouns are no product claim", () => {
    expect(asksAboutProduct("ראיתי אצלכם שאפשר לשלם בביט?")).toBe(false);
    expect(claimsOrPromisesUnsearched("יש כאן כמה אפשרויות תשלום.", "ראיתי אצלכם שאפשר לשלם בביט?", [], W)).toBe(false);
    expect(claimsOrPromisesUnsearched("יש באתר כמה נקודות איסוף.", "יש לכם נקודת איסוף בחיפה?", [], W)).toBe(false);
    expect(asksAboutProduct("ראיתי אצלכם חולצה מאוד יפה בגווני כחול, היא עדיין ישנה?")).toBe(true);
    expect(asksAboutProduct("ראיתי אצלכם שמלה כחולה, יש עוד?")).toBe(true);
  });
  it("★ 5: a geresh inside a word is no quote; a Latin word alone is no name in English", () => {
    expect(namesAModel("יש לכם ג'ינס או קפוצ'ון?")).toBe(false);
    expect(namesAModel("do you have jeans?")).toBe(false);
    expect(namesAModel("do you have the Zip Hoodie?")).toBe(true);
    expect(namesAModel("יש לכם משטח לתמי 4?")).toBe(true);
    expect(namesAModel("יש לכם KitchenAid?")).toBe(true);
    expect(namesAModel("יש לכם 'סלים פיט'?")).toBe(true);
    expect(notFoundReply("en", "do you have jeans?")).toMatch(/couldn't find that in the catalogue/);
  });
});

describe("rating of b3d2bbf3", () => {
  const W = ["woocommerce.list_products", "search_knowledge"];
  it("★ 1: products named with no store read start the store search; \"the information does not include X\" needs a store read", async () => {
    const { autoLookups } = await import("../services/reply-engine/gates");
    const her = "קניתי טוש למילוי גבות, אשמח להסבר /סרטון איך להשתמש?";
    const q = (m: string) => JSON.parse(autoLookups([{ kind: "unknown_product" } as any], m, W, [{ tool: "search_knowledge", outcome: "ok" } as any])[0]?.function.arguments ?? "{}").query;
    expect(q(her)).toBe("טוש מילוי גבות");
    expect(q("יש קרם איפור במקום המייקאפ? אני פחות מתחברת למייקאפ")).toMatch(/^קרם איפור/);
    // A store read this turn: no second one.
    expect(autoLookups([{ kind: "unknown_product" } as any], her, W, [{ tool: "woocommerce.list_products", outcome: "ok" } as any])).toEqual([]);
    expect(claimsOrPromisesUnsearched("המידע שיש לנו מתאר את הטוש כמוצר למילוי גבות בקלילות, אבל לא כולל הוראות מפורטות או סרטון.", her, [], W)).toBe(true);
    expect(claimsOrPromisesUnsearched("התיאור לא מציין שימוש מתחת לעיניים.", "יש לכם פנסטיק שמתאים מתחת לעיניים?", [], W)).toBe(true);
    expect(claimsOrPromisesUnsearched("המידע שיש לנו מתאר את הטוש כמוצר למילוי גבות בקלילות, אבל לא כולל הוראות מפורטות או סרטון.", her, [{ tool: "woocommerce.get_product", outcome: "ok" } as any], W)).toBe(false);
  });
  it("★ 7: conversation words never reach the store", () => {
    expect(storeQueryOf("אפשר המלצה?")).toBeNull();
    expect(storeQueryWords("מלצה")).toBeNull();
    expect(storeQueryWords("גוון כרגע")).toBeNull();
    expect(cleanStoreQuery("משטח למכשיר אלה")).toBe("משטח");
  });
});

describe("rating of b3d2bbf3, 3: new details are passed on, no repeat", () => {
  it("★ the last four digits of the card: the sentence that passes them on stays", async () => {
    const { repeatedTeamLine } = await import("../services/reply-engine/gates");
    const r = "תודה, העברנו את ארבע הספרות האחרונות לצוות יחד עם הבקשה לבדוק את החיוב.";
    expect(repeatedTeamLine(r, "4155", true, false)).toBe(false);
    expect(repeatedTeamLine(r, "הספרות האחרונות הן 4155", true, false)).toBe(false);
    // With nothing new, the same line is a repeat as before.
    expect(repeatedTeamLine("העברנו את זה לצוות, והתשובה תגיע כאן בצ'אט.", "תודה", true, false)).toBe(true);
  });
});

describe("rating of b3d2bbf3, 2: no second store try after a timeout when the knowledge answers", () => {
  it("★ timeout plus knowledge_has_it: no automatic store search; without the knowledge it still retries narrower", async () => {
    const { autoLookups } = await import("../services/reply-engine/gates");
    const W = ["woocommerce.list_products", "search_knowledge"];
    const timedOut = [{ tool: "woocommerce.list_products", args: { query: "אליס שחור" }, outcome: "timeout" } as any];
    const her = "שלום מתי יתחדש המלאי אליס שחור";
    expect(autoLookups([{ kind: "gave_up_search" } as any, { kind: "knowledge_has_it" } as any], her, W, timedOut)).toEqual([]);
    expect(autoLookups([{ kind: "ungrounded_absence", claims: ["אין לנו אליס בשחור."] } as any, { kind: "knowledge_has_it" } as any], her, W, timedOut)).toEqual([]);
    expect(autoLookups([{ kind: "gave_up_search" } as any], her, W, timedOut)).toHaveLength(1);
  });
});

describe("rating of b3d2bbf3, 8: neutral address and no process talk", () => {
  it("★ \"תרצה\", glued to ש too, becomes the plural; the style check still raises it", async () => {
    const { cleanStyle } = await import("../services/reply-engine/gates");
    const a = cleanStyle("בטח! סמובי מתאים למכשירי חשמל וחפצים בבית. מה המכשיר או החפץ שתרצה להניח עליו?", ["gendered_address"]);
    expect(a).toContain("שתרצו להניח");
    expect(a).not.toMatch(/תרצה/);
    expect(cleanStyle("בטח. איזה מכשיר או חפץ תרצה להניח על המשטח?", ["gendered_address"])).toContain("איזה מכשיר או חפץ תרצו להניח");
    // A word that only ends like it stays.
    expect(cleanStyle("המשטח מתאים לכל מכשיר שתרצו.", ["gendered_address"])).toBe("המשטח מתאים לכל מכשיר שתרצו.");
  });
  it("★ the bot's own lookup and what it did not verify never reach the customer; the answer around it stays", async () => {
    const { cleanStyle, internalJargon } = await import("../services/reply-engine/gates");
    const d = "נכון, טעינו קודם ולא בדקנו את התיאור. זה טינט שפתיים, והגוון Cocoa הוא חום שוקולדי, אבל המוצר מיועד לשפתיים ולא מתחת לעיניים. מצטערים על ההטעיה.";
    expect(internalJargon(d)).toBe(true);
    expect(cleanStyle(d, ["internal_jargon"])).toBe("זה טינט שפתיים, והגוון Cocoa הוא חום שוקולדי, אבל המוצר מיועד לשפתיים ולא מתחת לעיניים. מצטערים על ההטעיה.");
    const e = "סליחה שלא קיבלת עדכון. אין כאן פנייה קודמת פתוחה או פרטים על מה שצריך לעדכן, אפשר לכתוב במה מדובר?";
    expect(internalJargon(e)).toBe(true);
    expect(cleanStyle(e, ["internal_jargon"])).toBe("סליחה שלא קיבלת עדכון. אפשר לכתוב במה מדובר?");
    const c = "בחיפוש לפי חולצת טי מופיעה חולצה שחורה או לבנה, לא בתכלת. צבעי החולצות הכחולות שתוארו קודם לא אומתו, אז העברתי לצוות לבדוק אם יש חולצה בתכלת.";
    expect(cleanStyle(c, ["internal_jargon"])).toBe("");
    expect(internalJargon("לא ברור לאיזו מהחולצות התכוונת, ואין לנו מחיר מאומת לחולצות שתוארו קודם.")).toBe(true);
    // A plain answer is no process talk.
    expect(internalJargon("לתמי 4 מתאים משטח סמובי אלכסה, במידה 30x40.")).toBe(false);
    expect(internalJargon("בדקנו ויש במלאי.")).toBe(false);
  });
});

describe("dev round k3 B: a price ask about the products in focus reads them", () => {
  it("★ \"כמה היא עולה?\" answered with no price or a request for the name: unread_product; the lookup reads the focus product", async () => {
    const { unreadProduct, autoLookups } = await import("../services/reply-engine/gates");
    const W = ["woocommerce.list_products", "woocommerce.get_product", "search_knowledge"];
    const r = "לא ברור לאיזו מהחולצות התכוונת, ואין לנו מחיר מאומת לחולצות שתוארו קודם. אפשר לשלוח שם או קישור לחולצה, ואבדוק את המחיר שלה.";
    expect(unreadProduct(r, "כמה היא עולה?", [{ tool: "search_knowledge", decision: "allow", outcome: "ok" } as any], W)).toBe(true);
    expect(unreadProduct(r, "כמה היא עולה?", [{ tool: "woocommerce.get_product", decision: "allow", outcome: "ok" } as any], W)).toBe(false);
    // A price given is no problem.
    expect(unreadProduct("חולצת האוקספורד עולה 229 ש\"ח.", "כמה היא עולה?", [], W)).toBe(false);
    const q = JSON.parse(autoLookups([{ kind: "unread_product" } as any], "כמה היא עולה?", W, [{ tool: "search_knowledge", outcome: "ok" } as any], "Oxford Button-Down Shirt")[0]?.function.arguments ?? "{}").query;
    expect(q).toBe("Oxford Button-Down Shirt");
  });
});

describe("dev round k3 D: an information question the knowledge answers is no hand-over; the team question is this turn's", () => {
  const K = "שאלה: אילו אפשרויות תשלום קיימות? תשובה: אפשר לשלם בהעברה בנקאית או במזומן בעת המסירה. אין תשלום בביט.";
  it("★ a bare team line to \"מה אפשרויות התשלום?\" with the knowledge holding it raises knowledge_has_it", async () => {
    const { gate3 } = await import("../services/reply-engine/gates");
    const g = (reply: string, incoming: string, knowledge: string) => gate3({ reply, claims: [], cards: [], candidateCount: 0, tools: [{ tool: "search_knowledge", decision: "allow", outcome: "ok" }], grounding: "", knowledge, locale: "he", incomingMessage: incoming, recentInbound: [incoming], isFirstReply: false, employeeGender: null, employeeName: "נועה", toolsOffered: ["search_knowledge"], shopFloor: false, handedOff: false, approvalPending: false, teamQuestion: incoming } as any).problems.map((x: any) => x.kind);
    expect(g("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מה אפשרויות התשלום?", K)).toContain("knowledge_has_it");
    // Not when the knowledge does not speak to it, nor for her own order, nor when the reply answers too.
    expect(g("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מה אפשרויות התשלום?", "משלוח חינם מעל 300 ש\"ח.")).not.toContain("knowledge_has_it");
    expect(g("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מה קורה עם ההזמנה שלי 48213?", K)).not.toContain("knowledge_has_it");
    // One shared word is not enough; her own order with a number never, even when the knowledge holds its words.
    expect(g("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מה שעות הפתיחה של החנות?", "החנות נמצאת ברחוב הרצל 5.")).not.toContain("knowledge_has_it");
    expect(g("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מה שעות הפתיחה של החנות?", "שעות הפתיחה של החנות: א-ה 9 עד 18.")).toContain("knowledge_has_it");
    const K2 = `${K} שאלה: מה עם תשלום ההזמנה? תשובה: תשלום ההזמנה נגבה בעת המסירה.`;
    expect(g("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מה עם תשלום ההזמנה שלי 48213?", K2)).not.toContain("knowledge_has_it");
    expect(g("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "יש לכם תשלום במזומן עם החבילה 4821?", K2)).not.toContain("knowledge_has_it");
    expect(g("אפשר לשלם בהעברה בנקאית. העברתי את השאלה על ביט לצוות.", "מה אפשרויות התשלום?", K)).not.toContain("knowledge_has_it");
  });
  it("★ the team question drops the earlier topic in front of her question", async () => {
    const { ownQuestionOnly } = await import("../services/reply-engine/engine");
    expect(ownQuestionOnly("לבדוק אם יש ג׳ינס או קפוצ׳ון: מה אפשרויות התשלום?", "מה אפשרויות התשלום?")).toBe("מה אפשרויות התשלום?");
    expect(ownQuestionOnly("החיוב כפול: הלקוחה שילמה פעמיים ומבקשת זיכוי", "שילמתי פעמיים")).toBe("החיוב כפול: הלקוחה שילמה פעמיים ומבקשת זיכוי");
    // Wired into the turn before the team question is recorded, and the leaning opener into the cut (source checks).
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/services/reply-engine/engine.ts", "utf8");
    expect(src.indexOf("if (final.teamQuestion) final = { ...final, teamQuestion: ownQuestionOnly(final.teamQuestion, String(opts.incomingMessage ?? \"\")) };")).toBeGreaterThan(0);
    expect(src.indexOf("ownQuestionOnly(final.teamQuestion")).toBeLessThan(src.indexOf("const newTeamQuestion = isNewTeamQuestion(final.teamQuestion)"));
    expect(src).toMatch(/if \(removed\.length\) \{ const op = withoutLeaningOpener\(cleaned\.reply\); if \(op !== cleaned\.reply\) \{ cleaned\.reply = op;/);
  });
});

describe("rating of b3d2bbf3, 4: an opener that leaned on a cut sentence", () => {
  it("★ \"יש גם\" and \"בינתיים\" lose the lean; the rest stays", async () => {
    const { withoutLeaningOpener } = await import("../services/reply-engine/engine");
    expect(withoutLeaningOpener("יש גם Penstick בגווני חום, אבל התיאור לא מציין שימוש מתחת לעיניים.")).toBe("יש Penstick בגווני חום, אבל התיאור לא מציין שימוש מתחת לעיניים.");
    expect(withoutLeaningOpener("בינתיים אפשר לראות את פרטי הטוש בעמוד המוצר: https://x.example/p")).toBe("אפשר לראות את פרטי הטוש בעמוד המוצר: https://x.example/p");
    // "גם" later in the sentence, and a reply that opens plainly, stay.
    expect(withoutLeaningOpener("יש משטח, וגם מעצור.")).toBe("יש משטח, וגם מעצור.");
    expect(withoutLeaningOpener("יש גמישות במשלוח.")).toBe("יש גמישות במשלוח.");
  });
});

describe("dev round k4 on 259d48ea", () => {
  const e = (q: string) => ({ tool: "woocommerce.list_products", args: { query: q }, outcome: "empty", content: "[]" }) as any;
  it("★ K4-1: an empty search in the other language backs the absence of exactly what was searched", async () => {
    const { ungroundedAbsence, sameAcrossLanguages } = await import("../services/reply-engine/gates");
    expect(ungroundedAbsence("לא מצאנו ג'ינס שחור בקטלוג.", [e("black jeans")])).toEqual([]);
    expect(ungroundedAbsence("לא מצאנו ג'ינס שחור בקטלוג.", [e("black hoodie")])).toHaveLength(1);
    expect(ungroundedAbsence("לא מצאנו ג'ינס שחור בקטלוג.", [e("jeans")])).toEqual([]);
    expect(sameAcrossLanguages("ג'ינס", "jeans")).toBe(true);
    expect(sameAcrossLanguages("טישרט", "tshirt")).toBe(true);
    expect(sameAcrossLanguages("מעיל", "mail")).toBe(false);
    expect(sameAcrossLanguages("ג'ינס", "gens")).toBe(false);
  });
  it("★ K4-2: the knowledge speaks to it by word stems", async () => {
    const { knowledgeSpeaksTo } = await import("../services/reply-engine/gates");
    const K = "אפשר לשלם בהעברה בנקאית או במזומן בעת המסירה. כרגע אין תשלום בכרטיס אשראי, בביט או ב-PayPal.";
    expect(knowledgeSpeaksTo("מה אפשרויות התשלום?", K)).toBe(true);
    expect(knowledgeSpeaksTo("מה אפשרויות המשלוח?", K)).toBe(false);
    expect(knowledgeSpeaksTo("מה שעות הפתיחה של החנות?", "החנות נמצאת ברחוב הרצל 5.")).toBe(false);
  });
  it("★ K4-3: an empty query with a filter of its own, or a sale or price ask, lists the store", async () => {
    const { searchHasFilter } = await import("../services/reply-engine/engine");
    expect(searchHasFilter({ query: "" }, "מה יש במבצע?")).toBe(true);
    expect(searchHasFilter({ query: "" }, "מה יש לכם עד 100 שקל?")).toBe(true);
    expect(searchHasFilter({ query: "", price_max: 100 }, "מה יש לכם?")).toBe(true);
    expect(searchHasFilter({ query: "", on_sale: true }, "תראו לי")).toBe(true);
    expect(searchHasFilter({ query: "" }, "אפשר המלצה על משהו שיתאים לי?")).toBe(false);
  });
  it("★ K4-4/5: no process wording; a pointer at items with no cards dangles", async () => {
    const { internalJargon, danglingReferences } = await import("../services/reply-engine/gates");
    expect(internalJargon("בחולצות שמופיעות אצלנו יש שמלת חולצה בצבע Sky, אבל לא מצוין אם הגוון הוא תכלת.")).toBe(true);
    expect(internalJargon("יש שמלת חולצה בצבע Sky, אבל לא מצוין אם הגוון הוא תכלת.")).toBe(true);
    expect(internalJargon("יש שמלת חולצה בצבע Sky.")).toBe(false);
    expect(danglingReferences("יש חולצות. למשל, חולצת כותנה אוקספורד קלאסית. המלאי והמחירים מופיעים בפריטים.", false)).toEqual(["המלאי והמחירים מופיעים בפריטים."]);
    expect(danglingReferences("המלאי והמחירים מופיעים בפריטים.", true)).toEqual([]);
  });
});
