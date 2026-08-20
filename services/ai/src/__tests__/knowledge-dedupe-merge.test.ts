import { describe, it, expect } from "vitest";
import { mergeVariants, variantKey } from "../services/historical-intelligence/knowledge-dedupe.stage";

/**
 * Merging changes NUMBERS a reviewer acts on: the occurrence count feeds
 * confidence, and confidence decides what a bulk approve may sweep in. So the
 * two properties pinned here are the ones that would quietly mislead:
 *
 *   * two phrasings that got the SAME answer must collapse to one variant -
 *     otherwise merging would invent a conflict that does not exist and cap
 *     the item's confidence for no reason;
 *   * two phrasings that got DIFFERENT answers must both survive - that
 *     conflict is the single most valuable thing the import can surface, and
 *     hiding it during a cleanup would be the worst outcome of this stage.
 */

const member = (answer: string, occurrenceCount: number, variants?: unknown) => ({
  id: `c-${answer.slice(0, 4)}-${occurrenceCount}`,
  answer,
  editedAnswer: null,
  occurrenceCount,
  customerCount: occurrenceCount,
  conflict: false,
  variants: variants ?? null,
  firstSeenAt: null,
  lastSeenAt: null,
});

describe("merging two phrasings of one question", () => {
  it("collapses identical answers into a single variant and adds the counts", () => {
    const merged = mergeVariants([
      member("משלוח תוך 3-5 ימי עסקים.", 9),
      member("משלוח תוך 3-5 ימי עסקים", 4), // same answer, no full stop
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].occurrenceCount).toBe(13);
  });

  it("keeps genuinely different answers apart, richest first", () => {
    const merged = mergeVariants([
      member("משלוח תוך 3-5 ימי עסקים.", 4),
      member("משלוח תוך שבועיים.", 9),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].occurrenceCount).toBe(9);
    expect(merged.map((v) => v.answer)).toContain("משלוח תוך 3-5 ימי עסקים.");
  });

  it("carries existing variant lists through rather than flattening them to one", () => {
    const withVariants = member("ignored", 5, [
      { key: variantKey("א"), answer: "א", occurrenceCount: 3 },
      { key: variantKey("ב"), answer: "ב", occurrenceCount: 2 },
    ]);
    const merged = mergeVariants([withVariants, member("ב", 4)]);
    const b = merged.find((v) => v.answer === "ב");
    expect(merged).toHaveLength(2);
    expect(b?.occurrenceCount).toBe(6); // 2 from the list + 4 from the other row
  });

  it("caps at three variants - a fourth adds nothing a reviewer can act on", () => {
    const merged = mergeVariants([
      member("a", 5), member("b", 4), member("c", 3), member("d", 2), member("e", 1),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.map((v) => v.answer)).toEqual(["a", "b", "c"]);
  });
});

describe("variantKey", () => {
  it("treats punctuation and spacing differences as the same answer", () => {
    expect(variantKey("שעות: 9:00 - 17:00.")).toBe(variantKey("שעות 9:00 - 17:00"));
  });

  it("does not collapse answers that differ in substance", () => {
    expect(variantKey("3-5 ימי עסקים")).not.toBe(variantKey("14 ימי עסקים"));
  });
});
