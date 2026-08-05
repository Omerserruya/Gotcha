/**
 * Outbox AI-signature sanitizer - the guarantee that no producer can put an
 * em dash (or other machine-signature punctuation) in front of a customer,
 * and that the sanitizer can NEVER alter a verified business fact.
 * Wired at the single outgoing-worker chokepoint every channel flows through.
 */
// The wide dash as an ESCAPE, so a find-replace over this repo can never
// again turn these fixtures into plain hyphens and make the tests assert
// the opposite of what their names say.
const EM = "\u2014";
import { describe, it, expect } from "vitest";
import { sanitizeCustomerText, hasAiSignaturePunctuation } from "../lib/customer-text";

describe("sanitizeCustomerText", () => {
  it("strips em/en dashes and horizontal bars into natural punctuation", () => {
    for (const dash of ["\u2014", "\u2013", "\u2015"]) {
      const out = sanitizeCustomerText(`ביצעתי את ההחזר ${dash} הכסף בדרך אליך`);
      expect(hasAiSignaturePunctuation(out)).toBe(false);
      expect(out).toContain(",");
    }
  });

  it("never alters business facts: amounts, currencies, order ids, dates survive verbatim", () => {
    const msg = `\u05d4\u05d4\u05d7\u05d6\u05e8 \u05e2\u05dc \u05e1\u05da 600.00 USD \u05e2\u05d1\u05d5\u05e8 \u05d4\u05d6\u05de\u05e0\u05d4 #1004 \u05d9\u05d8\u05d5\u05e4\u05dc \u05e2\u05d3 25.07.2026 ${EM} \u05ea\u05d5\u05d3\u05d4`;
    const out = sanitizeCustomerText(msg);
    expect(out).toContain("600.00 USD");
    expect(out).toContain("#1004");
    expect(out).toContain("25.07.2026");
    expect(hasAiSignaturePunctuation(out)).toBe(false);
  });

  it("regular hyphens (phone numbers, SKUs, ranges) are untouched", () => {
    const msg = "הקוד שלך: COMP-2026, טלפון 054-5680665";
    expect(sanitizeCustomerText(msg)).toBe(msg);
  });

  it("tidies substitution artifacts instead of leaving ', .' fragments", () => {
    expect(sanitizeCustomerText(`\u05e1\u05d9\u05d9\u05de\u05e0\u05d5 ${EM}.`)).toBe("\u05e1\u05d9\u05d9\u05de\u05e0\u05d5.");
  });

  it("null/undefined bodies become empty strings (media captions stay optional)", () => {
    expect(sanitizeCustomerText(null)).toBe("");
    expect(sanitizeCustomerText(undefined)).toBe("");
  });

  it("bypass visibility: hasAiSignaturePunctuation flags a body that skipped sanitization", () => {
    expect(hasAiSignaturePunctuation(`raw model text ${EM} unsanitized`)).toBe(true);
    expect(hasAiSignaturePunctuation("clean text, sanitized")).toBe(false);
  });

  // Numeric-range corruption (2026-07-21 snowboard-sizing incident): the
  // wide-dash sanitizer turned "156–162 ס״מ" into "156, 162 ס״מ".
  it("preserves numeric ranges instead of turning them into commas (19/20/21)", () => {
    expect(sanitizeCustomerText('חפש לוח בטווח 156–162 ס"מ')).toBe('חפש לוח בטווח 156-162 ס"מ');
    expect(sanitizeCustomerText("2–3 אופציות")).toBe("2-3 אופציות");
    expect(sanitizeCustomerText(`\u05d3\u05d9\u05e8\u05d5\u05d2 5 ${EM} 7 \u05de\u05ea\u05d5\u05da 10`)).toBe("\u05d3\u05d9\u05e8\u05d5\u05d2 5-7 \u05de\u05ea\u05d5\u05da 10");
    expect(sanitizeCustomerText("English 160-165 range")).toBe("English 160-165 range");
  });

  it("normalizes range dashes to a plain hyphen so they pass the AI-signature check", () => {
    const out = sanitizeCustomerText("156–162");
    expect(out).toBe("156-162");
    expect(hasAiSignaturePunctuation(out)).toBe(false);
  });

  it("still converts an em-dash used as a clause connector (not a range) to a comma", () => {
    expect(sanitizeCustomerText(`\u05d0\u05e9\u05de\u05d7 \u05dc\u05e2\u05d6\u05d5\u05e8 ${EM} \u05de\u05ea\u05d9 \u05e0\u05d5\u05d7 \u05dc\u05da`)).toBe("\u05d0\u05e9\u05de\u05d7 \u05dc\u05e2\u05d6\u05d5\u05e8, \u05de\u05ea\u05d9 \u05e0\u05d5\u05d7 \u05dc\u05da");
  });
});
