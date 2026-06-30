/**
 * CALENDAR capability — integration through the real runtime (calendar.runtime)
 * over an in-memory fake CalendarPort (no network, no Prisma).
 *
 * Proves the business rules live ONCE (in verifiers): the same fake port + the
 * frozen contracts produce correct semantic outcomes and traces for the full
 * BOOK -> MOVE -> CANCEL lifecycle and every failure path.
 */

import { describe, it, expect } from "vitest";
import type { ExecutionRequest } from "@chatcenter/shared";
import { executeCalendarOperation } from "../services/capability-runtime/calendar.runtime";
import type {
  CalendarPort,
  CalendarBookingRef,
  ResolvedMeetingKind,
} from "../services/capability-runtime/calendar.port";

const DEMO = { slug: "demo", durationMinutes: 30 };
const T = (iso: string) => iso; // readability

function fakePort(init: { bookings?: CalendarBookingRef[]; open?: string[]; kind?: ResolvedMeetingKind; failCreate?: string } = {}) {
  const bookings: CalendarBookingRef[] = [...(init.bookings ?? [])];
  const open = new Set(init.open ?? []);
  const kind: ResolvedMeetingKind = init.kind ?? DEMO;
  let nextId = bookings.length + 1;
  const port: CalendarPort = {
    listActiveBookings: async () => bookings.slice(),
    resolveMeetingKind: async () => kind,
    isTimeOpen: async (_c, iso) => open.has(iso),
    computeAvailability: async () => ({ slotsIso: [...open] }),
    createEvent: async (_c, { iso, kind: k }) => {
      if (init.failCreate) throw new Error(init.failCreate);
      if (!open.has(iso)) throw new Error("time_taken");
      const start = Date.parse(iso);
      const ref: CalendarBookingRef = { eventId: `ev_${nextId++}`, startMs: start, endMs: start + k.durationMinutes * 60_000, meetingKind: k.slug, joinUrl: "https://meet/x" };
      bookings.push(ref);
      open.delete(iso);
      return ref;
    },
    moveEvent: async (_c, { booking, iso }) => {
      const i = bookings.findIndex((b) => b.eventId === booking.eventId);
      const start = Date.parse(iso);
      bookings[i] = { ...bookings[i], startMs: start, endMs: start + DEMO.durationMinutes * 60_000 };
      return bookings[i];
    },
    cancelEvent: async (_c, { booking }) => {
      const i = bookings.findIndex((b) => b.eventId === booking.eventId);
      if (i >= 0) bookings.splice(i, 1);
    },
  };
  return { port, bookings, open };
}

function creq(operation: string, params: Record<string, unknown> = {}, opts: { email?: string; mode?: ExecutionRequest["mode"] } = {}): ExecutionRequest {
  return {
    operation,
    params,
    mode: opts.mode ?? "autonomous",
    context: { tenantId: "t1", conversationId: "c1", customerExternalId: "cust1", customerEmail: opts.email, aiAgentId: "a1" },
  };
}

const SLOT = "2026-06-29T09:30:00.000Z";
const SILENT = { logger: () => {} };

describe("BOOK_MEETING via calendar runtime", () => {
  it("happy path → EXECUTED, books exactly one, success verified", async () => {
    const { port, bookings } = fakePort({ open: [SLOT] });
    const { result, trace } = await executeCalendarOperation(
      creq("BOOK_MEETING", { desired_time: SLOT }, { email: "o@x.com" }),
      { port, ...SILENT },
    );
    expect(result.status).toBe("EXECUTED");
    expect(bookings).toHaveLength(1);
    expect(trace.successVerified).toBe(true);
    // probe-first optimization: the open time wasn't re-read.
    expect(trace.optimizations.join(" ")).toMatch(/probe-first/);
  });

  it("missing email → NEEDS_INPUT(email), nothing booked", async () => {
    const { port, bookings } = fakePort({ open: [SLOT] });
    const { result, trace } = await executeCalendarOperation(creq("BOOK_MEETING", { desired_time: SLOT }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "email" });
    expect(bookings).toHaveLength(0);
    expect(trace.executed).toBe(false);
  });

  it("missing time → NEEDS_INPUT(desired_time)", async () => {
    const { port } = fakePort({ open: [SLOT] });
    const { result } = await executeCalendarOperation(creq("BOOK_MEETING", {}, { email: "o@x.com" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "desired_time" });
  });

  it("existing booking → FAILED active_booking_exists_use_move (assertion-carved)", async () => {
    const existing: CalendarBookingRef = { eventId: "ev_0", startMs: Date.parse(SLOT), endMs: Date.parse(SLOT) + 1, meetingKind: "demo" };
    const { port } = fakePort({ open: [SLOT], bookings: [existing] });
    const { result } = await executeCalendarOperation(creq("BOOK_MEETING", { desired_time: SLOT }, { email: "o@x.com" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "FAILED", reason: "active_booking_exists_use_move" });
  });

  it("SHOULD doesn't block, but a taken slot fails at the strategy with recovery data", async () => {
    const { port } = fakePort({ open: ["2026-06-29T11:00:00.000Z"] }); // a DIFFERENT slot is open
    const { result, trace } = await executeCalendarOperation(
      creq("BOOK_MEETING", { desired_time: SLOT }, { email: "o@x.com" }), // SLOT itself not open
      { port, ...SILENT },
    );
    expect(result).toMatchObject({ status: "FAILED", reason: "time_taken" });
    expect(trace.invariants.find((i) => i.id === "time_genuinely_open")?.outcome).toBe("skipped_should");
    expect(trace.executed).toBe(true);
  });

  it("advisory mode recommends, never books", async () => {
    const { port, bookings } = fakePort({ open: [SLOT] });
    const { result } = await executeCalendarOperation(creq("BOOK_MEETING", { desired_time: SLOT }, { email: "o@x.com", mode: "advisory" }), { port, ...SILENT });
    expect(result.status).toBe("RECOMMENDED");
    expect(bookings).toHaveLength(0);
  });

  it("ambiguous meeting kind → NEEDS_INPUT(meeting_type)", async () => {
    const { port } = fakePort({ open: [SLOT], kind: "ambiguous" });
    const { result } = await executeCalendarOperation(creq("BOOK_MEETING", { desired_time: SLOT }, { email: "o@x.com" }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "meeting_type" });
  });
});

describe("MOVE_MEETING via calendar runtime", () => {
  const NEW = "2026-06-30T14:00:00.000Z";
  it("no booking → FAILED nothing_to_move", async () => {
    const { port } = fakePort({ open: [NEW] });
    const { result } = await executeCalendarOperation(creq("MOVE_MEETING", { desired_time: NEW }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "FAILED", reason: "nothing_to_move" });
  });

  it("two bookings → NEEDS_INPUT(which_booking)", async () => {
    const two: CalendarBookingRef[] = [
      { eventId: "a", startMs: Date.parse(SLOT), endMs: Date.parse(SLOT) + 1 },
      { eventId: "b", startMs: Date.parse(NEW), endMs: Date.parse(NEW) + 1 },
    ];
    const { port } = fakePort({ open: [NEW], bookings: two });
    const { result } = await executeCalendarOperation(creq("MOVE_MEETING", { desired_time: NEW }), { port, ...SILENT });
    expect(result).toMatchObject({ status: "NEEDS_INPUT", field: "which_booking" });
  });

  it("happy path → EXECUTED, still exactly one meeting (never duplicates)", async () => {
    const one: CalendarBookingRef[] = [{ eventId: "a", startMs: Date.parse(SLOT), endMs: Date.parse(SLOT) + 1 }];
    const { port, bookings } = fakePort({ open: [NEW], bookings: one });
    const { result, trace } = await executeCalendarOperation(creq("MOVE_MEETING", { desired_time: NEW }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect(bookings).toHaveLength(1);
    expect(bookings[0].startMs).toBe(Date.parse(NEW));
    expect(trace.invariants.find((i) => i.id === "single_meeting_after")?.outcome).toBe("held");
  });
});

describe("CANCEL_MEETING via calendar runtime", () => {
  it("nothing to cancel → FAILED nothing_to_cancel", async () => {
    const { port } = fakePort();
    const { result } = await executeCalendarOperation(creq("CANCEL_MEETING"), { port, ...SILENT });
    expect(result).toMatchObject({ status: "FAILED", reason: "nothing_to_cancel" });
  });

  it("happy path → EXECUTED, booking removed", async () => {
    const one: CalendarBookingRef[] = [{ eventId: "a", startMs: Date.parse(SLOT), endMs: Date.parse(SLOT) + 1 }];
    const { port, bookings } = fakePort({ bookings: one });
    const { result, trace } = await executeCalendarOperation(creq("CANCEL_MEETING"), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect(bookings).toHaveLength(0);
    expect(trace.successVerified).toBe(true);
  });
});

describe("CHECK_AVAILABILITY via calendar runtime", () => {
  it("returns real open slots (read, executes in any mode)", async () => {
    const { port } = fakePort({ open: [SLOT, "2026-06-29T11:00:00.000Z"] });
    const { result, trace } = await executeCalendarOperation(creq("CHECK_AVAILABILITY", {}, { mode: "advisory" }), { port, ...SILENT });
    expect(result.status).toBe("EXECUTED");
    expect((result as any).outcome).toMatch(/09:30/);
    expect(trace.invariants.find((i) => i.id === "returned_times_genuinely_open")?.outcome).toBe("held");
  });
});

describe("full lifecycle on one calendar", () => {
  it("BOOK → MOVE → CANCEL, never more than one meeting", async () => {
    const A = SLOT, B = "2026-06-30T14:00:00.000Z";
    const { port, bookings } = fakePort({ open: [A, B] });

    const booked = await executeCalendarOperation(creq("BOOK_MEETING", { desired_time: A }, { email: "o@x.com" }), { port, ...SILENT });
    expect(booked.result.status).toBe("EXECUTED");
    expect(bookings).toHaveLength(1);

    const moved = await executeCalendarOperation(creq("MOVE_MEETING", { desired_time: B }), { port, ...SILENT });
    expect(moved.result.status).toBe("EXECUTED");
    expect(bookings).toHaveLength(1);
    expect(bookings[0].startMs).toBe(Date.parse(B));

    const cancelled = await executeCalendarOperation(creq("CANCEL_MEETING"), { port, ...SILENT });
    expect(cancelled.result.status).toBe("EXECUTED");
    expect(bookings).toHaveLength(0);
  });
});
