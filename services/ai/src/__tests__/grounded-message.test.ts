/**
 * Grounding regression suite for post-execution customer messages.
 *
 * Live incident locked in: post-approval continuations were generated on a
 * raw oneshot path - em-dashes reached customers and nothing checked the text
 * against the verified execution result. These tests pin the validator and
 * the deterministic fallback that every execution message now flows through.
 */
import { describe, it, expect } from "vitest";
import {
  validateGroundedMessage,
  buildFallbackMessage,
  type ExecutionFacts,
} from "../services/grounded-message.service";

const REFUND_OK: ExecutionFacts = {
  tool: "shopify.process_refund",
  outcome: "succeeded",
  orderName: "#1004",
  amount: 600,
  currency: "USD",
  status: "processed",
};

describe("validateGroundedMessage", () => {
  it("accepts a faithful message", () => {
    const v = validateGroundedMessage("ההחזר על סך 600.00 USD עבור הזמנה #1004 בוצע בהצלחה.", REFUND_OK);
    expect(v.ok).toBe(true);
  });

  it("rejects em dashes (AI-signature punctuation must not reach customers)", () => {
    const v = validateGroundedMessage("ביצעתי את ההחזר — 600.00 USD יוחזרו אליך.", REFUND_OK);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("em_dash_present");
  });

  it("rejects a changed amount", () => {
    const v = validateGroundedMessage("החזר של 500.00 USD עבור הזמנה #1004 בוצע.", REFUND_OK);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("amount_missing");
  });

  it("rejects an extra contradicting amount alongside the right one", () => {
    const v = validateGroundedMessage("החזר של 600.00 USD בוצע, ותקבל גם 50 USD פיצוי.", REFUND_OK);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("contradicting_number_present");
  });

  it("rejects a wrong order reference", () => {
    const v = validateGroundedMessage("החזר של 600.00 USD עבור הזמנה #1005 בוצע.", REFUND_OK);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("wrong_order_reference");
  });

  it("a PENDING refund must never read as completed (Hebrew)", () => {
    const v = validateGroundedMessage(
      "ההחזר של 600.00 USD בוצע בהצלחה והכסף חזר אליך.",
      { ...REFUND_OK, status: "pending" },
    );
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("pending_presented_as_completed");
  });

  it("a PENDING refund must never read as completed (English)", () => {
    const v = validateGroundedMessage(
      "Your refund of 600.00 USD was processed and completed.",
      { ...REFUND_OK, status: "pending" },
    );
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("pending_presented_as_completed");
  });

  it("a pending-phrased message about a pending refund passes", () => {
    const v = validateGroundedMessage(
      "בקשת ההחזר על סך 600.00 USD עבור הזמנה #1004 התקבלה ונמצאת בטיפול. נעדכן כשההחזר יושלם.",
      { ...REFUND_OK, status: "pending" },
    );
    expect(v.ok).toBe(true);
  });

  it("a FAILED action must never read as success", () => {
    const v = validateGroundedMessage("הפעולה בוצעה בהצלחה!", {
      tool: "shopify.cancel_order",
      outcome: "failed",
      errorReason: "order_not_found",
    });
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("failure_presented_as_success");
  });

  it("empty output is rejected (forces the fallback path)", () => {
    expect(validateGroundedMessage("", REFUND_OK).ok).toBe(false);
  });
});

describe("buildFallbackMessage (deterministic, always safe)", () => {
  it("Hebrew customer → Hebrew fallback with exact amount + order, no em dash", () => {
    const msg = buildFallbackMessage(REFUND_OK, "אני רוצה זיכוי\nכן");
    expect(msg).toContain("600.00 USD");
    expect(msg).toContain("#1004");
    expect(/[–—―]/.test(msg)).toBe(false);
    expect(/[֐-׿]/.test(msg)).toBe(true);
    expect(validateGroundedMessage(msg, REFUND_OK).ok).toBe(true);
  });

  it("English customer → English fallback", () => {
    const msg = buildFallbackMessage(REFUND_OK, "I want a refund please");
    expect(msg).toMatch(/refund/i);
    expect(msg).toContain("600.00 USD");
    expect(validateGroundedMessage(msg, REFUND_OK).ok).toBe(true);
  });

  it("pending refund fallback says submitted/pending, never completed", () => {
    const facts = { ...REFUND_OK, status: "pending" };
    const msg = buildFallbackMessage(facts, "אני רוצה זיכוי");
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
    expect(msg).toMatch(/בטיפול|התקבלה/);
  });

  it("failed outcome fallback never claims success", () => {
    const facts: ExecutionFacts = { tool: "shopify.process_refund", outcome: "failed", errorReason: "missing_scope" };
    const msg = buildFallbackMessage(facts, "אני רוצה זיכוי");
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
    expect(msg).not.toMatch(/בהצלחה/);
  });

  it("cancellation fallback names the order", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "succeeded", orderName: "#1004", status: "cancelled" };
    const msg = buildFallbackMessage(facts, "בטלי את ההזמנה");
    expect(msg).toContain("#1004");
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
  });
});
