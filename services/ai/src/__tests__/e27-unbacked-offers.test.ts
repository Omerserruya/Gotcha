/**
 * P4: an offer must be something the bot can do, or the team.
 * Tehila 15:40 "נוכל לבדוק עבורך איזה חומר בכל דגם, להמשיך?"; cmw4lyhod
 * "לשלוח הוראות מדויקות לתיבת וואטסאפ או אימייל?"; Smoovee "לבדוק אפשרות
 * להזמנה מראש?"; and "איזה צבע מעניין אותך?" over single-colour surfaces.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unbackedOffer, shownOptionsOf } from "../services/reply-style-check.service";

const TEAM = "רוצים שאעביר את השאלה לצוות שיחזור אליכם?";
const he = (reply: string, extra: any = {}) => unbackedOffer(reply, { locale: "he", canHandOver: true, ...extra });

describe("an offer the bot cannot carry out", () => {
  it("becomes the team offer", () => {
    for (const r of [
      "השרשראות עדינות ויפות. נוכל לבדוק עבורך איזה חומר בכל דגם, להמשיך?",
      "זה פשוט לקשור. לשלוח הוראות מדויקות לתיבת וואטסאפ או אימייל?",
      "כרגע לא מצאתי. לבדוק אפשרות להזמנה מראש?",
      "אזל מהמלאי. רוצים שאעדכן אתכם כשיחזור?",
    ]) {
      const u = he(r);
      expect(u.kind).toBe("offer");
      expect(u.text.endsWith(TEAM)).toBe(true);
      expect(u.text).not.toMatch(/וואטסאפ|מראש|אעדכן|נוכל לבדוק/);
    }
  });
  it("without a hand-over on the turn, it is dropped", () => {
    expect(he("זה פשוט לקשור. לשלוח הוראות לוואטסאפ?", { canHandOver: false }).text).toBe("זה פשוט לקשור.");
  });
  it("a real question stays", () => {
    for (const r of ["יש לנו כמה מטפחות. לאירוע או ליום יום?", "המחיר 139 ש\"ח. רוצים שאעביר את השאלה לצוות?", "מצאתי שתיים. איזו מידה מתאימה לך?"]) {
      expect(he(r, { shownOptions: { colours: true, sizes: true } }).kind).toBeNull();
    }
  });
});

describe("a colour or size question over products that come in one", () => {
  it("is dropped when none shown has more than one", () => {
    const shown = shownOptionsOf(["מתאים ל: · תמי 4", "בסיס: פרספקס · גלגלים: פלדה"]);
    expect(shown).toEqual({ colours: false, sizes: false });
    expect(he("שני משטחים שמתאימים ל-Vertuo. איזה צבע מעניין אותך?", { shownOptions: shown })).toEqual({ text: "שני משטחים שמתאימים ל-Vertuo.", kind: "choice" });
  });
  it("stays when one does", () => {
    const shown = shownOptionsOf(["צבע: אדום, כחול · עשוי כותנה"]);
    expect(shown.colours).toBe(true);
    expect(he("יש לנו את זה. איזה צבע מעניין אותך?", { shownOptions: shown }).kind).toBeNull();
  });
});

describe("the bot applies it before the final checks", () => {
  it("with the turn's hand-over and the shown products' options", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain('const u = unbackedOffer(replyText, { locale: replyLocale, canHandOver: toolFunctionNames.includes("escalate_to_human"), shownOptions: shown });');
    expect(src.indexOf("const u = unbackedOffer(")).toBeLessThan(src.indexOf('markStage("checker_done");'));
  });
});
