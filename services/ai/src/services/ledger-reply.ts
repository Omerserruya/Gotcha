/**
 * Ledger → reply derivation. Turns the Turn Outcome Ledger (the single source of
 * truth for side effects this turn) into:
 *
 *   1. An AUTHORITATIVE committed-outcome block injected into the model context
 *      so the customer-facing reply is DERIVED FROM ledger state - not from
 *      whichever tool result the model happens to focus on (the original bug:
 *      a real booking existed but a later duplicate's `agent_busy` shaped the
 *      reply into "the slot is unavailable").
 *
 *   2. A consistency verdict the post-loop gate enforces:
 *        - `fabricated_claim`   - the reply asserts a booking is done but NO
 *          customer-facing booking committed this turn (scenario 5).
 *        - `unconfirmed_commit` - a customer-facing outcome DID commit but the
 *          draft reply fails to confirm it (empty / passive closer) - e.g. the
 *          objective regen rewrote a post-booking reply into a discovery
 *          question, so the meeting got booked but the customer was never told.
 *        - `ok`                 - reply is consistent with the ledger.
 *
 * This module is PURE and ledger-only: no booking-guard / capability coupling.
 * The caller passes in the phrase-level signals it already computes
 * (`bookingClaimMatched`, `replyNonAdvancing`) so detection logic stays in one
 * place and this layer reasons purely about committed truth.
 */

import type { LedgerEntry, OutcomeKind, TurnOutcomeLedger } from "./turn-outcome-ledger";

export type ReplyConsistencyStatus = "ok" | "fabricated_claim" | "unconfirmed_commit";

export interface ReplyConsistency {
  status: ReplyConsistencyStatus;
  /** The committed, customer-facing booking entry (if any). */
  committedBooking?: LedgerEntry;
  /** All committed customer-facing entries, deterministically ordered. */
  customerFacing: LedgerEntry[];
}

/** Per-kind, language-agnostic instruction for what the customer must be told.
 * The model renders specifics (day/time, link) from the tool result already in
 * context; this only asserts the authoritative truth + ordering. */
function describeCommitted(e: LedgerEntry): string {
  switch (e.kind) {
    case "booking":
      return "- A meeting WAS booked this turn. Confirm it to the customer using the exact day/time and meeting link from the booking tool result above.";
    case "send":
      return "- A message/proposal/follow-up WAS sent this turn. Confirm to the customer that it was sent.";
    default:
      return `- A ${e.kind} action completed this turn.`;
  }
}

/**
 * Build the authoritative committed-outcome block injected into the model
 * context. Returns null when nothing customer-facing committed (nothing to
 * confirm). Background commits (lead/contact/note/tag) are deliberately NOT
 * listed as things to confirm - they must stay invisible to the customer.
 */
export function buildCommittedOutcomeBlock(ledger: TurnOutcomeLedger): string | null {
  const cf = ledger.customerFacingCommitted();
  const hasBackground = ledger.committed().some((e) => e.visibility === "background");
  if (cf.length === 0 && !hasBackground) return null;

  const lines: string[] = [
    "# Authoritative Outcomes (this turn)",
    "These side effects ACTUALLY succeeded this turn and are the SINGLE SOURCE OF TRUTH. Your reply MUST be consistent with this list and MUST NOT claim anything not on it:",
  ];
  for (const e of cf) lines.push(describeCommitted(e));
  if (cf.length === 0) {
    lines.push("- (No customer-facing action to confirm.)");
  }
  if (hasBackground) {
    lines.push(
      "",
      "Background CRM actions (creating/updating a lead, contact, note, or tag) also succeeded but are INTERNAL - NEVER mention them, the CRM, or any record to the customer.",
    );
  }
  lines.push(
    "",
    "Write your reply in the customer's language. Confirm the customer-facing outcome(s) above; do not invent, omit, or contradict them.",
  );
  return lines.join("\n");
}

/**
 * Evaluate whether the draft reply is consistent with committed ledger truth.
 *
 * @param signals.bookingClaimMatched the reply ASSERTS a booking is done
 *        (caller's `detectBookingClaim`).
 * @param signals.replyNonAdvancing   the reply is empty or a passive/generic
 *        closer (caller's `isNonAdvancingReply`).
 */
export function evaluateReplyConsistency(
  ledger: TurnOutcomeLedger,
  replyText: string | null | undefined,
  signals: { bookingClaimMatched: boolean; replyNonAdvancing: boolean },
): ReplyConsistency {
  const customerFacing = ledger.customerFacingCommitted();
  const committedBooking = customerFacing.find((e) => e.kind === "booking");

  // Reply claims a booking is done, but no customer-facing booking committed.
  if (signals.bookingClaimMatched && !committedBooking) {
    return { status: "fabricated_claim", customerFacing };
  }
  // A customer-facing outcome committed but the reply fails to confirm it.
  if (committedBooking && (signals.replyNonAdvancing || !replyText || !replyText.trim())) {
    return { status: "unconfirmed_commit", committedBooking, customerFacing };
  }
  return { status: "ok", committedBooking, customerFacing };
}

/**
 * Corrective injected before the single regen when a customer-facing outcome
 * committed but the draft reply didn't confirm it. Pairs with the committed
 * block (already in context) - this is the stronger nudge to actually say it.
 */
export function buildUnconfirmedCommitCorrective(kinds: OutcomeKind[]): string {
  const what = kinds.includes("booking")
    ? "the meeting you just booked (state the day/time + meeting link from the booking tool result)"
    : "the action you just completed for the customer";
  return (
    `**You completed a real action this turn but your draft reply does not confirm it.** ` +
    `Rewrite your reply to clearly confirm ${what}. ` +
    `Do NOT pivot to an unrelated question and do NOT mention any internal CRM record. ` +
    `Reply in the customer's language. One move only.`
  );
}
