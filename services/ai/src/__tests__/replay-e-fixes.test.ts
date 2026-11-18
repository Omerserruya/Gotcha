/** The independent rating of the 1b35c535 prod replay (replay e, 2026-11-18): the units. Every rule generic. */
import { describe, it, expect } from "vitest";
import { storeQueryOf, explanationAsk, autoLookups, derivedMeasure, stripFactProblems, wantsItSettled, nameSizeLines, colourList, howToLink } from "../services/reply-engine/gates";
import { cutLine } from "../scripts/replay-v2";
import { oneTeamPass, withoutCheckedClaims, selfSearch, withClosingQuestion, withNewDetails } from "../services/reply-engine/engine";

const WOO = ["woocommerce.list_products", "search_knowledge"];
const q = (calls: any[]) => calls.map((c) => [c.function.name, JSON.parse(c.function.arguments).query]);

describe("1: the store is searched by her product words, never her sentence", () => {
  it("★ the question around the product goes", () => {
    expect(storeQueryOf("מאיזה חומר השרשרת?")).toBe("שרשרת");
    expect(storeQueryOf("יש משטחי במבוק?")).toBe("משטחי במבוק");
    expect(storeQueryOf("what material is the chain made of?")).toBe("chain");
    expect(storeQueryOf("המשטח מתאים לתמי 4?")).toBe("משטח לתמי 4");
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
