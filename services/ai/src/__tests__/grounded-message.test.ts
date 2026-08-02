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

  // ── Rejection: a human said no ────────────────────────────────────────
  // A declined request is not an outage. These lock the two ways the old
  // code got it wrong: saying nothing at all, and (once it did speak)
  // borrowing the failure wording, which invents a technical problem.

  it("rejected cancellation says it was not approved and that the order stands", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "rejected", orderName: "#1004" };
    const msg = buildFallbackMessage(facts, "אני רוצה לבטל את ההזמנה");
    expect(msg).toMatch(/לא אושרה/);
    expect(msg).toMatch(/לא בוטלה/);
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
  });

  it("rejected refund never implies money moved", () => {
    const facts: ExecutionFacts = { tool: "shopify.process_refund", outcome: "rejected" };
    const msg = buildFallbackMessage(facts, "אני רוצה החזר");
    expect(msg).toMatch(/לא אושרה/);
    expect(msg).not.toMatch(/בהצלחה|הוחזר הכסף/);
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
  });

  it("a rejection dressed up as success is refused by the validator", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "rejected", orderName: "#1004" };
    const verdict = validateGroundedMessage("ההזמנה בוטלה בהצלחה.", facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain("rejection_presented_as_success");
  });

  // ── Internal vocabulary must not reach the customer ───────────────────
  // Live regression: a customer received
  //   "...אבל הבקשה נכשלה (סיבה: unknown)..."
  // because the reason CLASS was handed to the model as a verified fact.

  it("refuses a message that leaks an internal reason class", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "failed", errorReason: "unknown" };
    const verdict = validateGroundedMessage("הבקשה נכשלה (סיבה: unknown).", facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain("internal_reason_leaked");
  });

  it("refuses a message that leaks a provider status code", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "failed", errorReason: "not_permitted" };
    const verdict = validateGroundedMessage("לא הצלחתי, shopify_422.", facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain("internal_reason_leaked");
  });

  it("turns a reason class into a plain sentence, never the token", () => {
    const facts: ExecutionFacts = {
      tool: "shopify.cancel_order",
      outcome: "failed",
      errorReason: "not_possible_after_shipping",
    };
    const msg = buildFallbackMessage(facts, "אני רוצה לבטל");
    expect(msg).toContain("כבר נמסרה לטיפול המשלוח");
    expect(msg).not.toMatch(/not_possible_after_shipping/);
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
  });

  it("an unknown reason simply says less, rather than saying 'unknown'", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "failed", errorReason: "unknown" };
    const msg = buildFallbackMessage(facts, "אני רוצה לבטל");
    expect(msg).not.toMatch(/unknown|סיבה:/);
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
  });

  it("refuses a provider status enum pasted into a Hebrew reply", () => {
    // Live regression: "ההזמנה #1009 הוחזרה בהצלחה, refunded, המטבע USD".
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "succeeded", orderName: "#1009", status: "refunded" };
    const verdict = validateGroundedMessage("ההזמנה #1009 הוחזרה בהצלחה, refunded.", facts);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain("provider_status_token_leaked");
  });

  it("allows the same words in an English reply, where they are just words", () => {
    const facts: ExecutionFacts = { tool: "shopify.process_refund", outcome: "succeeded", orderName: "#1009", status: "processed" };
    expect(validateGroundedMessage("Order #1009 has been refunded.", facts).ok).toBe(true);
  });

  it("a cancel that also refunded says so in words, not in status codes", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "succeeded", orderName: "#1009", status: "refunded" };
    const msg = buildFallbackMessage(facts, "אני רוצה לבטל את הזמנה 1009");
    expect(msg).toContain("בוטלה");
    expect(msg).toContain("הוחזר");
    expect(msg).not.toMatch(/refunded/i);
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
  });

  it("a failed action no longer promises that a person is already handling it", () => {
    const facts: ExecutionFacts = { tool: "shopify.cancel_order", outcome: "failed", errorReason: "provider_unavailable" };
    const msg = buildFallbackMessage(facts, "אני רוצה לבטל");
    // No unsupported promise: no task, ticket or notification exists yet, so
    // the message may not claim the team was engaged or will call back.
    expect(msg).not.toMatch(/נציג מהצוות ממשיך|ויעדכן אותך|פניתי לצוות|נחזור אליך/);
    expect(validateGroundedMessage(msg, facts).ok).toBe(true);
  });
});

/**
 * A reference the action produced must reach the customer.
 *
 * Live (2026-08-02): a return was opened correctly, read back correctly, and
 * announced as "פתחתי עבורך החזרה" with no reference in it - twice, on two
 * different orders, with the reference sitting in the verified facts and a
 * prompt line asking for it. True, and less than the customer needed. A soft
 * instruction the model followed inconsistently is now a hard rule.
 */
describe("a reference the customer can quote", () => {
  const facts = (over: Partial<ExecutionFacts> = {}): ExecutionFacts => ({
    tool: "shopify.create_return", outcome: "succeeded", orderName: "#1002", reference: "#1002-R1", ...over,
  });

  it("rejects a success message that omits the reference", () => {
    const v = validateGroundedMessage("פתחתי עבורך בקשת החזרה עבור ההזמנה #1002.", facts());
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("reference_missing");
  });

  it("accepts one that quotes it", () => {
    expect(validateGroundedMessage("פתחתי בקשת החזרה עבור הזמנה #1002, מספר האסמכתא הוא #1002-R1.", facts()).ok).toBe(true);
  });

  it("never demands an internal GID be shown to a customer", () => {
    const v = validateGroundedMessage("פתחתי בקשת החזרה עבור הזמנה #1002.", facts({ reference: "gid://shopify/Return/56386093425" }));
    expect(v.problems).not.toContain("reference_missing");
  });

  it("does not require a reference on a failure", () => {
    const v = validateGroundedMessage("לא הצלחתי להשלים את הפעולה כרגע.", facts({ outcome: "failed" }));
    expect(v.problems).not.toContain("reference_missing");
  });

  it("does not mistake the reference's digits for a contradicting amount", () => {
    const v = validateGroundedMessage(
      "ההחזר על סך 150.00 USD עבור הזמנה #1002 בוצע, אסמכתא #1002-R1.",
      facts({ tool: "shopify.process_refund", amount: 150, currency: "USD" }),
    );
    expect(v.problems).not.toContain("contradicting_number_present");
  });

  it("the deterministic fallback always carries it", () => {
    const msg = buildFallbackMessage(facts(), "אני רוצה להחזיר");
    expect(msg).toContain("#1002-R1");
    expect(msg).toContain("#1002");
  });

  it("the fallback omits an internal GID rather than printing it", () => {
    const msg = buildFallbackMessage(facts({ reference: "gid://shopify/Return/1" }), "אני רוצה להחזיר");
    expect(msg).not.toContain("gid://");
  });
});
