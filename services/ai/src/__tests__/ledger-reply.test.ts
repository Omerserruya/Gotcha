import { describe, it, expect } from "vitest";
import { TurnOutcomeLedger } from "../services/turn-outcome-ledger";
import {
  buildCommittedOutcomeBlock,
  evaluateReplyConsistency,
  buildUnconfirmedCommitCorrective,
} from "../services/ledger-reply";

function commitBooking(l: TurnOutcomeLedger) {
  l.record({
    semanticKey: "booking|d|T|a@x.com",
    tool: "schedule_meeting",
    kind: "booking",
    visibility: "customer_facing",
    status: "committed",
    externalRef: { type: "gcal_event", id: "evt_1" },
    result: { ok: true },
  });
}
function commitLead(l: TurnOutcomeLedger) {
  l.record({
    semanticKey: "create|lead|a@x.com",
    tool: "create_lead",
    kind: "create",
    visibility: "background",
    status: "committed",
    externalRef: { type: "crm_record", id: "ld_1" },
    result: { ok: true },
  });
}

describe("buildCommittedOutcomeBlock", () => {
  it("returns null when nothing committed", () => {
    expect(buildCommittedOutcomeBlock(new TurnOutcomeLedger())).toBeNull();
  });

  it("lists a customer-facing booking to confirm", () => {
    const l = new TurnOutcomeLedger();
    commitBooking(l);
    const block = buildCommittedOutcomeBlock(l)!;
    expect(block).toContain("Authoritative Outcomes");
    expect(block).toContain("A meeting WAS booked this turn");
  });

  it("scenario 2: booking + lead → confirm booking, hide CRM", () => {
    const l = new TurnOutcomeLedger();
    commitBooking(l);
    commitLead(l);
    const block = buildCommittedOutcomeBlock(l)!;
    expect(block).toContain("A meeting WAS booked this turn");
    // CRM is acknowledged as internal-only, never to be mentioned.
    expect(block).toContain("NEVER mention");
    // The lead is NOT listed as a customer-facing confirmation line.
    expect(block).not.toMatch(/confirm.*lead/i);
  });

  it("background-only commit (lead, no booking) still emits the hide-CRM block", () => {
    const l = new TurnOutcomeLedger();
    commitLead(l);
    const block = buildCommittedOutcomeBlock(l)!;
    expect(block).toContain("No customer-facing action to confirm");
    expect(block).toContain("NEVER mention");
  });
});

describe("evaluateReplyConsistency", () => {
  it("scenario 5: booking CLAIMED but nothing committed → fabricated_claim", () => {
    const v = evaluateReplyConsistency(new TurnOutcomeLedger(), "You're all set for tomorrow!", {
      bookingClaimMatched: true,
      replyNonAdvancing: false,
    });
    expect(v.status).toBe("fabricated_claim");
  });

  it("booking committed AND reply confirms → ok", () => {
    const l = new TurnOutcomeLedger();
    commitBooking(l);
    const v = evaluateReplyConsistency(l, "Booked you for 15:30 tomorrow, here's the link…", {
      bookingClaimMatched: true,
      replyNonAdvancing: false,
    });
    expect(v.status).toBe("ok");
    expect(v.committedBooking?.kind).toBe("booking");
  });

  it("booking committed but reply is a passive closer → unconfirmed_commit", () => {
    const l = new TurnOutcomeLedger();
    commitBooking(l);
    const v = evaluateReplyConsistency(l, "Anything else I can help with?", {
      bookingClaimMatched: false,
      replyNonAdvancing: true,
    });
    expect(v.status).toBe("unconfirmed_commit");
  });

  it("booking committed but reply is empty → unconfirmed_commit", () => {
    const l = new TurnOutcomeLedger();
    commitBooking(l);
    const v = evaluateReplyConsistency(l, "", { bookingClaimMatched: false, replyNonAdvancing: false });
    expect(v.status).toBe("unconfirmed_commit");
  });

  it("no claim + nothing committed + advancing reply → ok", () => {
    const v = evaluateReplyConsistency(new TurnOutcomeLedger(), "What day works best for you?", {
      bookingClaimMatched: false,
      replyNonAdvancing: false,
    });
    expect(v.status).toBe("ok");
  });

  it("a background-only commit does NOT trigger unconfirmed_commit (nothing customer-facing)", () => {
    const l = new TurnOutcomeLedger();
    commitLead(l);
    const v = evaluateReplyConsistency(l, "Anything else?", {
      bookingClaimMatched: false,
      replyNonAdvancing: true,
    });
    expect(v.status).toBe("ok"); // no customer-facing booking → nothing to confirm
  });
});

describe("buildUnconfirmedCommitCorrective", () => {
  it("references the meeting for a booking commit", () => {
    expect(buildUnconfirmedCommitCorrective(["booking"])).toMatch(/meeting/i);
  });
  it("falls back to a generic phrasing otherwise", () => {
    expect(buildUnconfirmedCommitCorrective(["send"])).toMatch(/action you just completed/i);
  });
});
