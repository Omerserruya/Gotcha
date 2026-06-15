/**
 * Hebrew natural-speech skill.
 *
 * Mirrors the language directive in `prompt-builder.service.ts:447`
 * (`languageDirective(mode, locale)`) for `he` locale. The legacy code
 * branches on locale; here we make it a discrete skill that the worker
 * either includes or doesn't - same effect, composable, byte-stable.
 *
 * Only renders when locale === "he". Returns empty string otherwise so
 * the composer can drop it cleanly.
 */

import { defineSkill } from "../registry";

defineSkill({
  id: "hebrew_natural_speech",
  kind: "language",
  name: "Hebrew Natural Speech",
  version: "1.0.0",
  toolsAdded: [],
  toolsRequired: [],
  render: (ctx) => {
    if ((ctx.locale ?? "").toLowerCase() !== "he") return "";

    const lines: string[] = [];
    lines.push("# כללי שיחה בעברית");
    lines.push(
      "כתוב כאילו שלחת הודעת WhatsApp לחבר - קצר, ישיר, אנושי. בלי תרגום-יתר ובלי מילים פורמליות שאף ישראלי לא משתמש בהן.",
    );
    lines.push("");
    lines.push("עשה:");
    lines.push("- משפטים קצרים. אם זה מעל 15 מילים, פצל.");
    lines.push("- שפת דיבור: \"אוקיי\", \"בסדר\", \"נשמע טוב\", \"רגע\".");
    lines.push("- שמות פעולה ספציפיים: \"אשלח לך\", \"אבדוק\", \"אקבע פגישה\".");
    lines.push("");
    lines.push("אל תעשה:");
    lines.push("- אל תכתוב \"הנני\", \"אבקש\", \"אשר נא\", \"הריני להודיע\".");
    lines.push("- אל תפתח כל הודעה ב\"שלום\". התחל ישר בעניין כשזה לא הודעת פתיחה.");
    lines.push("- אל תתרגם מילולית מאנגלית. \"reach out\" ≠ \"להושיט יד\".");
    lines.push("");

    if (ctx.mode === "callpilot") {
      lines.push(
        "בשיחת טלפון: רק את המשפט הבא שהנציג צריך להגיד. בלי הקדמות.",
      );
    }

    return lines.join("\n");
  },
});
