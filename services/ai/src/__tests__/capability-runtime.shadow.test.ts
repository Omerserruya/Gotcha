/**
 * Slice 3B — shadow comparator: four-way verdicts + reasoning-path capture.
 * Fake in-memory port, synthetic legacy results. No DB, no network, no writes.
 */

import { describe, it, expect } from "vitest";
import { shadowCompareCalendar } from "../services/capability-runtime/calendar.shadow";
import type { CalendarPort, CalendarBookingRef, ResolvedMeetingKind } from "../services/capability-runtime/calendar.port";

const DEMO = { slug: "demo", durationMinutes: 30 };
const SLOT = "2026-06-29T09:30:00.000Z";

function fakePort(init: { bookings?: CalendarBookingRef[]; open?: string[]; kind?: ResolvedMeetingKind; throwReads?: boolean } = {}): CalendarPort {
  const bookings = [...(init.bookings ?? [])];
  const open = new Set(init.open ?? []);
  const kind: ResolvedMeetingKind = init.kind ?? DEMO;
  return {
    listActiveBookings: async () => { if (init.throwReads) throw new Error("boom"); return bookings.slice(); },
    resolveMeetingKind: async () => kind,
    isTimeOpen: async (_c, iso) => open.has(iso),
    computeAvailability: async () => ({ slotsIso: [...open] }),
    createEvent: async () => { throw new Error("must_not_execute_in_shadow"); },
    moveEvent: async () => { throw new Error("must_not_execute_in_shadow"); },
    cancelEvent: async () => { throw new Error("must_not_execute_in_shadow"); },
  };
}

const ctx = { tenantId: "t1", conversationId: "c1", customerExternalId: "cust1", customerEmail: "o@x.com", aiAgentId: "a1" };
const SILENT = () => {};
const CORR = { tenantId: "t1", conversationId: "c1", turnId: "turn1", toolCallId: "tc1", correlationId: "c1:turn1:tc1" };
// Inject a default correlation + silent logger into every call under test.
const sc = (i: Record<string, unknown>) => shadowCompareCalendar({ correlation: CORR, logger: SILENT, ...(i as any) });

describe("shadow comparator verdicts", () => {
  it("IDENTICAL: new would book, legacy booked", async () => {
    const rec = await sc({
      legacyTool: "schedule_meeting",
      legacyArgs: { requested_at_iso: SLOT, meeting_type: "demo", customer_email: "o@x.com" },
      legacyResult: { ok: true, verdict: "VALID", eventId: "e1", startMs: 1, endMs: 2 },
      context: ctx, plannerGoal: "BOOK_MEETING", port: fakePort({ open: [SLOT] }), logger: SILENT,
    });
    expect(rec.verdict).toBe("IDENTICAL");
    expect(rec.runtimeDecision).toBe("RECOMMENDED"); // advisory: never executed
  });

  it("EXPECTED_DIFFERENCE: book→move split (legacy rescheduled an existing booking)", async () => {
    const existing: CalendarBookingRef = { eventId: "e0", startMs: Date.parse(SLOT), endMs: Date.parse(SLOT) + 1 };
    const rec = await sc({
      legacyTool: "schedule_meeting",
      legacyArgs: { requested_at_iso: SLOT, meeting_type: "demo", customer_email: "o@x.com" },
      legacyResult: { ok: true, verdict: "VALID", eventId: "e0", startMs: 1, endMs: 2 }, // legacy dedupe→reschedule
      context: ctx, plannerGoal: "BOOK_MEETING", port: fakePort({ open: [SLOT], bookings: [existing] }), logger: SILENT,
    });
    expect(rec.verdict).toBe("EXPECTED_DIFFERENCE");
    expect(rec.detail).toMatch(/book.?move/i);
  });

  it("REGRESSION: new would block (needs email) where legacy completed", async () => {
    const noEmailCtx = { ...ctx, customerEmail: undefined };
    const rec = await sc({
      legacyTool: "schedule_meeting",
      legacyArgs: { requested_at_iso: SLOT, meeting_type: "demo" },
      legacyResult: { ok: true, verdict: "VALID", eventId: "e1", startMs: 1, endMs: 2 },
      context: noEmailCtx, plannerGoal: "BOOK_MEETING", port: fakePort({ open: [SLOT] }), logger: SILENT,
    });
    expect(rec.verdict).toBe("REGRESSION");
    expect(rec.runtimeDecision).toBe("NEEDS_INPUT");
  });

  it("IDENTICAL: check_availability same slots", async () => {
    const rec = await sc({
      legacyTool: "check_availability",
      legacyArgs: { meeting_type: "demo" },
      legacyResult: { ok: true, proposedSlotsIso: [SLOT, "2026-06-29T11:00:00.000Z"] },
      context: ctx, port: fakePort({ open: [SLOT, "2026-06-29T11:00:00.000Z"] }), logger: SILENT,
    });
    expect(rec.verdict).toBe("IDENTICAL");
  });

  it("REGRESSION: shadow lost availability legacy had", async () => {
    const rec = await sc({
      legacyTool: "check_availability",
      legacyArgs: { meeting_type: "demo" },
      legacyResult: { ok: true, proposedSlotsIso: [SLOT] },
      context: ctx, port: fakePort({ open: [] }), logger: SILENT,
    });
    expect(rec.verdict).toBe("REGRESSION");
  });

  it("IDENTICAL: MOVE with no booking ↔ legacy no_existing_meeting", async () => {
    const rec = await sc({
      legacyTool: "reschedule_meeting",
      legacyArgs: { requested_at_iso: SLOT },
      legacyResult: { ok: false, reason: "no_existing_meeting" },
      context: ctx, port: fakePort({ open: [SLOT] }), logger: SILENT,
    });
    expect(rec.verdict).toBe("IDENTICAL");
    expect(rec.runtimeReason).toBe("nothing_to_move");
  });

  it("never throws when the calendar read fails (observable verdict, not a crash)", async () => {
    const rec = await sc({
      legacyTool: "schedule_meeting",
      legacyArgs: { requested_at_iso: SLOT, meeting_type: "demo", customer_email: "o@x.com" },
      legacyResult: { ok: true, verdict: "VALID" },
      context: ctx, port: fakePort({ throwReads: true }),
    });
    // The runtime now turns a calendar-down into a traced FAILED rather than a
    // throw, so the comparison still yields one of the four verdicts (no crash).
    expect(["IDENTICAL", "EXPECTED_DIFFERENCE", "REGRESSION", "UNKNOWN"]).toContain(rec.verdict);
  });

  it("UNKNOWN: an unmapped tool can't be compared", async () => {
    const rec = await sc({ legacyTool: "frobnicate", legacyArgs: {}, legacyResult: { ok: true }, context: ctx, port: fakePort({ open: [SLOT] }) });
    expect(rec.verdict).toBe("UNKNOWN");
  });

  it("captures the full reasoning path", async () => {
    const rec = await sc({
      legacyTool: "schedule_meeting",
      legacyArgs: { requested_at_iso: SLOT, meeting_type: "demo", customer_email: "o@x.com" },
      legacyResult: { ok: true, verdict: "VALID" },
      context: ctx, plannerGoal: "get a demo booked", port: fakePort({ open: [SLOT] }), logger: SILENT,
    });
    expect(rec.plannerGoal).toBe("get a demo booked");
    expect(rec.selectedOperation).toBe("BOOK_MEETING");
    expect(rec.invariants.length).toBeGreaterThan(0);
    expect(rec.satisfiedAlready).toContain("no_duplicate_meeting");
    expect(rec.satisfiedAlready).toContain("attendee_email_known");
    expect(typeof rec.runtimeDecision).toBe("string");
    expect(["IDENTICAL", "EXPECTED_DIFFERENCE", "REGRESSION", "UNKNOWN"]).toContain(rec.verdict);
  });

  it("carries the correlation id and is fully JSON-serializable (offline replay)", async () => {
    const rec = await sc({
      legacyTool: "schedule_meeting",
      legacyArgs: { requested_at_iso: SLOT, meeting_type: "demo", customer_email: "o@x.com" },
      legacyResult: { ok: true, verdict: "VALID" },
      context: ctx, plannerGoal: "get a demo booked", port: fakePort({ open: [SLOT] }),
    });
    expect(rec.correlation).toEqual(CORR);
    // Round-trips with no loss / no functions / no cycles.
    const json = JSON.stringify(rec);
    const back = JSON.parse(json);
    expect(back.correlation.correlationId).toBe("c1:turn1:tc1");
    expect(back.verdict).toBe(rec.verdict);
    expect(back.invariants.length).toBe(rec.invariants.length);
  });
});
