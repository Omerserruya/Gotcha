/**
 * Action-honesty validator - the deterministic block on "I'm searching now /
 * here are the options / I sent it / I'll get back to you" when nothing
 * actually executed. Phrases are the real ones from the 2026-07-21 incident
 * (conv cmrui5rr30001a9y6xk4rhd3h), where 14 turns made these claims with
 * ZERO tool calls.
 */
import { describe, it, expect } from "vitest";
import {
  detectActionClaims,
  turnHasExecutionEvidence,
  validateActionHonesty,
  stripUnsupportedDelegation,
} from "../services/action-honesty.service";

const EXECUTED = [{ tool: "shopify.search_products", decision: "executed", sideEffect: undefined }];
const NO_TOOLS: any[] = [];
const ONLY_MARKERS = [{ tool: "__redundant_info__", decision: "already_provided" }];

describe("detectActionClaims (Hebrew incident phrases)", () => {
  it("flags in-progress, results, sent and follow-up claims", () => {
    expect(detectActionClaims("אני בודקת עכשיו ומחזירה תוך רגע")[0].kind).toBe("in_progress");
    expect(detectActionClaims("הנה 3 אופציות שמתאימות").some((c) => c.kind === "results")).toBe(true);
    expect(detectActionClaims("שלחתי לך קבלה").some((c) => c.kind === "sent")).toBe(true);
    expect(detectActionClaims("אחזור אליך תוך דקה").some((c) => c.kind === "followup")).toBe(true);
    expect(detectActionClaims("checking now, I'll get back to you").map((c) => c.kind).sort())
      .toEqual(["followup", "in_progress"]);
  });

  it("does not flag an honest question or a plain answer", () => {
    expect(detectActionClaims("מה התקציב שלך?")).toEqual([]);
    expect(detectActionClaims("הלוח מתאים לגובה שלך.")).toEqual([]);
  });
});

describe("turnHasExecutionEvidence", () => {
  it("true only for a real executed tool", () => {
    expect(turnHasExecutionEvidence(EXECUTED)).toBe(true);
    expect(turnHasExecutionEvidence(NO_TOOLS)).toBe(false);
    expect(turnHasExecutionEvidence(ONLY_MARKERS)).toBe(false);
    expect(turnHasExecutionEvidence([{ tool: "shopify.cancel_order", decision: "executed", sideEffect: "awaiting_approval" }])).toBe(false);
  });
});

describe("validateActionHonesty (the incident)", () => {
  it("BLOCKS 'אני בודקת עכשיו... הנה 3 אופציות' when no tool ran (tests 16/26/27)", () => {
    const v = validateActionHonesty("אני בודקת עכשיו ומחזירה תוך רגע עם 3 אופציות", NO_TOOLS);
    expect(v.ok).toBe(false);
    expect(v.unsupported.map((c) => c.kind)).toContain("in_progress");
  });

  it("BLOCKS a results claim with no provider call", () => {
    expect(validateActionHonesty("הנה 3 אופציות שמצאתי לך", NO_TOOLS).ok).toBe(false);
  });

  it("ALLOWS a results claim once a product search actually executed", () => {
    expect(validateActionHonesty("הנה 3 אופציות שמצאתי לך", EXECUTED).ok).toBe(true);
  });

  it("ALWAYS blocks a 'I'll get back to you' promise - the bot has no async job (test 17)", () => {
    expect(validateActionHonesty("אחזור אליך תוך דקה עם קישורים", EXECUTED).ok).toBe(false);
    // …unless a real background job was created
    expect(validateActionHonesty("אחזור אליך תוך דקה", EXECUTED, { hasBackgroundJob: true }).ok).toBe(true);
  });

  it("BLOCKS a false 'I sent it' with no email tool execution", () => {
    expect(validateActionHonesty("שלחתי לך את הקבלה", NO_TOOLS).ok).toBe(false);
  });
});

/**
 * Claiming another party was engaged.
 *
 * Three live replies, none backed by anything:
 *   "אעביר את המצב לצוות התמיכה כדי שיאשרו"
 *   "אעביר את הבקשה לצוות שיטפל בביטול ובהחזר"
 *   "להזמין בדיקה אצל צוות המשלוחים"
 *
 * This is the most damaging shape of the five: it reads as resolution, so the
 * customer stops chasing - and nobody is coming.
 */
describe("delegated claims", () => {
  const READ_ONLY = [{ tool: "shopify.get_order", decision: "executed" }];
  const HANDOFF = [{ tool: "escalate_to_human", decision: "executed" }];

  it("flags passing the case to a team when nothing was engaged", () => {
    const v = validateActionHonesty("אעביר את המצב לצוות התמיכה כדי שיאשרו.", READ_ONLY);
    expect(v.ok).toBe(false);
    expect(v.unsupported.map((c) => c.kind)).toContain("delegated");
  });

  it("flags 'the team will handle it' in English", () => {
    expect(validateActionHonesty("I've passed this to the support team.", READ_ONLY).ok).toBe(false);
    expect(validateActionHonesty("The team will contact you shortly.", READ_ONLY).ok).toBe(false);
  });

  it("flags claiming the courier was contacted", () => {
    expect(validateActionHonesty("עדכנתי את חברת המשלוחים.", READ_ONLY).ok).toBe(false);
  });

  it("ALLOWS the claim when a real handoff executed this turn", () => {
    expect(validateActionHonesty("מעבירה את הפנייה לצוות אנושי.", HANDOFF).ok).toBe(true);
  });

  it("a READ is not evidence that a person was told anything", () => {
    // The whole point: fetching the order proves the bot did something, not
    // that anyone was notified.
    expect(validateActionHonesty("אעביר את הבקשה לצוות.", READ_ONLY).ok).toBe(false);
  });

  it("a note or a tag is not a team notification", () => {
    const noted = [{ tool: "shopify.create_note", decision: "executed" }];
    expect(validateActionHonesty("דיווחתי לצוות על התקלה.", noted).ok).toBe(false);
  });

  it("does not flag ordinary sentences that merely mention a team", () => {
    expect(validateActionHonesty("הצוות שלנו זמין בימים א-ה.", READ_ONLY).ok).toBe(true);
  });
});

describe("stripping an unsupported delegation", () => {
  it("keeps the grounded part and cuts the promise", () => {
    const out = stripUnsupportedDelegation(
      "ההחזר עבור הזמנה 1010 כבר הושלם במלואו. אעביר את המצב לצוות התמיכה כדי שיאשרו.",
    );
    expect(out).toContain("1010");
    expect(out).not.toMatch(/לצוות/);
  });

  it("returns null when there is nothing to remove", () => {
    expect(stripUnsupportedDelegation("ההזמנה בוטלה בהצלחה.")).toBeNull();
  });

  it("returns null rather than an empty reply when the promise was the whole message", () => {
    // Better to ship the original and let the audit catch it than to send
    // the customer a blank message.
    expect(stripUnsupportedDelegation("אעביר את הבקשה לצוות.")).toBeNull();
  });

  it("handles English too", () => {
    const out = stripUnsupportedDelegation("Your order #1010 was refunded. I've passed this to the support team.");
    expect(out).toContain("#1010");
    expect(out).not.toMatch(/support team/i);
  });
});

/**
 * "I've done it" - a completed write, past tense.
 *
 * Live: asked to note a callback request on order #1011, the bot replied
 * "מעולה, ביצעתי את הבקשה שיחזרו אליך לפני המשלוח". Shopify showed
 * note: null and tags: "". Nothing was written, no tool ran, and the customer
 * was told their request was on the order - so they stop asking.
 */
describe("performed claims", () => {
  const NOTHING: any[] = [];
  const WROTE = [{ tool: "shopify.create_note", decision: "executed" }];

  it("flags the live regression", () => {
    const v = validateActionHonesty("מעולה, ביצעתי את הבקשה שיחזרו אליך לפני המשלוח.", NOTHING);
    expect(v.ok).toBe(false);
    expect(v.unsupported.map((c) => c.kind)).toContain("performed");
  });

  it("flags the English shapes", () => {
    expect(validateActionHonesty("I've added a note to your order.", NOTHING).ok).toBe(false);
    expect(validateActionHonesty("The note has been added.", NOTHING).ok).toBe(false);
  });

  it("ALLOWS the claim when a write really executed", () => {
    expect(validateActionHonesty("רשמתי את זה על ההזמנה.", WROTE).ok).toBe(true);
  });

  it("does not flag an ordinary future offer", () => {
    expect(validateActionHonesty("אפשר לרשום את זה על ההזמנה, רוצה שאעשה את זה?", NOTHING).ok).toBe(true);
  });

  it("strips the false completion but keeps the rest of the reply", () => {
    const out = stripUnsupportedDelegation(
      "ההזמנה 1011 עדיין לא נשלחה. ביצעתי את הבקשה שיחזרו אליך.",
    );
    expect(out).toContain("1011");
    expect(out).not.toMatch(/ביצעתי/);
  });
});
