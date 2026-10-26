/**
 * Omer's own test on dev (2026-10-26 08:17Z, tenant urban, employee מאיה): "זה
 * נשמע גרוע בעברית". Each reply of that transcript is caught here, word for word.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { checkReplyStyle, polishReply, repeatsChoice, menuSize, DONT_MIND } from "../services/reply-style-check.service";
import { discoveryStreak } from "../services/ai-bot.service";

const T = {
  c1: "היי",
  b1: "היי! מה מחפשים היום בחנות שלנו, בגד ספציפי, סגנון כללי או עזרה במידות?",
  c2: "אני מחפש מתנה לאשתי משהו איכותי טוב",
  b2: "נשמע שמחפשים מתנה איכותית לאשתך. איזה סוג פריט מעניין, שמלה, סריג, מעיל או אקססוריז (צעיף או תיק)?",
  c3: "לא משנה האמת רק שתהיה מבסוטית",
  b3: "מעולה, כדי להציע כמה אופציות שיתאימו לה, איזו קטגוריה להעדיף: שמלה, סריג, מעיל או אקססוריז (צעיף או תיק)?",
  c4: "מעיל",
  b4: "טוב, הנה כמה אופציות שיתאימו כמתנת מעיל: Cotton Trench Coat, Wool Blend Overcoat. איזה סגנון בדרך כלל, קלאסי ומחויט (כמו Wool Blend Overcoat) או קל־קל ומודרני (כמו Cotton Trench Coat)?",
};
const base = { locale: "he" as const, isFirstReply: false, productFactsAvailable: true, shopFloor: true, toolsOffered: ["woocommerce.list_products"], customerClosing: false };
const kinds = (draft: string, over: any) => checkReplyStyle(draft, { ...base, ...over }).map((v) => v.kind);

describe("AC7: a bare hello gets a hello, not a menu", () => {
  it("b1 is caught", () => expect(kinds(T.b1, { isFirstReply: true, incomingMessage: T.c1 })).toContain("menu_greeting"));
  it.each(["היי! מה מחפשים?", "היי, איך אפשר לעזור?"])("%s is fine", (r) => {
    expect(kinds(r, { isFirstReply: true, incomingMessage: T.c1 })).not.toContain("menu_greeting");
  });
});

describe("AC1 + AC2: לך-neutral, and no recap opener", () => {
  it("b2: a plural beside \"לאשתך\", and a \"נשמע ש\" opener", () => {
    const k = kinds(T.b2, { incomingMessage: T.c2, previousReplies: [T.b1] });
    expect(k).toContain("mixed_address");
    expect(k).toContain("recap_opener");
    expect(k).toContain("long_menu");
  });
  it("b3: \"מעולה, כדי להציע\" is a recap opener", () => {
    expect(kinds(T.b3, { incomingMessage: T.c3, previousReplies: [T.b1, T.b2] })).toContain("recap_opener");
  });
  it.each([
    "איזה כיף, מתנה לאשתך! מה בא לך, משהו חם לחורף או משהו קליל?",
    "יש לך כיוון, מעיל או סריג?",
    "מתאים לך משהו בסגנון קלאסי?",
  ])("the לך forms are clean: %s", (r) => {
    const k = kinds(r, { incomingMessage: T.c2 });
    expect(k).not.toContain("mixed_address");
    expect(k).not.toContain("gendered_address");
    expect(k).not.toContain("recap_opener");
  });
  it("the prompt, hebrew.md and the address block put לך first and the plural last", () => {
    const he = readFileSync(join(__dirname, "../prompts/hebrew.md"), "utf8");
    expect(he).toMatch(/1\. A לך construction/);
    expect(he).toMatch(/4\. The plural \("מחפשים\?"\) only as a last resort/);
    expect(he).toContain("נשמע שמחפשים מתנה לאשתך");
    const pb = readFileSync(join(__dirname, "../services/prompt-builder.service.ts"), "utf8");
    expect(pb).toMatch(/in this order: a לך construction/);
    const ga = readFileSync(join(__dirname, "../../../../packages/shared/src/lib/grammatical-address.ts"), "utf8");
    expect(ga).toMatch(/First choice, a לך construction/);
  });
});

describe("AC3: \"לא משנה\" means recommend, and the same choice is never asked twice", () => {
  it("c3 is the customer not minding", () => expect(DONT_MIND.test(T.c3)).toBe(true));
  it.each(["סתם מסתכלת", "תמליצי לי", "לא יודע", "מה שתמליצו"])("%s too", (t) => expect(DONT_MIND.test(t)).toBe(true));
  it("a real answer is not", () => expect(DONT_MIND.test("מעיל")).toBe(false));
  it("b3 repeats b2's category question in other words", () => {
    expect(repeatsChoice(T.b3, [T.b1, T.b2])).not.toBeNull();
    expect(kinds(T.b3, { incomingMessage: T.c3, previousReplies: [T.b1, T.b2] })).toContain("repeated_question");
  });
  it("a different question is not a repeat", () => {
    expect(repeatsChoice("מעיל ארוך או קצר?", [T.b2])).toBeNull();
  });
});

describe("AC4: two questions, then show; one question with at most two options", () => {
  const rows = [
    { direction: "INBOUND", body: T.c1 }, { direction: "OUTBOUND", body: T.b1, senderName: "AI Bot" },
    { direction: "INBOUND", body: T.c2 }, { direction: "OUTBOUND", body: T.b2, senderName: "AI Bot" },
  ];
  it("after b1 and b2, the streak is two: the next turn recommends", () => {
    expect(discoveryStreak(rows)).toBe(2);
    expect(discoveryStreak([...rows, { direction: "OUTBOUND", messageType: "product", body: "x" }])).toBe(0);
  });
  it("menus are counted", () => {
    expect(menuSize("איזה סוג פריט מעניין, שמלה, סריג, מעיל או אקססוריז (צעיף או תיק)?")).toBe(4);
    expect(menuSize("קלאסי או מודרני?")).toBe(2);
    expect(menuSize("מה בא לך?")).toBe(1);
  });
  it("the turn is wired: a note before generating, and one look if it asks anyway", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toMatch(/DONT_MIND\.test\(opts\.incomingMessage \?\? ""\) \|\| discoveryStreak\(messages as any\[\]\) >= 2/);
    expect(src).toMatch(/asked again instead of recommending: searching now/);
  });
});

describe("AC5 + AC6: no English titles in the Hebrew sentence; \"קל־קל\"", () => {
  const titles = ["Cotton Trench Coat", "Wool Blend Overcoat"];
  it("b4 is caught: two titles, a title in parentheses", () => {
    expect(kinds(T.b4, { incomingMessage: T.c4, productTitles: titles })).toContain("latin_titles");
  });
  it("the model's draft (PRODUCT keys) is caught too", () => {
    expect(kinds("הנה כמה אופציות: PRODUCT_1, PRODUCT_2. קלאסי או קליל?", { incomingMessage: T.c4 })).toContain("latin_titles");
    expect(kinds("מעיל צמר ארוך ואלגנטי, או טרנץ' קליל. מה מתאים לך?", { incomingMessage: T.c4, productTitles: titles })).not.toContain("latin_titles");
  });
  it("the polish drops a title in parentheses and mends \"קל־קל\"", () => {
    const out = polishReply("קלאסי ומחויט (כמו Wool Blend Overcoat) או קל־קל ומודרני (כמו Cotton Trench Coat)?", { locale: "he", productTitles: titles });
    expect(out).toBe("קלאסי ומחויט או קליל ומודרני?");
    expect(polishReply("בית־ספר", { locale: "he" })).toBe("בית ספר");
  });
});
