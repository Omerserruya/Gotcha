/**
 * Omer 2026-11-23: nothing is "passed to the team" any more. These are the detectors the end of the turn uses to turn
 * any such line into a real hand-over, pinned on the bot's own prod lines of 2026-11-16..23 (Alea, Tehila, Smoovee),
 * and on the lines they must never touch (a stock answer, the approved hand-over line, the engine's safety line).
 */
import { describe, it, expect } from "vitest";
import { claimsTeam, withoutTeamClaims, saysNotKnown, unlookedPass } from "../services/reply-engine/gates";

const HAND = "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.";
const PASSES = [
  "לגבי העובי, השאלה כבר ממתינה לתשובת הצוות.",
  "הבקשה לבדוק את הקופון עדיין בטיפול הצוות.",
  "העניין כבר בבדיקה אצלם, ונעדכן כאן בצ'אט.",
  "עדכון לגבי ה-40% והפער בסל עדיין ממתינים מהצוות.",
  "ההנחיות המעשיות למסירה או לאיסוף עדיין בבירור מול הצוות.",
  "הבירור על המבצע הספציפי עדיין פתוח מול הצוות.",
  "הצוות עדיין בודק אם סמובי אליס זמינה בשחור.",
  "אפשר לבדוק את זה מול הצוות.",
  "רוצה שאבדוק מול הצוות אם יש הנחת כמות?",
  "אפשר להעביר את השאלה לצוות כדי לקבל תשובה מדויקת.",
  "רוצים שאעביר את השאלה לצוות שיחזור אליכם?",
  "הצוות יבדוק את הזמנה #### ואת עדכון מספר הבית, ויענה כאן בצ'אט.",
  "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.",
  "אני כאן, ותשובת הצוות תגיע כאן בצ'אט ברגע שתהיה.",
  "זה עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.",
  "ולקבל מענה מהצוות כאן בצ'אט.",
  "החיוב עדיין בבדיקה.",
  "ההחזרה בבדיקה.",
  "בודקת את ההזמנה.",
];
const NOT_PASSES = [
  HAND,
  "העובי הוא 2.2-2.5 מ\"מ, והניקוי במטלית לחה בלבד.",
  "הצוות שלנו מעצב כל שטיח לפי מידה.",
  "המשלוח מגיע תוך 3-5 ימי עסקים.",
  "בדקנו את המלאי, ויש במידה M.",
  "A person from the team will continue with you here.",
];

describe("★ claimsTeam: every prod pass line, and none of the honest ones", () => {
  it("the 19 prod lines are team claims", () => { for (const l of PASSES) expect(claimsTeam(l), l).toBe(true); });
  it("an answer and the approved hand-over line are not", () => { for (const l of NOT_PASSES) expect(claimsTeam(l), l).toBe(false); });
  // The engine's safety line ("עד שנציג מהצוות יבדוק, מומלץ להפסיק להשתמש בזה.") is only ever sent on a hand-over turn,
  // where the end of the turn keeps it word for word (the "safety sticks" turn test pins that).
});

describe("★ withoutTeamClaims: the answer stays, the pass goes", () => {
  it("Alea, 23.11 12:05: the thickness and the care stay, the wait for the team goes", () => {
    expect(withoutTeamClaims("שטיח PVC למטבח מתאים גם לאזור הכיור והגז. העובי הוא 2.2-2.5 מ\"מ, והניקוי במטלית לחה בלבד. לגבי מניעת החלקה על שיש, קצוות ועמידות לכתמי שמן, עדיין ממתינים לתשובת הצוות."))
      .toBe("שטיח PVC למטבח מתאים גם לאזור הכיור והגז. העובי הוא 2.2-2.5 מ\"מ, והניקוי במטלית לחה בלבד.");
  });
  it("a keep-quiet promise goes with it; a pass alone leaves nothing", () => {
    expect(withoutTeamClaims("החיוב בבדיקה. נשאיר את זה בשקט ולא נשלח הודעות נוספות.")).toBe("");
    expect(withoutTeamClaims("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.")).toBe("");
  });
});

describe("★ saysNotKnown: \"I do not have that\", never \"not in stock\"", () => {
  it("the prod lines", () => {
    for (const l of ["אין לי כאן הסבר למה מוצגת הנחה של 37% במקום 40%.", "לא ידוע לנו מתי ההנחה של 40% תתעדכן באתר.", "גם למרכז אין מספר ימים קבוע שמופיע אצלנו.", "עדיין אין לנו מידע שמזהה את החלקים.", "לא ידוע לי איפה בדיוק נמצא טופס ההרשמה באתר.", "אין לי כאן הנחיה למיקום המעצורים."]) expect(saysNotKnown(l), l).toBe(true);
  });
  it("stock, sizes, a product absence and the engine's fit caveat are not", () => {
    for (const l of ["המידה הזו לא זמינה כרגע.", "אין לנו את הדגם הזה בשחור.", "הוא לא מופיע במלאי כרגע.", "לא מופיע אצלנו טוש חום שמצוין לשימוש מתחת לעיניים.", "אין לנו אישור שהם מתאימים בדיוק למה שביקשת.", "המוצר מופיע אצלנו באתר בשלושה צבעים."]) expect(saysNotKnown(l), l).toBe(false);
  });
});

describe("★ unlookedPass: no pass and no \"I don't know\" before the knowledge was searched this turn", () => {
  const kb = { tool: "search_knowledge", decision: "allow", content: "", outcome: "ok" } as any;
  it("a pass, a team question or a not-known with search_knowledge offered and not called", () => {
    expect(unlookedPass("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", [], ["search_knowledge"])).toBe(true);
    expect(unlookedPass("בטח.", [], ["search_knowledge"], true)).toBe(true);
    expect(unlookedPass("לא ידוע לנו מתי זה יתעדכן.", [], ["search_knowledge"])).toBe(true);
  });
  it("not after the search, not without the tool, and never on a plain answer", () => {
    expect(unlookedPass("העברתי את זה לצוות.", [kb], ["search_knowledge"])).toBe(false);
    expect(unlookedPass("העברתי את זה לצוות.", [], [])).toBe(false);
    expect(unlookedPass("המידה הזו לא זמינה כרגע.", [], ["search_knowledge"])).toBe(false);
  });
});

describe("★ D2b passCovered: answered means no pass (the prod lines)", () => {
  const ALEA_KB = "Q: מה עובי החומר פי וי סי? A: עובי החומר 2.2 - 2.5 מ\"מ. ניקוי: מטלית לחה בלבד. החומר עמיד לחום עד 70 מעלות. מתאים למטבח, גם לאזור הכיור והגז.";
  const ALEA_1205 = "שטיח PVC למטבח מתאים גם לאזור הכיור והגז. העובי הוא 2.2-2.5 מ\"מ, והניקוי במטלית לחה בלבד. לגבי מניעת החלקה על שיש, קצוות ועמידות לכתמי שמן, עדיין ממתינים לתשובת הצוות.";
  it("Alea 23.11 12:05: asked about the sink and the stove, answered from the knowledge; the pass is about what she did not ask now", async () => {
    const { passCovered } = await import("../services/reply-engine/gates");
    expect(passCovered(ALEA_1205, "אפשר לשים אותו ליד הכיור והגז?", null, ALEA_KB)).toBe(true);
  });
  it("the same reply when she asked about oil now: the pass is her question, so it is not covered (a hand-over)", async () => {
    const { passCovered } = await import("../services/reply-engine/gates");
    expect(passCovered(ALEA_1205, "והוא עמיד לכתמי שמן?", null, ALEA_KB)).toBe(false);
  });
  it("Alea 23.11 12:07: the thickness was given and it still waited for the team on it", async () => {
    const { passCovered } = await import("../services/reply-engine/gates");
    expect(passCovered("עובי החומר הוא 2.2-2.5 מ\"מ. לגבי העובי, השאלה כבר ממתינה לתשובת הצוות.", "מה העובי?", null, ALEA_KB)).toBe(true);
  });
  it("Smoovee 22.11 11:00: how to get the code answered; the form's place was never asked", async () => {
    const { passCovered } = await import("../services/reply-engine/gates");
    const kb = "איך מקבלים קוד הנחה? נרשמים לניוזלטר באתר, והקוד להטבה ברכישה הראשונה נשלח למייל.";
    const reply = "אפשר להירשם לניוזלטר באתר, והקוד להטבה ברכישה הראשונה נשלח למייל. לא ידוע לי איפה בדיוק נמצא טופס ההרשמה באתר, ואעביר לצוות את השאלה על מיקום ההרשמה.";
    expect(passCovered(reply, "איך מקבלים קוד הנחה?", null, kb)).toBe(true);
  });
  it("never when what is left is not in the business's texts, or nothing is left", async () => {
    const { passCovered } = await import("../services/reply-engine/gates");
    expect(passCovered("בדרך כלל זה מגיע מהר. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מתי זה מגיע?", null, "מדיניות החזרות: 14 יום.")).toBe(false);
    expect(passCovered("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", "מה העובי?", null, ALEA_KB)).toBe(false);
  });
  it("a team question on her own ask is not covered by an answer to something else", async () => {
    const { passCovered } = await import("../services/reply-engine/gates");
    expect(passCovered("עובי החומר הוא 2.2-2.5 מ\"מ.", "יש הנחה למשרתי מילואים?", "האם יש הנחה למשרתי מילואים?", ALEA_KB)).toBe(false);
  });
  it("shortFollowUp: a few words only", async () => {
    const { shortFollowUp } = await import("../services/reply-engine/gates");
    expect(shortFollowUp("והוא שקוף?")).toBe(true);
    expect(shortFollowUp("ומה העובי?")).toBe(true);
    expect(shortFollowUp("אני מחפשת משטח הזזה למיקסר הגדול שלי שעומד ליד הכיור במטבח")).toBe(false);
  });
});

describe("★ an order's or a payment's state with no lookup this turn is never sent (2026-11-23, the old hold masked it)", () => {
  it("the prod line, and the English one", async () => {
    const { orderStateUnlooked } = await import("../services/reply-engine/gates");
    expect(orderStateUnlooked("ההזמנה בוטלה כי התשלום לא נקלט.", [], ["תעדכנו בבקשה ושלחו לי מספר הזמנה"])).toEqual(["ההזמנה בוטלה כי התשלום לא נקלט."]);
    expect(orderStateUnlooked("התשלום לא עבר, אז כדאי לנסות שוב.", [], ["מה קורה?"])).toHaveLength(1);
    expect(orderStateUnlooked("Your order was shipped yesterday.", [], ["any news?"])).toHaveLength(1);
  });
  it("not after a lookup that answered, not when it repeats her own words, not on a policy sentence", async () => {
    const { orderStateUnlooked } = await import("../services/reply-engine/gates");
    const ok = [{ tool: "woocommerce.get_order", outcome: "ok", content: "{\"status\":\"cancelled\"}" } as any];
    expect(orderStateUnlooked("ההזמנה בוטלה.", ok, ["מה עם ההזמנה?"])).toEqual([]);
    expect(orderStateUnlooked("מבינים שההזמנה בוטלה, מצטערים.", [], ["ההזמנה בוטלה בלי שביקשתי"])).toEqual([]);
    expect(orderStateUnlooked("משלוחים יוצאים בימים א עד ה.", [], ["מתי שולחים?"])).toEqual([]);
  });
});

describe("★ the 551794cd replay's last three (2026-11-23)", () => {
  it("1: a connector a cut left hanging goes (ו, אבל, אז, כי, לכן), and only at a sentence end", async () => {
    const { dropDanglingConnectors } = await import("../services/reply-engine/gates");
    expect(dropDanglingConnectors("מצטערים על הבלבול. אין לנו מידע מתי ההנחה תופיע באתר, אז.")).toBe("מצטערים על הבלבול. אין לנו מידע מתי ההנחה תופיע באתר.");
    for (const c of ["ו", "אבל", "אז", "כי", "לכן", "ולכן"]) expect(dropDanglingConnectors(`אין לנו מידע על זה, ${c}`), c).toBe("אין לנו מידע על זה");
    expect(dropDanglingConnectors("אין לנו מידע על זה, אז. אפשר להזמין באתר.")).toBe("אין לנו מידע על זה. אפשר להזמין באתר.");
    // Never a connector inside a sentence, or a word that ends with those letters.
    expect(dropDanglingConnectors("אז מה מתאים לך? כי זה תלוי במידה.")).toBe("אז מה מתאים לך? כי זה תלוי במידה.");
    expect(dropDanglingConnectors("זה מגיע מאז.")).toBe("זה מגיע מאז.");
  });
  it("2: \"זה עץ?\" is a question about the product itself", async () => {
    const { productFactQuestion } = await import("../services/reply-engine/gates");
    expect(productFactQuestion("היי אשמח לדעת המשטח בגוון במבוק כהה זה עץ ? והיכן ניתן לראות את צורת מבנה הגלגלים ?")).toBe(true);
    expect(productFactQuestion("יש לכם משטח למיקסר?")).toBe(false);
  });
  it("3: a not-known she never asked for goes; the rest stays", async () => {
    const { withoutUnaskedNotKnown, saysNotKnown } = await import("../services/reply-engine/gates");
    const v2 = "לא נמסר אם יש הנחה מיוחדת בקנייה של כמה משטחים. כדאי להירשם לניוזלטר באתר כדי להתעדכן במבצעים ובהטבות.";
    expect(saysNotKnown(v2)).toBe(true);
    expect(withoutUnaskedNotKnown(v2)).toBe("כדאי להירשם לניוזלטר באתר כדי להתעדכן במבצעים ובהטבות.");
  });
});

describe("★ the 01c861e0 replay (2026-11-23): a material only from the data; no invented offer question", () => {
  const SPEC = "מפרט טכני בסיס : פרספקס גלגלים : פלדת אל חלד מכוסה פלסטיק רוחב : 34 ס\"מ";
  it("\"כן, משטח הבמבוק עשוי מעץ\" against \"בסיס: פרספקס\" is contradicted; the true sentence is not", async () => {
    const { materialClaimContradicted, ungroundedAttribute } = await import("../services/reply-engine/gates");
    expect(materialClaimContradicted("כן, משטח הבמבוק עשוי מעץ.", SPEC)).toBe(true);
    expect(materialClaimContradicted("הגוון במבוק כהה הוא מראה של עץ, אבל המשטח עצמו עשוי מפרספקס.", SPEC)).toBe(false);
    expect(materialClaimContradicted("הגלגלים עשויים פלדת אל חלד.", SPEC)).toBe(false);
    // No field: the word must be in the data at all.
    expect(materialClaimContradicted("התיק עשוי מעור.", "Canvas Tote, בד קנבס עבה.")).toBe(true);
    expect(materialClaimContradicted("התיק עשוי מבד קנבס.", "Canvas Tote, בד קנבס עבה.")).toBe(false);
    expect(ungroundedAttribute("כן, משטח הבמבוק עשוי מעץ. אפשר להזמין באתר.", SPEC, "המשטח בגוון במבוק כהה זה עץ ?")).toEqual(["כן, משטח הבמבוק עשוי מעץ."]);
  });
  it("\"see the pictures on the site\" with no link hands the work back; with a link it is an answer", async () => {
    const { claimsTeam } = await import("../services/reply-engine/gates");
    expect(claimsTeam("אפשר לראות תמונות של המשטחים באתר סמובי.")).toBe(true);
    expect(claimsTeam("אפשר לראות את כל הצבעים כאן: https://smoovee-ltd.com/he/product/alice/")).toBe(false);
  });
  it("the offer question she never asked goes; one she raised stays", async () => {
    const { withoutInventedOfferQuestion } = await import("../services/reply-engine/gates");
    const v2 = "היי, בכיף. יש הנחה מיוחדת בקנייה של כמה משטחים? אילו משטחים מעניינים אותך?";
    expect(withoutInventedOfferQuestion(v2, ["הי אני מתעניינת בכמה משטחים"])).toBe("היי, בכיף. אילו משטחים מעניינים אותך?");
    expect(withoutInventedOfferQuestion(v2, ["יש הנחה אם קונים כמה?"])).toBe(v2);
  });
});

describe("★ a colour's catalogue names ground it, once her words no longer do (2026-11-23)", () => {
  it("\"פירסט קופי\" / \"first coffee\" is brown; a black title is not", async () => {
    const { ungroundedAttribute } = await import("../services/reply-engine/gates");
    expect(ungroundedAttribute("העיפרון הזה בגוון חום.", "קיט בייסיק לשפתיים ועיפרון פירסט קופי")).toEqual([]);
    expect(ungroundedAttribute("העיפרון הזה בגוון חום.", "עיפרון first coffee")).toEqual([]);
    expect(ungroundedAttribute("העיפרון הזה בגוון חום.", "עיפרון שחור")).toEqual(["העיפרון הזה בגוון חום."]);
  });
});
