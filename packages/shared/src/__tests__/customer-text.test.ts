/**
 * Outbox AI-signature sanitizer - the guarantee that no producer can put an
 * em dash (or other machine-signature punctuation) in front of a customer,
 * and that the sanitizer can NEVER alter a verified business fact.
 * Wired at the single outgoing-worker chokepoint every channel flows through.
 */
import { describe, it, expect } from "vitest";
import { sanitizeCustomerText, hasAiSignaturePunctuation } from "../lib/customer-text";

describe("sanitizeCustomerText", () => {
  it("strips em/en dashes and horizontal bars into natural punctuation", () => {
    for (const dash of ["—", "–", "―"]) {
      const out = sanitizeCustomerText(`ביצעתי את ההחזר ${dash} הכסף בדרך אליך`);
      expect(hasAiSignaturePunctuation(out)).toBe(false);
      expect(out).toContain(",");
    }
  });

  it("never alters business facts: amounts, currencies, order ids, dates survive verbatim", () => {
    const msg = "ההחזר על סך 600.00 USD עבור הזמנה #1004 יטופל עד 25.07.2026 — תודה";
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
    expect(sanitizeCustomerText("סיימנו —.")).toBe("סיימנו.");
  });

  it("null/undefined bodies become empty strings (media captions stay optional)", () => {
    expect(sanitizeCustomerText(null)).toBe("");
    expect(sanitizeCustomerText(undefined)).toBe("");
  });

  it("bypass visibility: hasAiSignaturePunctuation flags a body that skipped sanitization", () => {
    expect(hasAiSignaturePunctuation("raw model text — unsanitized")).toBe(true);
    expect(hasAiSignaturePunctuation("clean text, sanitized")).toBe(false);
  });
});
