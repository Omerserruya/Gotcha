import { describe, it, expect } from "vitest";
import {
  scoreConfidence,
  BULK_APPROVE_MIN_CONFIDENCE,
} from "../services/historical-intelligence/knowledge-clustering.stage";

/**
 * Historical knowledge is EVIDENCE, not truth.
 *
 * Human agents make mistakes, grant one-off exceptions, quote policies that
 * changed two years ago and contradict each other. A hundred conversations
 * repeating an outdated returns window is a hundred pieces of evidence for
 * something that is no longer true.
 *
 * These tests pin the arithmetic that decides what a person is asked to look at
 * and, more importantly, what may be swept in by a bulk approve without anybody
 * reading it.
 */

describe("confidence is computed, not asked of a model", () => {
  it("is reproducible for the same inputs", () => {
    // The number is shown to a customer and used to gate a bulk action. A score
    // an LLM invented could not be reproduced, audited, or explained to the
    // person being asked to trust it.
    const args = { occurrenceCount: 12, customerCount: 9, conflict: false };
    expect(scoreConfidence(args)).toBe(scoreConfidence(args));
  });

  it("weighs distinct customers above raw repetition", () => {
    // Ten customers told the same thing is far stronger evidence than one
    // customer told it ten times.
    const manyCustomers = scoreConfidence({
      occurrenceCount: 10,
      customerCount: 10,
      conflict: false,
    });
    const onePersistentCustomer = scoreConfidence({
      occurrenceCount: 10,
      customerCount: 1,
      conflict: false,
    });
    expect(manyCustomers).toBeGreaterThan(onePersistentCustomer);
  });

  it("compresses large counts so one popular question cannot dominate", () => {
    const twenty = scoreConfidence({ occurrenceCount: 20, customerCount: 20, conflict: false });
    const fourHundred = scoreConfidence({
      occurrenceCount: 400,
      customerCount: 400,
      conflict: false,
    });
    // The difference between 2 and 20 customers is real; between 200 and 400 it
    // is not, and a linear scale would drown everything else out.
    expect(fourHundred - twenty).toBeLessThan(0.2);
  });

  it("stays within 0 and 1 for any input, including nonsense", () => {
    for (const args of [
      { occurrenceCount: 0, customerCount: 0, conflict: false },
      { occurrenceCount: -5, customerCount: -5, conflict: false },
      { occurrenceCount: 1e6, customerCount: 1e6, conflict: false },
    ]) {
      const score = scoreConfidence(args);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("a contradiction caps confidence below the bulk-approve line", () => {
  it("keeps a conflicted candidate out of any bulk approve, however common", () => {
    // The whole point. The moment the business gave two answers, no amount of
    // repetition makes either one "confirmed", and a bulk approve that swept
    // one in would enshrine a coin flip as policy without anybody reading it.
    const veryCommonButConflicted = scoreConfidence({
      occurrenceCount: 5000,
      customerCount: 5000,
      conflict: true,
    });
    expect(veryCommonButConflicted).toBeLessThan(BULK_APPROVE_MIN_CONFIDENCE);
  });

  it("scores the same evidence higher when the business agreed with itself", () => {
    const agreed = scoreConfidence({ occurrenceCount: 40, customerCount: 30, conflict: false });
    const conflicted = scoreConfidence({ occurrenceCount: 40, customerCount: 30, conflict: true });
    expect(agreed).toBeGreaterThan(conflicted);
  });
});

describe("the bulk-approve threshold is meaningful", () => {
  it("excludes a single anecdote", () => {
    expect(
      scoreConfidence({ occurrenceCount: 2, customerCount: 1, conflict: false }),
    ).toBeLessThan(BULK_APPROVE_MIN_CONFIDENCE);
  });

  it("includes something a dozen different customers were told", () => {
    expect(
      scoreConfidence({ occurrenceCount: 18, customerCount: 12, conflict: false }),
    ).toBeGreaterThanOrEqual(BULK_APPROVE_MIN_CONFIDENCE);
  });

  it("sits strictly inside the range, so the gate can never be vacuous", () => {
    // A threshold of 0 would approve everything; one of 1 would approve
    // nothing and the button would silently do no work.
    expect(BULK_APPROVE_MIN_CONFIDENCE).toBeGreaterThan(0);
    expect(BULK_APPROVE_MIN_CONFIDENCE).toBeLessThan(1);
  });
});
