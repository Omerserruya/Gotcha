/** P6 (Tehila): "רוצים שאנחם אתכם" (console, not guide) and "להתאם איסוף" (no such word). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixHebrewForms, polishReply } from "../services/reply-style-check.service";

describe("Hebrew verb forms fixed in code", () => {
  it("her two", () => {
    expect(fixHebrewForms("רוצים שאנחם אתכם בבחירה?")).toBe("רוצים שאנחה אתכם בבחירה?");
    expect(fixHebrewForms("אפשר להתאם איסוף מהסטודיו.")).toBe("אפשר לתאם איסוף מהסטודיו.");
    expect(fixHebrewForms("אשמח לאנחם אותך")).toBe("אשמח לאנחם אותך"); // not the pattern: left
  });
  it("a real use of the word is left", () => {
    expect(fixHebrewForms("ניסיתי לנחם אותה")).toBe("ניסיתי לנחם אותה");
    expect(fixHebrewForms("אנחם את עצמי")).toBe("אנחם את עצמי");
    expect(fixHebrewForms("להתאים את המידה")).toBe("להתאים את המידה");
  });
  it("on every reply: polishReply and the bot's last checks", () => {
    expect(polishReply("רוצים שאנחם אתכם?", { locale: "he" })).toContain("שאנחה אתכם");
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("const fixed = fixHebrewForms(replyText);");
  });
});
