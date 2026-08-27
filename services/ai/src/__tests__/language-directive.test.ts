import { describe, it, expect } from "vitest";
import { languageDirective, resolvePromptLanguage } from "../services/historical-intelligence/stage-utils";

/**
 * "Write every generated field in Hebrew" is true of prose and false of a field
 * whose value must match a fixed list. The model translated the `category` enum
 * and 185 of 199 items were coerced to OTHER, destroying the grouping the whole
 * rework exists to provide. It hid for two full pipeline runs because an invalid
 * enum used to fail the call and the retry quietly fixed it.
 */
describe("languageDirective", () => {
  it("exempts fixed-value fields from translation", () => {
    const d = languageDirective("Hebrew");
    expect(d).toMatch(/fixed list of allowed values/i);
    expect(d).toMatch(/EXACT value from the list, in English/);
    expect(d).toMatch(/Never translate these/i);
    // The enums by name, so a reader of the prompt knows which fields are meant.
    expect(d).toContain("category");
    expect(d).toContain("scope");
  });

  it("still asks for prose in the tenant's language", () => {
    const d = languageDirective("Hebrew");
    expect(d).toContain("Hebrew");
    expect(d).toMatch(/questions, answers, topics, reasoning/);
  });

  it("still exempts verbatim quotes", () => {
    expect(languageDirective("Hebrew")).toMatch(/copy them exactly as written/);
  });

  it("does not claim EVERY field follows the language", () => {
    // The exact wording that caused this. If it comes back, so does the bug.
    expect(languageDirective("Hebrew")).not.toMatch(/every generated field in/i);
  });

  it("falls back to English for an unknown locale", () => {
    expect(resolvePromptLanguage("klingon")).toBe("English");
    expect(resolvePromptLanguage("he")).toBe("Hebrew");
  });
});
