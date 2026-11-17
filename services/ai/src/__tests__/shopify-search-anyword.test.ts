/**
 * Shopify search: every word must match, so a multi-word query can find nothing in a
 * store that sells the thing (prod replay 2026-11-17, a snowboard store). Any word next.
 */
import { describe, it, expect } from "vitest";
import { escapeAnyWord } from "../services/connectors/shopify.adapter";

describe("Shopify any-word fallback", () => {
  it("★ a word is a word: Shopify's search syntax characters are removed", () => {
    expect(escapeAnyWord("snowboard")).toBe("snowboard");
    expect(escapeAnyWord("title:x")).toBe("title");
    expect(escapeAnyWord("(beginner)")).toBe("beginner");
    expect(escapeAnyWord("a*b")).toBe("a");
  });
});
