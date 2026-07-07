/**
 * CALENDAR capability — the four operation contracts, as DATA.
 *
 * Frozen in docs/architecture/capability-runtime.md. Business-only language: no
 * tool / provider / endpoint appears anywhere. `satisfierOperation` references
 * another OPERATION (business vocabulary), which is allowed. The verifier and
 * strategy that actually answer these predicates live in the runtime layer
 * (services/ai), bound by the invariant/success `id`s used here.
 */

import type { OperationContract } from "@chatcenter/shared";

const CHECK_AVAILABILITY: OperationContract = {
  id: "CHECK_AVAILABILITY",
  capability: "CALENDAR",
  effect: "read",
  meaning: "what real times are open?",
  params: [{ key: "window", meaning: "the time range the customer is asking about", required: false }],
  outcome: "the genuinely-open times in the window",
  success: { id: "availability_established", statement: "a set of open times (possibly empty) is established for the window" },
  invariants: [
    {
      id: "meeting_kind_known",
      statement: "the meeting kind (duration / working-hours policy) is known",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "meeting_type" },
    },
    {
      id: "returned_times_genuinely_open",
      statement: "every returned time is genuinely open on the real calendar (no invented slots)",
      strength: "MUST",
      checkpoint: "POST",
      enforcement: "RUNTIME_VERIFIED",
    },
  ],
  failureModes: ["no_calendar_available", "none_open"],
  recoveryPosture: { retries: "bounded", alternatives: true, askCustomer: true, escalate: "never" },
  approval: "none",
};

const BOOK_MEETING: OperationContract = {
  id: "BOOK_MEETING",
  capability: "CALENDAR",
  effect: "write",
  meaning: "the customer wants a confirmed meeting",
  params: [
    { key: "desired_time", meaning: "the time the customer wants", required: true },
    { key: "meeting_kind", meaning: "which kind of meeting", required: false },
  ],
  outcome: "booked for <time>, invite sent to <email>",
  success: {
    id: "booking_confirmed_and_invited",
    statement: "a confirmed meeting exists for this customer at the agreed time and the invite was sent",
  },
  invariants: [
    {
      id: "no_duplicate_meeting",
      statement: "the customer does not already have an active meeting (would be a duplicate — move instead)",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "FAILED", reason: "active_booking_exists_use_move" },
    },
    // NOTE: "customer has agreed to meet" is a MEANING precondition owned by the
    // PLANNER — it is asserted by the planner's choice to emit BOOK_MEETING, and
    // cannot be a RUNTIME_VERIFIED invariant (the runtime must not judge intent).
    // Kept out of the runtime face deliberately; see capability-runtime.md.
    {
      id: "attendee_email_known",
      statement: "an attendee email is known to send the invite to",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "email" },
    },
    {
      id: "meeting_kind_known",
      statement: "the meeting kind is known",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "meeting_type" },
    },
    {
      id: "desired_time_provided",
      statement: "the customer chose a concrete time to book",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "desired_time" },
    },
    {
      id: "time_genuinely_open",
      statement: "the chosen time is genuinely open",
      strength: "SHOULD",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      satisfierOperation: "CHECK_AVAILABILITY",
    },
    {
      id: "single_meeting_after",
      statement: "exactly one meeting exists for this customer afterward (no duplicate created)",
      strength: "MUST",
      checkpoint: "POST",
      enforcement: "RUNTIME_VERIFIED",
    },
  ],
  failureModes: ["time_taken", "no_calendar_available", "conflict"],
  recoveryPosture: { retries: "bounded", alternatives: true, askCustomer: true, escalate: "last_resort" },
  approval: "configurable",
  dedupKey: ["customer", "meeting_kind", "day"],
};

const MOVE_MEETING: OperationContract = {
  id: "MOVE_MEETING",
  capability: "CALENDAR",
  effect: "write",
  meaning: "change the time of my existing meeting",
  params: [{ key: "desired_time", meaning: "the new time the customer wants", required: true }],
  outcome: "moved to <time>, invite updated",
  success: {
    id: "meeting_moved",
    statement: "the customer's existing meeting now occurs at the new agreed time, still exactly one meeting, parties re-notified",
  },
  invariants: [
    {
      id: "existing_booking_present",
      statement: "an existing booking is present to move",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "FAILED", reason: "nothing_to_move" },
    },
    {
      id: "booking_unambiguous",
      statement: "exactly one existing booking is identified (not several)",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "which_booking" },
    },
    {
      id: "new_time_provided",
      statement: "a new time was provided",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "time" },
    },
    {
      id: "new_time_genuinely_open",
      statement: "the new time is genuinely open",
      strength: "SHOULD",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      satisfierOperation: "CHECK_AVAILABILITY",
    },
    {
      id: "single_meeting_after",
      statement: "exactly one meeting exists afterward (the move never creates a duplicate)",
      strength: "MUST",
      checkpoint: "POST",
      enforcement: "RUNTIME_VERIFIED",
    },
  ],
  failureModes: ["time_taken", "no_calendar_available"],
  recoveryPosture: { retries: "bounded", alternatives: true, askCustomer: true, escalate: "last_resort" },
  approval: "configurable",
};

const CANCEL_MEETING: OperationContract = {
  id: "CANCEL_MEETING",
  capability: "CALENDAR",
  effect: "write",
  destructive: true,
  meaning: "cancel my meeting",
  params: [],
  outcome: "your meeting on <time> is cancelled",
  success: {
    id: "meeting_cancelled",
    statement: "the customer has no active meeting for that booking and parties were notified",
  },
  invariants: [
    {
      id: "existing_booking_present",
      statement: "an existing booking is present to cancel",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "FAILED", reason: "nothing_to_cancel" },
    },
    {
      id: "booking_unambiguous",
      statement: "exactly one existing booking is identified (not several)",
      strength: "MUST",
      checkpoint: "PRE",
      enforcement: "RUNTIME_VERIFIED",
      onUnsatisfied: { kind: "NEEDS_INPUT", field: "which_booking" },
    },
  ],
  failureModes: ["no_calendar_available"],
  // Destructive → no blind re-attempts; a transient failure returns FAILED for the planner to handle.
  recoveryPosture: { retries: "none", alternatives: false, askCustomer: true, escalate: "last_resort" },
  approval: "configurable",
};

export const CALENDAR_CONTRACTS: Record<string, OperationContract> = {
  CHECK_AVAILABILITY,
  BOOK_MEETING,
  MOVE_MEETING,
  CANCEL_MEETING,
};
