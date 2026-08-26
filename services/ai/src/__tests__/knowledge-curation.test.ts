import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * The curation pass is where a tidy-looking regression is most likely to
 * happen: a model asked to clean up a list will happily shorten it, and the
 * thing it shortens first is whatever looks unusual - which is exactly the
 * content this whole rework exists to keep.
 */
const SRC = readFileSync("src/services/historical-intelligence/knowledge-curation.stage.ts", "utf8");

describe("curation cannot quietly discard the rare content", () => {
  it("tells the model outright that rarity is not a reason to drop", () => {
    expect(SRC).toContain("RARITY IS NOT A REASON TO DROP");
    // Not just a heading - the reasoning has to be in the prompt, because a
    // bare instruction is the easiest thing for a model to average away.
    expect(SRC).toMatch(/asked once .*worth exactly as much as one asked two hundred/);
    expect(SRC).toMatch(/unusual ones are what a new employee gets wrong/);
  });

  it("counts how many rare items it dropped, so a regression is a number", () => {
    for (const counter of ["singletonsSeen", "singletonsDropped"]) {
      expect(SRC, `${counter} must reach the stage event`).toContain(counter);
    }
    const detail = SRC.slice(SRC.indexOf("const detail = {"));
    expect(detail).toContain("singletonsSeen");
    expect(detail).toContain("singletonsDropped");
  });

  it("keeps an item when the model fails or stays silent about it", () => {
    // Losing knowledge because an LLM call failed is the worst available
    // failure mode, so silence must mean keep and never mean drop.
    expect(SRC).toMatch(/if \(!result\) \{\s*\n\s*unjudged \+= batch\.length;\s*\n\s*continue;/);
    expect(SRC).toMatch(/if \(!v\) \{[\s\S]{0,200}?unjudged \+= 1;\s*\n\s*continue;/);
  });

  it("does not blank a real answer when a rewrite verdict arrives with no rewrite", () => {
    expect(SRC).toMatch(/if \(!answer\) \{\s*\n\s*kept \+= 1;/);
  });
});

describe("the three faults it exists to fix are named in the prompt", () => {
  it("restates bare confirmations rather than deleting them", () => {
    // "Is there wine at the venue?" -> "sure" is real knowledge badly phrased.
    expect(SRC).toMatch(/bare confirmation is not an answer/i);
    expect(SRC).toContain("Never invent detail the business did not give");
  });

  it("keeps availability-dependent answers but marks them", () => {
    expect(SRC).toContain("live_data");
    expect(SRC).toMatch(/Do NOT drop these/);
    expect(SRC).toMatch(/must be confirmed/);
  });

  it("drops one customer's logistics and personal contact details", () => {
    expect(SRC).toMatch(/one customer's own logistics phrased as a question/);
    expect(SRC).toMatch(/named individual's phone number|personal contact details/);
  });
});

describe("ordering lets the duplicate verdict actually fire", () => {
  it("batches by category and topic, not by frequency", () => {
    const order = SRC.slice(SRC.indexOf("orderBy:"), SRC.indexOf("select: { id: true"));
    expect(order).toContain('category: "asc"');
    expect(order).toContain('topic: "asc"');
    expect(order).not.toContain("occurrenceCount");
  });
});
