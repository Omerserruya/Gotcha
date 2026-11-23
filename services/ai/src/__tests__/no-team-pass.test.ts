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
