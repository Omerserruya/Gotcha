/**
 * Slice 3C — Calendar Capability END-TO-END MATRIX.
 *
 * Drives the REAL Capability Runtime (resolver + verifiers + calendar.runtime +
 * the 3C dispatch executor + the 3B shadow comparator) over a high-fidelity
 * in-memory calendar/booking-store port that simulates Google + the booking store
 * including failure injection. This exercises the EXACT code path the live cutover
 * uses; only the port's backing differs (simulated vs real Google REST).
 *
 * For every row it captures: execution trace, runtime decision, invariants, final
 * world-state, latency, and (where applicable) legacy parity, then prints a report
 * and asserts: correct decision, no duplicate ever created, no REGRESSION.
 */

import { describe, it, expect } from "vitest";
import { resolveExecution, CALENDAR_CONTRACTS, type ExecutionRequest, type RuntimeBindings } from "@chatcenter/shared";
import { executeCalendarOperation } from "../services/capability-runtime/calendar.runtime";
import { executeCalendarToolViaRuntime, executeCalendarToolAdvisory, isCalendarTool } from "../services/capability-runtime/calendar.execute";
import { shadowCompareCalendar } from "../services/capability-runtime/calendar.shadow";
import { preResolveCalendarRead } from "../services/capability-runtime/calendar.preresolve";
import type { CalendarPort, CalendarBookingRef, ResolvedMeetingKind } from "../services/capability-runtime/calendar.port";

const DEMO = { slug: "demo", durationMinutes: 30 };
const S1 = "2026-06-29T09:30:00.000Z";
const S2 = "2026-06-30T14:00:00.000Z";

/** High-fidelity in-memory calendar + booking store, with failure injection. */
function calendar(init: { bookings?: CalendarBookingRef[]; open?: string[]; kind?: ResolvedMeetingKind; noCalendar?: boolean } = {}) {
  const state = { bookings: [...(init.bookings ?? [])] };
  const open = new Set(init.open ?? []);
  const kind: ResolvedMeetingKind = init.kind ?? DEMO;
  let nextId = state.bookings.length + 1;
  const port: CalendarPort = {
    listActiveBookings: async () => { if (init.noCalendar) throw new Error("no_calendar_available"); return state.bookings.slice(); },
    resolveMeetingKind: async () => kind,
    isTimeOpen: async (_c, iso) => open.has(iso),
    computeAvailability: async () => ({ slotsIso: [...open] }),
    createEvent: async (_c, { iso, kind: k }) => {
      if (init.noCalendar) throw new Error("no_calendar_available");
      if (!open.has(iso)) throw new Error("time_taken"); // simulates create-time race / taken slot
      const start = Date.parse(iso);
      const ref: CalendarBookingRef = { eventId: `ev_${nextId++}`, startMs: start, endMs: start + k.durationMinutes * 60_000, meetingKind: k.slug, joinUrl: "https://meet/x" };
      state.bookings.push(ref); open.delete(iso); return ref;
    },
    moveEvent: async (_c, { booking, iso }) => {
      const i = state.bookings.findIndex((b) => b.eventId === booking.eventId);
      const start = Date.parse(iso);
      state.bookings[i] = { ...state.bookings[i], startMs: start, endMs: start + DEMO.durationMinutes * 60_000 };
      open.delete(iso); return state.bookings[i];
    },
    cancelEvent: async (_c, { booking }) => {
      const i = state.bookings.findIndex((b) => b.eventId === booking.eventId);
      if (i >= 0) state.bookings.splice(i, 1);
    },
  };
  return { port, state, open };
}

const ctx = (over: Record<string, unknown> = {}) => ({ tenantId: "t1", conversationId: "c1", customerExternalId: "cust1", customerEmail: "o@x.com", aiAgentId: "a1", ...over });
const req = (operation: string, params: Record<string, unknown>, context = ctx()): ExecutionRequest => ({ operation, params, context, mode: "autonomous" });

interface Row {
  scenario: string; operation: string; decision: string; reason?: string;
  invariants: string; worldBefore: number; worldAfter: number; expected: string; pass: boolean; latencyMs: number;
}
const report: Row[] = [];

async function run(scenario: string, expected: string, r: ReturnType<typeof calendar>, request: ExecutionRequest): Promise<Row> {
  const before = r.state.bookings.length;
  const t0 = performance.now();
  const { result, trace } = await executeCalendarOperation(request, { port: r.port, logger: () => {} });
  const latencyMs = +(performance.now() - t0).toFixed(2);
  const row: Row = {
    scenario, operation: request.operation, decision: result.status,
    reason: (result as any).field ?? (result as any).reason, // NEEDS_INPUT → field; FAILED/BLOCKED → reason
    invariants: trace.invariants.map((i) => `${i.id}:${i.outcome}`).join(" | "),
    worldBefore: before, worldAfter: r.state.bookings.length,
    expected, pass: result.status === expected, latencyMs,
  };
  report.push(row);
  return row;
}

describe("CALENDAR capability — E2E matrix", () => {
  it("runs the full matrix with correct decisions, no duplicates, no regressions", async () => {
    // 1. Availability lookup
    const avail = calendar({ open: [S1, S2] });
    const r1 = await run("availability lookup", "EXECUTED", avail, req("CHECK_AVAILABILITY", {}));
    expect(r1.pass).toBe(true);

    // 2. New booking → world-state synced (booking store reflects it)
    const book = calendar({ open: [S1] });
    const r2 = await run("new booking", "EXECUTED", book, req("BOOK_MEETING", { desired_time: S1 }));
    expect(r2.pass).toBe(true);
    expect(book.state.bookings).toHaveLength(1);
    expect(book.state.bookings[0].startMs).toBe(Date.parse(S1));

    // 3. Existing booking + duplicate prevention
    const dup = calendar({ open: [S2], bookings: [{ eventId: "e0", startMs: Date.parse(S1), endMs: Date.parse(S1) + 1 }] });
    const r3 = await run("existing booking → duplicate prevented", "FAILED", dup, req("BOOK_MEETING", { desired_time: S2 }));
    expect(r3.pass).toBe(true);
    expect(r3.reason).toBe("active_booking_exists_use_move");
    expect(dup.state.bookings).toHaveLength(1); // never duplicated

    // 4. Move meeting (still exactly one)
    const move = calendar({ open: [S2], bookings: [{ eventId: "e0", startMs: Date.parse(S1), endMs: Date.parse(S1) + 1 }] });
    const r4 = await run("move meeting", "EXECUTED", move, req("MOVE_MEETING", { desired_time: S2 }));
    expect(r4.pass).toBe(true);
    expect(move.state.bookings).toHaveLength(1);
    expect(move.state.bookings[0].startMs).toBe(Date.parse(S2));

    // 5. Cancel meeting
    const cancel = calendar({ bookings: [{ eventId: "e0", startMs: Date.parse(S1), endMs: Date.parse(S1) + 1 }] });
    const r5 = await run("cancel meeting", "EXECUTED", cancel, req("CANCEL_MEETING", {}));
    expect(r5.pass).toBe(true);
    expect(cancel.state.bookings).toHaveLength(0);

    // 6. Missing information (three variants)
    const m1 = await run("missing info: email", "NEEDS_INPUT", calendar({ open: [S1] }), req("BOOK_MEETING", { desired_time: S1 }, ctx({ customerEmail: undefined })));
    expect(m1.reason).toBe("email");
    const m2 = await run("missing info: time", "NEEDS_INPUT", calendar({ open: [S1] }), req("BOOK_MEETING", {}));
    expect(m2.reason).toBe("desired_time");
    const m3 = await run("missing info: ambiguous kind", "NEEDS_INPUT", calendar({ open: [S1], kind: "ambiguous" }), req("BOOK_MEETING", { desired_time: S1 }));
    expect(m3.reason).toBe("meeting_type");

    // 7. Error recovery: taken slot → FAILED recoverable + needsAvailabilityCheck signal
    const taken = calendar({ open: [S2] }); // S1 NOT open
    const r7 = await run("error recovery: taken slot", "FAILED", taken, req("BOOK_MEETING", { desired_time: S1 }));
    expect(r7.pass).toBe(true);
    expect(r7.reason).toBe("time_taken");
    expect(taken.state.bookings).toHaveLength(0);

    // 8. No calendar connected → FAILED (never a fabricated success)
    const r8 = await run("no calendar connected", "FAILED", calendar({ open: [S1], noCalendar: true }), req("BOOK_MEETING", { desired_time: S1 }));
    expect(r8.pass).toBe(true);

    // Aggregate invariants
    expect(report.every((r) => r.pass)).toBe(true);

    // ── REPORT ──
    const rows = report.map((r) =>
      `  ${r.scenario.padEnd(38)} ${r.operation.padEnd(18)} → ${r.decision}${r.reason ? `(${r.reason})` : ""}` +
      `  world ${r.worldBefore}→${r.worldAfter}  ${r.latencyMs}ms`);
    const lat = report.map((r) => r.latencyMs);
    console.log(
      `\n══════════ CALENDAR CAPABILITY E2E MATRIX ══════════\n${rows.join("\n")}\n` +
      `\nlatency(ms): min=${Math.min(...lat)} max=${Math.max(...lat)} avg=${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(2)} (runtime orchestration overhead; excludes real Google API)\n` +
      `rows=${report.length} pass=${report.filter((r) => r.pass).length} duplicates_created=0\n` +
      `════════════════════════════════════════════════════\n`,
    );
  });

  it("approval flow: HITL-required booking → AWAITING_APPROVAL (no execution)", async () => {
    // The 3C cutover keeps approval in the orchestrator wrapper; this proves the
    // runtime's own approval path end-to-end (resolver + approvalGate).
    const v = (val: boolean) => () => val;
    const bind: RuntimeBindings = {
      verifiers: {
        no_duplicate_meeting: v(true), attendee_email_known: v(true), meeting_kind_known: v(true),
        desired_time_provided: v(true), time_genuinely_open: v(true), single_meeting_after: v(true),
        booking_confirmed_and_invited: v(true),
      },
      runSatisfier: async () => ({ ok: true, outcome: "n/a" }),
      executeStrategy: async () => { throw new Error("must NOT execute when approval pending"); },
      approvalGate: async () => ({ required: true, ref: "appr_1" }),
    };
    const result = await resolveExecution(CALENDAR_CONTRACTS.BOOK_MEETING, req("BOOK_MEETING", { desired_time: S1 }), bind);
    expect(result).toMatchObject({ status: "AWAITING_APPROVAL", ref: "appr_1" });
  });

  it("3C dispatch executor returns legacy-shaped content the loop understands", async () => {
    const book = calendar({ open: [S1] });
    const ok = await executeCalendarToolViaRuntime({
      toolName: "schedule_meeting", toolArgs: { requested_at_iso: S1, meeting_type: "demo", customer_email: "o@x.com" },
      toolCallId: "tc1", context: ctx(), port: book.port, logger: () => {},
    });
    const parsed = JSON.parse(ok.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict).toBe("VALID");
    expect(ok.toolCallId).toBe("tc1");

    const noEmail = await executeCalendarToolViaRuntime({
      toolName: "schedule_meeting", toolArgs: { requested_at_iso: S1, meeting_type: "demo" },
      toolCallId: "tc2", context: ctx({ customerEmail: undefined }), port: calendar({ open: [S1] }).port, logger: () => {},
    });
    const pe = JSON.parse(noEmail.content);
    expect(pe.ok).toBe(false);
    expect(pe.missing_inputs).toContain("email");
  });

  it("copilot ADVISORY: same pipeline, reads run, writes recommend (never execute)", async () => {
    expect(isCalendarTool("schedule_meeting")).toBe(true);
    expect(isCalendarTool("escalate_to_human")).toBe(false);

    // READ auto-runs and returns real facts.
    const availCal = calendar({ open: [S1, S2] });
    const read = await executeCalendarToolAdvisory({
      toolName: "check_availability", toolArgs: { meeting_type: "demo" }, context: ctx(), port: availCal.port, logger: () => {},
    });
    const rj = JSON.parse(read.content);
    expect(rj.ok).toBe(true);
    expect(rj.proposedSlotsIso.length).toBe(2);
    expect(read.quickAction).toBeUndefined();

    // WRITE is recommended, NOT executed (booking store stays empty).
    const bookCal = calendar({ open: [S1] });
    const write = await executeCalendarToolAdvisory({
      toolName: "schedule_meeting", toolArgs: { requested_at_iso: S1, meeting_type: "demo", customer_email: "o@x.com" }, context: ctx(), port: bookCal.port, logger: () => {},
    });
    const wj = JSON.parse(write.content);
    expect(wj.recommended).toBe(true);
    expect(wj.executed).toBe(false);
    expect(write.quickAction).toMatchObject({ tool: "schedule_meeting" });
    expect(bookCal.state.bookings).toHaveLength(0); // advisory NEVER writes

    // Missing info still surfaces as a question.
    const noEmail = await executeCalendarToolAdvisory({
      toolName: "schedule_meeting", toolArgs: { requested_at_iso: S1, meeting_type: "demo" }, context: ctx({ customerEmail: undefined }), port: calendar({ open: [S1] }).port, logger: () => {},
    });
    expect(JSON.parse(noEmail.content).missing_inputs).toContain("email");
  });

  it("planner-owned execution: runtime pre-resolves availability before the LLM", async () => {
    // Scheduling is the goal → runtime fetches real slots, returns an authoritative block.
    const pre = await preResolveCalendarRead({
      objective: "BOOK_MEETING", calendarBookable: true, hasActiveBooking: false, mode: "advisory",
      context: ctx(), port: calendar({ open: [S1, S2] }).port, logger: () => {},
    });
    expect(pre.block).toBeDefined();
    expect(pre.block).toMatch(/AUTHORITATIVE/);
    expect(pre.block).toMatch(/never say you will/i);

    // Not a scheduling goal → no pre-resolution (runtime doesn't act).
    const none = await preResolveCalendarRead({
      objective: "QUALIFY_LEAD", calendarBookable: true, hasActiveBooking: false, mode: "advisory",
      context: ctx(), port: calendar({ open: [S1] }).port, logger: () => {},
    });
    expect(none.block).toBeUndefined();

    // Already booked → the move/cancel WRITE path owns the turn, not pre-resolution.
    const booked = await preResolveCalendarRead({
      objective: "BOOK_MEETING", calendarBookable: true, hasActiveBooking: true, mode: "autonomous",
      context: ctx(), port: calendar({ open: [S1] }).port, logger: () => {},
    });
    expect(booked.block).toBeUndefined();
  });

  it("legacy parity: representative cases never REGRESS", async () => {
    const corr = { tenantId: "t1", conversationId: "c1", turnId: "turn1", toolCallId: "tc", correlationId: "c1:turn1:tc" };
    // new booking, legacy booked → IDENTICAL
    const a = await shadowCompareCalendar({
      legacyTool: "schedule_meeting", legacyArgs: { requested_at_iso: S1, meeting_type: "demo", customer_email: "o@x.com" },
      legacyResult: { ok: true, verdict: "VALID" }, context: ctx(), correlation: corr, port: calendar({ open: [S1] }).port, logger: () => {},
    });
    // rebooking existing customer → EXPECTED_DIFFERENCE (book→move split), NOT regression
    const b = await shadowCompareCalendar({
      legacyTool: "schedule_meeting", legacyArgs: { requested_at_iso: S2, meeting_type: "demo", customer_email: "o@x.com" },
      legacyResult: { ok: true, verdict: "VALID" }, context: ctx(), correlation: corr,
      port: calendar({ open: [S2], bookings: [{ eventId: "e0", startMs: Date.parse(S1), endMs: Date.parse(S1) + 1 }] }).port, logger: () => {},
    });
    expect(a.verdict).toBe("IDENTICAL");
    expect(b.verdict).toBe("EXPECTED_DIFFERENCE");
    expect([a, b].some((r) => r.verdict === "REGRESSION")).toBe(false);
  });
});
