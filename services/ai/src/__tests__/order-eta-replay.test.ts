import { describe, it, expect, beforeEach, vi } from "vitest";
import { guardCustomerReply, turnEvidenceFrom } from "../services/reply-guard.service";
import {
  checkToolAttempt,
  recordToolAttempt,
  __resetToolAttemptGuard,
} from "@chatcenter/shared/src/lib/tool-attempt-guard";
import {
  BAD_REPLIES,
  GOOD_REPLIES,
  FAILED_WRITE_ATTEMPTS,
  FIXTURE,
} from "./fixtures/order-eta-conversation";

/**
 * Regression replay for the 2026-07-31 "where is my order" conversation.
 *
 * ── What this proves, and what it does not ──────────────────────────────────
 * It replays the DETERMINISTIC layers - order resolution, tool result shape,
 * the reply guard, the loop guard - against the exact strings and arguments the
 * model produced. Every one of those layers is code, so the assertions are
 * real: if a reply like the original were drafted again, it would not reach the
 * customer in that form.
 *
 * It does NOT prove the model will phrase things well. No LLM runs here, on
 * purpose: a test that calls a model is neither deterministic nor free, and the
 * prompt rules (13c/13d/13e, 10a) are a separate layer whose job is to make the
 * good version likely. This layer's job is to make the bad version impossible
 * to send. Both are wanted, and only one can be asserted in CI.
 */

const CONV = "replay_conv_1";
const HE = { locale: FIXTURE.locale };

beforeEach(() => __resetToolAttemptGuard());

describe("1-2. the order number resolves as a NAME", () => {
  it("classifies the customer's '#1006' correctly", async () => {
    const { orderIdentifierFromArgs } = await import("../services/connectors/shopify-order-identifier");
    // Landing in order_id is the production shape - the tool had no other field.
    expect(orderIdentifierFromArgs({ order_id: FIXTURE.orderName }))
      .toMatchObject({ kind: "order_name", name: "1006" });
  });
});

describe("3-8. the ETA is explained without the acronym or the machinery", () => {
  it("flags the volunteered acronym", () => {
    // Flagged rather than removed: "ETA" carries the sentence's meaning, and
    // deleting it would leave a reply that says nothing. Rewriting it into
    // natural Hebrew is the prompt's job (rule 13d); making the leak visible
    // is this layer's. The customer had to ask what it meant twice and nothing
    // noticed.
    const r = guardCustomerReply(BAD_REPLIES.volunteeredAcronym, {
      ...HE, invokedTools: [...FIXTURE.invokedTools], evidence: {},
    });
    const hit = r.findings.find((f) => f.kind === "untranslated_acronym");
    expect(hit?.match).toBe("ETA");
  });

  it("removes the two-checks narration, the internals and the provider error", () => {
    const r = guardCustomerReply(BAD_REPLIES.narratedTwoChecks, {
      ...HE, invokedTools: [...FIXTURE.invokedTools], evidence: {},
    });
    expect(r.text).not.toContain("שתי בדיקות");
    expect(r.text).not.toContain("שורת המילוי");
    expect(r.text).not.toContain("שגיאת מערכת");
    expect(r.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["tool_count_narration", "internal_term_leak"]),
    );
  });

  it("removes 'a technical problem on our side'", () => {
    const r = guardCustomerReply(BAD_REPLIES.exposedTechnicalFailure, { ...HE, evidence: {} });
    expect(r.text).not.toContain("תקלה טכנית אצלנו");
  });

  it("KEEPS the plain-language version that says the same thing", () => {
    const r = guardCustomerReply(GOOD_REPLIES.noEtaPlainly, {
      ...HE, invokedTools: [...FIXTURE.invokedTools], evidence: {},
    });
    expect(r.text).toBe(GOOD_REPLIES.noEtaPlainly);
    expect(r.changed).toBe(false);
  });
});

describe("9-12. no claim of contact, no promise without a schedule", () => {
  it("removes the shipping-team promise", () => {
    const r = guardCustomerReply(BAD_REPLIES.promisedTeamContact, { ...HE, evidence: {} });
    expect(r.text).not.toContain("לצוות המשלוחים");
  });

  it("a successful note/tag write is still not evidence of contact", () => {
    // update_order_fulfillment succeeding contributes NO evidence field.
    const evidence = turnEvidenceFrom(["shopify.update_order_fulfillment"]);
    expect(evidence.notificationSent).toBe(false);
    expect(evidence.taskCreated).toBe(false);
    const r = guardCustomerReply(BAD_REPLIES.promisedTeamContact, { ...HE, evidence });
    expect(r.text).not.toContain("לצוות המשלוחים");
  });

  it("removes the proactive-update promise when nothing was scheduled", () => {
    const r = guardCustomerReply(BAD_REPLIES.promisedProactiveUpdate, { ...HE, evidence: {} });
    expect(r.text).not.toContain("אדאג לעדכן אותך");
  });

  it("13. KEEPS the promise once schedule_followup really succeeded", () => {
    const evidence = turnEvidenceFrom(["schedule_followup"]);
    expect(evidence.followUpScheduled).toBe(true);
    const r = guardCustomerReply(BAD_REPLIES.promisedProactiveUpdate, { ...HE, evidence });
    expect(r.text).toBe(BAD_REPLIES.promisedProactiveUpdate);
  });

  it("14. removes the promise when the follow-up call FAILED", () => {
    // A failed schedule contributes nothing, so the promise is unbacked again.
    const evidence = turnEvidenceFrom([]); // nothing committed
    const r = guardCustomerReply(BAD_REPLIES.promisedProactiveUpdate, { ...HE, evidence });
    expect(r.text).not.toContain("אדאג לעדכן אותך");
  });

  it("keeps the OFFER, which is how the customer opts in", () => {
    const r = guardCustomerReply(GOOD_REPLIES.offerToFollowUp, { ...HE, evidence: {} });
    expect(r.text).toBe(GOOD_REPLIES.offerToFollowUp);
  });
});

describe("15-16. Hebrew gender", () => {
  it("flags the slash form Maya used about herself", () => {
    const r = guardCustomerReply(BAD_REPLIES.slashFormAboutSelf, { ...HE, evidence: {} });
    expect(r.findings.some((f) => f.kind === "slash_form")).toBe(true);
  });

  it("flags the slash form aimed at the male customer", () => {
    const r = guardCustomerReply(BAD_REPLIES.slashFormAtCustomer, HE);
    expect(r.findings.some((f) => f.kind === "slash_form")).toBe(true);
  });

  it("accepts consistent feminine first person and a restructured question", () => {
    for (const good of [GOOD_REPLIES.femaleFirstPerson, GOOD_REPLIES.genderNeutralAsk]) {
      const r = guardCustomerReply(good, HE);
      expect(r.findings.some((f) => f.kind === "slash_form"), good).toBe(false);
      expect(r.text).toBe(good);
    }
  });
});

describe("17-18. failures are honest, and the loop stops", () => {
  it("does not allow four identical failing writes", () => {
    const allowed: boolean[] = [];
    for (const attempt of FAILED_WRITE_ATTEMPTS) {
      const v = checkToolAttempt(CONV, "shopify.update_order_fulfillment", attempt.args);
      allowed.push(v.allowed);
      if (v.allowed) {
        recordToolAttempt(CONV, "shopify.update_order_fulfillment", attempt.args, {
          ok: false, reason: attempt.reason,
        });
      }
    }
    expect(allowed).toEqual([true, true, false, false]);
    expect(allowed.filter(Boolean).length, "at most two attempts").toBeLessThanOrEqual(2);
  });

  it("the refusal tells the model not to claim success", () => {
    for (const a of FAILED_WRITE_ATTEMPTS.slice(0, 2)) {
      recordToolAttempt(CONV, "shopify.update_order_fulfillment", a.args, { ok: false, reason: a.reason });
    }
    const v = checkToolAttempt(CONV, "shopify.update_order_fulfillment", { order_id: "#1006" });
    expect(v.reason).toMatch(/Do NOT claim this action succeeded/);
  });

  it("reports a failure without naming the endpoint or the field", () => {
    const r = guardCustomerReply(BAD_REPLIES.exposedTechnicalFailure, { ...HE, evidence: {} });
    expect(r.text).not.toMatch(/shopify|400|404|note|tag/i);
  });

  it("the honest failure sentence survives unchanged", () => {
    const r = guardCustomerReply(GOOD_REPLIES.honestFailure, { ...HE, evidence: {} });
    expect(r.text).toBe(GOOD_REPLIES.honestFailure);
  });
});

describe("19-20. escalation is clean and not provoked", () => {
  it("a handoff claim is allowed once the escalation really happened", () => {
    const evidence = turnEvidenceFrom(["escalate_to_human"]);
    expect(evidence.handoffCreated).toBe(true);
    const r = guardCustomerReply("העברתי לצוות שימשיך מכאן.", { ...HE, evidence });
    expect(r.text).toContain("העברתי");
  });

  it("the same claim is removed when no handoff was created", () => {
    const r = guardCustomerReply("העברתי את הפרטים לצוות שימשיך מכאן.", { ...HE, evidence: {} });
    expect(r.text).not.toContain("לצוות");
  });

  it("nothing in the corrected flow reaches the customer as machinery", () => {
    // The end-to-end shape: every good reply passes the guard untouched, so a
    // conversation built from them never produces the frustration that led to
    // the cancellation request.
    const evidence = turnEvidenceFrom(["schedule_followup"]);
    for (const good of Object.values(GOOD_REPLIES)) {
      const r = guardCustomerReply(good, {
        ...HE, invokedTools: [...FIXTURE.invokedTools], evidence,
      });
      expect(r.text, `guard damaged a good reply: ${good}`).toBe(good);
    }
  });
});

describe("the fixture carries no live customer data", () => {
  it("contains no phone number and not the real customer's name", () => {
    const blob = JSON.stringify({ BAD_REPLIES, GOOD_REPLIES, FIXTURE, FAILED_WRITE_ATTEMPTS });
    expect(blob).not.toMatch(/\+?972\d{7,}/);
    // Phone-shaped runs only. The 13-digit order id is an invented Shopify
    // internal id, which is the whole point of the fixture.
    expect(blob).not.toMatch(/0\d{2}-?\d{7}/);
    expect(blob).not.toMatch(/\b05\d{8}\b/);
    expect(blob).not.toContain("Amran");
    expect(FIXTURE.customerDisplayName).toBe("יונתן לוי"); // fictional
  });
});
