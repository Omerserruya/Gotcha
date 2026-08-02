/**
 * Capability Runtime - resolver behavior, proven with FAKE strategies/verifiers.
 *
 * No real calendar, Prisma, or REST: the point is to validate the ARCHITECTURE -
 * that an OperationContract + injected bindings yields correct semantic outcomes,
 * the correctness envelope (MUST + success) is enforced regardless of strategy,
 * dependencies auto-satisfy in operation-space (probe-first), SHOULD never blocks,
 * advisory recommends writes, and the runtime returns control (NEEDS_INPUT/FAILED)
 * instead of deciding.
 */

import { describe, it, expect } from "vitest";
import {
  resolveExecution,
  type ExecutionRequest,
  type RuntimeBindings,
  type StrategyResult,
} from "@chatcenter/shared";
import { CALENDAR_CONTRACTS } from "../services/capability-runtime/calendar.contracts";

function req(operation: string, params: Record<string, unknown> = {}, mode: ExecutionRequest["mode"] = "autonomous"): ExecutionRequest {
  return { operation, params, mode, context: { tenantId: "t1", conversationId: "c1", customerExternalId: "cust1" } };
}

// Build injectable bindings over a mutable world-state flag map. Verifiers read
// the flags live; the satisfier may flip flags (modeling a read that establishes
// a dependency). All predicate ids referenced by a contract must be present.
function env(
  flags: Record<string, boolean>,
  opts: { strategy?: StrategyResult; satisfierFlips?: Record<string, boolean>; approvalRequired?: boolean } = {},
) {
  const f = { ...flags };
  const calls = { satisfier: [] as string[], strategy: 0, approval: 0 };
  const verifiers: RuntimeBindings["verifiers"] = {};
  for (const id of Object.keys(f)) verifiers[id] = () => f[id];
  const bind: RuntimeBindings = {
    verifiers,
    runSatisfier: async (op) => {
      calls.satisfier.push(op);
      for (const [k, v] of Object.entries(opts.satisfierFlips ?? {})) f[k] = v;
      return { ok: true, outcome: "satisfied" };
    },
    executeStrategy: async () => {
      calls.strategy++;
      return opts.strategy ?? { ok: true, outcome: "done" };
    },
    approvalGate: async () => {
      calls.approval++;
      return opts.approvalRequired ? { required: true as const, ref: "appr_1" } : { required: false as const };
    },
  };
  return { bind, calls, flags: f };
}

const CHECK_OK = { meeting_kind_known: true, returned_times_genuinely_open: true, availability_established: true };
const BOOK_OK = {
  no_duplicate_meeting: true, attendee_email_known: true, meeting_kind_known: true,
  desired_time_provided: true, time_genuinely_open: true, single_meeting_after: true,
  booking_confirmed_and_invited: true,
};
const MOVE_OK = {
  existing_booking_present: true, booking_unambiguous: true, new_time_provided: true,
  new_time_genuinely_open: true, single_meeting_after: true, meeting_moved: true,
};
const CANCEL_OK = { existing_booking_present: true, booking_unambiguous: true, meeting_cancelled: true };

const CHECK = CALENDAR_CONTRACTS.CHECK_AVAILABILITY;
const BOOK = CALENDAR_CONTRACTS.BOOK_MEETING;
const MOVE = CALENDAR_CONTRACTS.MOVE_MEETING;
const CANCEL = CALENDAR_CONTRACTS.CANCEL_MEETING;

describe("CHECK_AVAILABILITY (read)", () => {
  it("executes when prerequisites hold", async () => {
    const { bind, calls } = env(CHECK_OK);
    const r = await resolveExecution(CHECK, req("CHECK_AVAILABILITY", { window: "Monday" }), bind);
    expect(r.status).toBe("EXECUTED");
    expect(calls.strategy).toBe(1);
  });

  it("blocks on unknown meeting kind → NEEDS_INPUT(meeting_type)", async () => {
    const { bind, calls } = env({ ...CHECK_OK, meeting_kind_known: false });
    const r = await resolveExecution(CHECK, req("CHECK_AVAILABILITY"), bind);
    expect(r).toMatchObject({ status: "NEEDS_INPUT", field: "meeting_type" });
    expect(calls.strategy).toBe(0);
  });

  it("anti-invention: a returned slot that isn't genuinely open → FAILED at POST", async () => {
    const { bind } = env({ ...CHECK_OK, returned_times_genuinely_open: false });
    const r = await resolveExecution(CHECK, req("CHECK_AVAILABILITY"), bind);
    expect(r).toMatchObject({ status: "FAILED", reason: "post_invariant_violated:returned_times_genuinely_open" });
  });

  it("reads still auto-run in advisory mode (not recommended)", async () => {
    const { bind, calls } = env(CHECK_OK);
    const r = await resolveExecution(CHECK, req("CHECK_AVAILABILITY", {}, "advisory"), bind);
    expect(r.status).toBe("EXECUTED");
    expect(calls.strategy).toBe(1);
  });
});

describe("BOOK_MEETING (write)", () => {
  it("happy path → EXECUTED", async () => {
    const { bind } = env(BOOK_OK);
    const r = await resolveExecution(BOOK, req("BOOK_MEETING", { desired_time: "tomorrow 10:00" }), bind);
    expect(r.status).toBe("EXECUTED");
  });

  it("missing email → NEEDS_INPUT(email), strategy never runs", async () => {
    const { bind, calls } = env({ ...BOOK_OK, attendee_email_known: false });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING"), bind);
    expect(r).toMatchObject({ status: "NEEDS_INPUT", field: "email" });
    expect(calls.strategy).toBe(0);
  });

  it("duplicate guard: active booking exists → FAILED active_booking_exists_use_move", async () => {
    const { bind } = env({ ...BOOK_OK, no_duplicate_meeting: false });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING"), bind);
    expect(r).toMatchObject({ status: "FAILED", reason: "active_booking_exists_use_move" });
  });

  it("SHOULD dependency auto-satisfied via CHECK_AVAILABILITY (operation-space recursion)", async () => {
    const { bind, calls } = env({ ...BOOK_OK, time_genuinely_open: false }, { satisfierFlips: { time_genuinely_open: true } });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING", { desired_time: "tomorrow 10:00" }), bind);
    expect(r.status).toBe("EXECUTED");
    expect(calls.satisfier).toContain("CHECK_AVAILABILITY");
  });

  it("optimization: a fresh SHOULD dependency is NOT re-read (probe-first)", async () => {
    const { bind, calls } = env(BOOK_OK); // time_genuinely_open already true
    const r = await resolveExecution(BOOK, req("BOOK_MEETING", { desired_time: "tomorrow 10:00" }), bind);
    expect(r.status).toBe("EXECUTED");
    expect(calls.satisfier).toHaveLength(0);
  });

  it("SHOULD never blocks: unsatisfiable availability still proceeds (POST/success backstops)", async () => {
    const { bind, calls } = env({ ...BOOK_OK, time_genuinely_open: false }, { satisfierFlips: {} });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING", { desired_time: "tomorrow 10:00" }), bind);
    expect(r.status).toBe("EXECUTED");
    expect(calls.satisfier).toContain("CHECK_AVAILABILITY"); // it tried
  });

  it("advisory mode recommends the write, never executes it", async () => {
    const { bind, calls } = env(BOOK_OK);
    const r = await resolveExecution(BOOK, req("BOOK_MEETING", { desired_time: "x" }, "advisory"), bind);
    expect(r).toMatchObject({ status: "RECOMMENDED", proposal: { operation: "BOOK_MEETING", params: { desired_time: "x" } } });
    expect(calls.strategy).toBe(0);
  });

  it("correctness envelope: a strategy that created a duplicate is caught at POST", async () => {
    const { bind } = env({ ...BOOK_OK, single_meeting_after: false });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING"), bind);
    expect(r).toMatchObject({ status: "FAILED", reason: "post_invariant_violated:single_meeting_after" });
  });

  it("success not verified against world-state → FAILED (never a false success)", async () => {
    const { bind } = env({ ...BOOK_OK, booking_confirmed_and_invited: false });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING"), bind);
    expect(r).toMatchObject({ status: "FAILED", reason: "success_not_verified:booking_confirmed_and_invited" });
  });

  it("HITL: approval required → AWAITING_APPROVAL before execution", async () => {
    const { bind, calls } = env(BOOK_OK, { approvalRequired: true });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING"), bind);
    expect(r).toMatchObject({ status: "AWAITING_APPROVAL", ref: "appr_1" });
    expect(calls.strategy).toBe(0);
  });

  it("strategy failure surfaces as FAILED with recoverable flag", async () => {
    const { bind } = env(BOOK_OK, { strategy: { ok: false, reason: "time_taken", recoverable: true } });
    const r = await resolveExecution(BOOK, req("BOOK_MEETING"), bind);
    expect(r).toMatchObject({ status: "FAILED", reason: "time_taken", recoverable: true });
  });
});

describe("MOVE_MEETING (assertion: a booking exists)", () => {
  it("no existing booking → FAILED nothing_to_move (assertion-carved error)", async () => {
    const { bind } = env({ ...MOVE_OK, existing_booking_present: false });
    const r = await resolveExecution(MOVE, req("MOVE_MEETING", { desired_time: "mon 09:30" }), bind);
    expect(r).toMatchObject({ status: "FAILED", reason: "nothing_to_move" });
  });

  it("ambiguous (several bookings) → NEEDS_INPUT(which_booking)", async () => {
    const { bind } = env({ ...MOVE_OK, booking_unambiguous: false });
    const r = await resolveExecution(MOVE, req("MOVE_MEETING", { desired_time: "mon 09:30" }), bind);
    expect(r).toMatchObject({ status: "NEEDS_INPUT", field: "which_booking" });
  });

  it("happy path → EXECUTED, never creates a duplicate (POST single_meeting_after)", async () => {
    const { bind } = env(MOVE_OK);
    const r = await resolveExecution(MOVE, req("MOVE_MEETING", { desired_time: "mon 09:30" }), bind);
    expect(r.status).toBe("EXECUTED");
  });
});

describe("CANCEL_MEETING (destructive)", () => {
  it("nothing to cancel → FAILED nothing_to_cancel", async () => {
    const { bind } = env({ ...CANCEL_OK, existing_booking_present: false });
    const r = await resolveExecution(CANCEL, req("CANCEL_MEETING"), bind);
    expect(r).toMatchObject({ status: "FAILED", reason: "nothing_to_cancel" });
  });

  it("advisory recommends, never cancels", async () => {
    const { bind, calls } = env(CANCEL_OK);
    const r = await resolveExecution(CANCEL, req("CANCEL_MEETING", {}, "advisory"), bind);
    expect(r.status).toBe("RECOMMENDED");
    expect(calls.strategy).toBe(0);
  });
});

describe("config safety", () => {
  it("a missing RUNTIME_VERIFIED verifier fails loud (never silently passes)", async () => {
    const flags: Record<string, boolean> = { ...BOOK_OK };
    delete (flags as any).no_duplicate_meeting; // drop a MUST verifier
    const { bind } = env(flags);
    await expect(resolveExecution(BOOK, req("BOOK_MEETING"), bind)).rejects.toThrow(/missing RUNTIME_VERIFIED verifier/);
  });
});
