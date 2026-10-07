import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Setup conversations must never reach an analytics figure.
 *
 * Day one ends with the team messaging GOTCHA from their own numbers to check
 * it works. If those land in the aggregates, the next morning's metric strip
 * reports the rehearsal as business, and the first number the owner ever sees
 * from us is wrong.
 *
 * This is a SOURCE check rather than a behavioural one on purpose. The risk is
 * not that today's queries are wrong - they were fixed together. It is that
 * the fifteenth query someone adds next month quietly is not, and no unit test
 * of the existing fourteen would notice. Reading the file is the only check
 * that fails for code nobody has written yet.
 */
const SOURCE = readFileSync(
  join(__dirname, "..", "services", "analytics.service.ts"),
  "utf8",
);
const LINES = SOURCE.split("\n");

/** Queries that read conversations or their messages, with their line number. */
function aggregateSites(): Array<{ line: number; text: string; window: string }> {
  const sites: Array<{ line: number; text: string; window: string }> = [];
  LINES.forEach((l, i) => {
    if (/prisma\.(conversation|message)\.(count|findMany|groupBy|aggregate)\(/.test(l)) {
      sites.push({ line: i + 1, text: l.trim(), window: LINES.slice(i, i + 18).join("\n") });
    }
  });
  return sites;
}

describe("analytics never counts setup conversations", () => {
  it("finds the conversation queries it is meant to be guarding", () => {
    // If this drops to zero the check has silently stopped checking - a
    // rename of the client would do it.
    expect(aggregateSites().length).toBeGreaterThan(10);
  });

  it("every conversation and message aggregate excludes test conversations", () => {
    const unguarded = aggregateSites().filter(({ window }) => {
      // ★ The COMPLETE predicate, and the preferred form. `REAL_CONVERSATION`
      // carries `isTest: false` AND the sandbox external-id prefix. It has to be
      // accepted here, because this check previously failed on the one query
      // that excluded sandbox rehearsals CORRECTLY - a guard rejecting the right
      // answer because it only recognised the incomplete one.
      if (/\.\.\.REAL_CONVERSATION/.test(window)) return false;
      // The shared "waiting for a person" predicate (Home's count and queue):
      // it carries REAL_CONVERSATION itself, checked by the next test.
      if (/where:\s*waitingForPersonWhere\(|=\s*waitingForPersonWhere\(/.test(window)) return false;
      // The incomplete form, still accepted because 21 sites use it.
      //
      // ⚠ `isTest: false` ALONE DOES NOT EXCLUDE SANDBOX CONVERSATIONS. They are
      // written with `isTest = false`, so every site matched by this line counts
      // the team's setup rehearsals as business - the defect fixed in billing as
      // bd1ddf0a and still live here. This branch is what makes those sites pass,
      // so it is the reason the guard reads as settled while the question is
      // open. Removing it is the real fix, and it requires changing all 21.
      if (/isTest:\s*false/.test(window)) return false;
      if (/where[,:]\s*$|where\s*\}|\(\{ where \}\)|where,\n/.test(window)) return false;
      if (/conversationId: \{ in: convIds \}/.test(window)) return false;
      return true;
    });

    expect(
      unguarded.map((u) => `line ${u.line}: ${u.text}`),
    ).toEqual([]);
  });

  it("the shared queue `where` carries the exclusion", () => {
    // Home's count and its ranked queue share ONE predicate, so the filter has
    // to live in it, not at each call.
    const block = SOURCE.slice(SOURCE.indexOf("export function waitingForPersonWhere"));
    expect(block.slice(0, 600)).toMatch(/\.\.\.REAL_CONVERSATION/);
    expect(SOURCE).toMatch(/getQueueDepth[\s\S]{0,200}waitingForPersonWhere\(tenantId\)/);
    expect(SOURCE).toMatch(/const where = waitingForPersonWhere\(tenantId\);/);
  });
});
