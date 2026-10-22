import { describe, expect, it } from 'vitest';

import { toolUsageSchema, neverFailed } from './capabilities';
import { importListSchema } from './historical-import';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE SWEEP: EVERY THREE-STATE DISTINCTION ASSERTED AT THE PARSE
 * ════════════════════════════════════════════════════════════════════════════
 * A distinction between "none" and "nobody could tell us" lives in a SCHEMA.
 * If every test of it hands a component a value directly, the schema is
 * untested and the mutation that collapses the distinction passes - which is
 * not a gap in coverage but **coverage pointed at the wrong layer, reported
 * as coverage of the right one.**
 *
 * Found when swapping `undatedCount`'s `.optional()` for `.default(0)` broke
 * nothing: every test passed the value straight into the component.
 *
 * This file holds the fields whose distinction had **no** parse-level
 * assertion anywhere. The rest were already covered where they live.
 */

describe('★★ `toolUsage` - the counters behind "never failed"', () => {
  it('★★ a service that reports neither counter cannot support the claim', () => {
    /*
     * THE DEFECT THIS SWEEP FOUND, AND IT WAS MINE.
     *
     * Both counters shipped as `.default(0)`. A service that does not report
     * them - every service older than the field - parsed to zeroes, and
     * `neverFailed` returned **true**: the screen printed *"never failed"*,
     * which is the exact caption the three-state function exists to prevent.
     *
     * I built the function and defaulted the third state away at the parse,
     * one file over.
     */
    const silent = toolUsageSchema.parse({ toolName: 't', executionCount: 612 });
    expect(silent.erroredCount).toBeUndefined();
    expect(silent.unclassifiedFailureCount).toBeUndefined();
    expect(neverFailed(silent)).toBeNull();
  });

  it('★ either counter missing is enough to make the claim unsayable', () => {
    // "Never failed" needs BOTH to be zero. With one absent we would be
    // asserting it.
    const half = toolUsageSchema.parse({ toolName: 't', erroredCount: 0 });
    expect(neverFailed(half)).toBeNull();
    const other = toolUsageSchema.parse({ toolName: 't', unclassifiedFailureCount: 0 });
    expect(neverFailed(other)).toBeNull();
  });

  it('★ a service that reports both, as zeroes, CAN support it', () => {
    const clean = toolUsageSchema.parse({
      toolName: 't',
      erroredCount: 0,
      unclassifiedFailureCount: 0,
    });
    expect(neverFailed(clean)).toBe(true);
  });

  it('and a real error is still a failure', () => {
    const broken = toolUsageSchema.parse({
      toolName: 't',
      erroredCount: 2,
      unclassifiedFailureCount: 0,
    });
    expect(neverFailed(broken)).toBe(false);
  });
});

describe('★ `importList` - required, so absence is not "no imports"', () => {
  it('★★ a body without `imports` FAILS rather than reading as none', () => {
    /*
     * Screen 08 reads this to decide `everImported`, which separates
     * "nothing contradicted itself" from "nobody has checked". An absent
     * `imports` defaulting to `[]` would say nobody has ever imported, on a
     * response that did not answer - collapsing the very distinction the
     * field was added for.
     */
    expect(() => importListSchema.parse({})).toThrow();
    expect(importListSchema.parse({ imports: [] }).imports).toEqual([]);
  });
});
