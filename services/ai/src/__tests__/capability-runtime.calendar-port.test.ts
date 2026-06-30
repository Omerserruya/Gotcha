/**
 * Slice 3A — production CalendarPort delegation contract.
 *
 * Proves the prod port faithfully TRANSLATES between the abstract port and the
 * concrete handlers (no business logic of its own), with the handlers/store/prisma
 * mocked — no DB, no network. Behavioral parity on real data is 3B (shadow mode).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  checkFn: vi.fn(),
  scheduleFn: vi.fn(),
  rescheduleFn: vi.fn(),
  cancelFn: vi.fn(),
  findActiveBookings: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("../services/schedule-handler.service", () => ({
  makeCheckAvailabilityHandler: () => h.checkFn,
  makeScheduleMeetingHandler: () => h.scheduleFn,
  makeRescheduleMeetingHandler: () => h.rescheduleFn,
  makeCancelMeetingHandler: () => h.cancelFn,
  snapMeetingType: (hint: string | undefined, rows: Array<{ slug: string }>) =>
    rows.find((r) => r.slug === hint) ?? (rows.length === 1 ? rows[0] : null),
}));
vi.mock("../services/booking-store.service", () => ({ findActiveBookings: h.findActiveBookings }));
vi.mock("@chatcenter/shared", () => ({ prisma: { meetingType: { findMany: h.findMany } } }));

import { createProdCalendarPort } from "../services/capability-runtime/calendar.port.prod";

const ctx = { tenantId: "t1", conversationId: "c1", customerExternalId: "cust1", customerEmail: "o@x.com", aiAgentId: "a1" };
const DEMO = { slug: "demo", durationMinutes: 30 };
const port = createProdCalendarPort();

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
});

describe("prod CalendarPort delegation", () => {
  it("listActiveBookings maps store rows to refs", async () => {
    h.findActiveBookings.mockResolvedValue([{ eventId: "e1", startMs: 10, endMs: 20, meetingTypeSlug: "demo", joinUrl: "u" }]);
    expect(await port.listActiveBookings(ctx)).toEqual([{ eventId: "e1", startMs: 10, endMs: 20, meetingKind: "demo", joinUrl: "u" }]);
  });

  it("resolveMeetingKind: single type → that kind; none → null; many+no match → ambiguous", async () => {
    h.findMany.mockResolvedValueOnce([{ slug: "demo", name: "Demo", durationMinutes: 30 }]);
    expect(await port.resolveMeetingKind(ctx)).toEqual({ slug: "demo", durationMinutes: 30 });
    h.findMany.mockResolvedValueOnce([]);
    expect(await port.resolveMeetingKind(ctx)).toBeNull();
    h.findMany.mockResolvedValueOnce([{ slug: "a", name: "A", durationMinutes: 30 }, { slug: "b", name: "B", durationMinutes: 45 }]);
    expect(await port.resolveMeetingKind(ctx, "zzz")).toBe("ambiguous");
  });

  it("isTimeOpen reads the point-check verdict", async () => {
    h.checkFn.mockResolvedValueOnce({ ok: true, requestedAvailable: true });
    expect(await port.isTimeOpen(ctx, "2026-06-29T09:30:00Z", DEMO)).toBe(true);
    h.checkFn.mockResolvedValueOnce({ ok: true, requestedAvailable: false });
    expect(await port.isTimeOpen(ctx, "2026-06-29T09:30:00Z", DEMO)).toBe(false);
    h.checkFn.mockResolvedValueOnce({ ok: false, reason: "no_calendar_connected" });
    expect(await port.isTimeOpen(ctx, "2026-06-29T09:30:00Z", DEMO)).toBe(false);
  });

  it("computeAvailability returns real slots, [] on failure", async () => {
    h.checkFn.mockResolvedValueOnce({ ok: true, proposedSlotsIso: ["s1", "s2"] });
    expect(await port.computeAvailability(ctx, DEMO)).toEqual({ slotsIso: ["s1", "s2"] });
    h.checkFn.mockResolvedValueOnce({ ok: false, reason: "no_calendar_connected" });
    expect(await port.computeAvailability(ctx, DEMO)).toEqual({ slotsIso: [] });
  });

  it("createEvent passes the right args, maps VALID → ref, throws the reason on failure", async () => {
    h.scheduleFn.mockResolvedValueOnce({ ok: true, verdict: "VALID", eventId: "ev9", startMs: 100, endMs: 200, joinUrl: "j" });
    const ref = await port.createEvent(ctx, { iso: "2026-06-29T09:30:00Z", email: "o@x.com", kind: DEMO });
    expect(ref).toMatchObject({ eventId: "ev9", startMs: 100, endMs: 200, joinUrl: "j", meetingKind: "demo" });
    expect(h.scheduleFn).toHaveBeenCalledWith({ requested_at_iso: "2026-06-29T09:30:00Z", duration_minutes: 30, meeting_type: "demo", customer_email: "o@x.com" });

    h.scheduleFn.mockResolvedValueOnce({ ok: false, reason: "no_calendar_connected" });
    await expect(port.createEvent(ctx, { iso: "x", email: "o@x.com", kind: DEMO })).rejects.toThrow("no_calendar_connected");
  });

  it("moveEvent delegates to reschedule, throws on failure", async () => {
    h.rescheduleFn.mockResolvedValueOnce({ ok: true, verdict: "VALID", eventId: "ev9", startMs: 1, endMs: 2 });
    const ref = await port.moveEvent(ctx, { booking: { eventId: "ev9", startMs: 0, endMs: 0 }, iso: "2026-06-30T14:00:00Z", kind: DEMO });
    expect(ref.eventId).toBe("ev9");
    expect(h.rescheduleFn).toHaveBeenCalledWith({ requested_at_iso: "2026-06-30T14:00:00Z" });
    h.rescheduleFn.mockResolvedValueOnce({ ok: false, reason: "no_existing_meeting" });
    await expect(port.moveEvent(ctx, { booking: { eventId: "x", startMs: 0, endMs: 0 }, iso: "x", kind: DEMO })).rejects.toThrow("no_existing_meeting");
  });

  it("cancelEvent resolves on ok, throws the reason on failure", async () => {
    h.cancelFn.mockResolvedValueOnce({ ok: true, cancelled: true });
    await expect(port.cancelEvent(ctx, { booking: { eventId: "e", startMs: 0, endMs: 0 } })).resolves.toBeUndefined();
    h.cancelFn.mockResolvedValueOnce({ ok: false, reason: "no_existing_meeting" });
    await expect(port.cancelEvent(ctx, { booking: { eventId: "e", startMs: 0, endMs: 0 } })).rejects.toThrow("no_existing_meeting");
  });
});
