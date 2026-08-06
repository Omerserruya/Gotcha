/**
 * Optional setup must not be dressed as a prerequisite.
 *
 * A merchant connected a phone number and stopped, because the page they land
 * on the moment it connects showed two amber notices telling them to "create
 * one first" - an AI Employee and a pipeline funnel. Neither gates anything:
 * inbound routing reads `inbound_mode`, `default_agent_id`,
 * `fallback_department_id` and `ring_timeout_seconds`, and never looks at
 * `ai_agent_id` or the funnel. Calls ring without either.
 *
 * Amber is the colour this product uses for "something is wrong". Spending it
 * on "you could also do this" is how a finished setup reads as an unfinished
 * one.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Comments are stripped first: this is about the words a merchant reads, and
 * the comments here deliberately quote the copy being replaced.
 */
const PAGE = fs
  .readFileSync(path.resolve(__dirname, "../[id]/page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The two blocks that describe configuration a channel does not require. */
function optionalBlocks(src: string): string[] {
  return [
    src.slice(src.indexOf("aiAgents.length === 0"), src.indexOf("aiAgents.length === 0") + 500),
    src.slice(src.indexOf("funnels.length === 0"), src.indexOf("funnels.length === 0") + 500),
  ];
}

describe("the voice channel page", () => {
  it("does not tell a merchant to create optional things 'first'", () => {
    for (const block of optionalBlocks(PAGE)) {
      expect(block).not.toMatch(/\bfirst\b/i);
    }
  });

  it("does not use the warning colour for optional configuration", () => {
    for (const block of optionalBlocks(PAGE)) {
      expect(block).not.toContain("amber");
    }
  });

  it("says plainly that calls work without them", () => {
    expect(PAGE).toMatch(/none is needed for calls to work/i);
    expect(PAGE).toMatch(/Calls work without one/i);
  });

  it("marks both sections optional in their headings", () => {
    const optionalMarkers = PAGE.match(/>\s*optional\s*</gi) ?? [];
    expect(optionalMarkers.length).toBeGreaterThanOrEqual(2);
  });
});
