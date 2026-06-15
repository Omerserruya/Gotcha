import { describe, it, expect } from "vitest";
import {
  resolveAvailability,
  type SchedulingPolicy,
  type MeetingType,
  type BusyInterval,
} from "../services/scheduling.service";

// Sun–Thu 09–18, Fri 09–13 in Asia/Jerusalem (matches the spec's example).
const ISRAEL_POLICY: SchedulingPolicy = {
  agentTimezone: "Asia/Jerusalem",
  workingHours: [
    { weekday: 0, start: "09:00", end: "18:00" }, // Sun
    { weekday: 1, start: "09:00", end: "18:00" }, // Mon
    { weekday: 2, start: "09:00", end: "18:00" }, // Tue
    { weekday: 3, start: "09:00", end: "18:00" }, // Wed
    { weekday: 4, start: "09:00", end: "18:00" }, // Thu
    { weekday: 5, start: "09:00", end: "13:00" }, // Fri
  ],
  bufferBeforeMinutes: 15,
  bufferAfterMinutes: 15,
  minNoticeHours: 4,
  maxHorizonDays: 30,
  slotResolutionMinutes: 30,
};

const DISCOVERY: MeetingType = { id: "discovery_call", durationMinutes: 30 };

// Helper - produce an ISO timestamp for a given Israel wall-clock day/time.
// We use UTC offset +03:00 (IDT) - these tests are deterministic; no DST across them.
function idtIso(day: string, hhmm: string): string {
  return `${day}T${hhmm}:00+03:00`;
}

describe("Scheduling - VALID path", () => {
  it("Tuesday 11:00 with empty calendar, asked 5+ hours ahead → VALID", () => {
    const requested = idtIso("2026-05-05", "11:00"); // Tue
    const now = Date.parse("2026-05-05T05:00:00+03:00"); // ~6h before
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("VALID");
    if (r.verdict === "VALID") {
      expect(r.slot.startMs).toBe(Date.parse(requested));
      expect(r.slot.endMs - r.slot.startMs).toBe(30 * 60_000);
    }
  });
});

describe("Scheduling - INVALID paths", () => {
  it("Saturday request → outside_working_hours", () => {
    const requested = idtIso("2026-05-09", "11:00"); // Sat
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") expect(r.reason).toBe("outside_working_hours");
  });

  it("Friday 14:00 (after Friday close) → outside_working_hours", () => {
    const requested = idtIso("2026-05-08", "14:00"); // Fri
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") expect(r.reason).toBe("outside_working_hours");
  });

  it("Booking 1 hour from now → min_notice_violated (policy=4h)", () => {
    const now = Date.parse("2026-05-05T10:00:00+03:00"); // Tue 10:00
    const requested = "2026-05-05T11:00:00+03:00"; // 1h ahead
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") expect(r.reason).toBe("min_notice_violated");
  });

  it("Booking 60 days from now → max_horizon_exceeded", () => {
    const now = Date.parse("2026-05-05T10:00:00+03:00");
    const requested = "2026-07-05T11:00:00+03:00";
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") expect(r.reason).toBe("max_horizon_exceeded");
  });

  it("Slot overlapping a busy interval → agent_busy", () => {
    const requested = idtIso("2026-05-05", "11:00");
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const busy: BusyInterval[] = [
      {
        startMs: Date.parse(idtIso("2026-05-05", "10:30")),
        endMs: Date.parse(idtIso("2026-05-05", "11:30")),
      },
    ];
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy,
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") expect(r.reason).toBe("agent_busy");
  });

  it("Slot inside the buffer zone → buffer_violated", () => {
    // Busy 09:30–10:00 + 15 min after-buffer means 10:00–10:15 is blocked.
    // Request 10:00 → 30-min meeting starts inside the buffer.
    const requested = idtIso("2026-05-05", "10:00");
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const busy: BusyInterval[] = [
      {
        startMs: Date.parse(idtIso("2026-05-05", "09:30")),
        endMs: Date.parse(idtIso("2026-05-05", "10:00")),
      },
    ];
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy,
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") expect(r.reason).toBe("buffer_violated");
  });

  it("Bad ISO input → bad_iso_input + still proposes alternatives", () => {
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: "tomorrow morning",
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") {
      expect(r.reason).toBe("bad_iso_input");
      expect(r.proposed.length).toBeGreaterThan(0);
    }
  });
});

describe("Scheduling - PROPOSE path", () => {
  it("No requested time → returns 3 valid slots, all in working hours", () => {
    const now = Date.parse("2026-05-05T05:00:00+03:00"); // Tue 05:00
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
    });
    expect(r.verdict).toBe("PROPOSE");
    if (r.verdict === "PROPOSE") {
      expect(r.proposed).toHaveLength(3);
      // All proposals must be after now+minNotice.
      for (const slot of r.proposed) {
        expect(slot.startMs).toBeGreaterThanOrEqual(now + ISRAEL_POLICY.minNoticeHours * 3600_000);
      }
    }
  });

  it("All slots respect buffer around busy intervals", () => {
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const busy: BusyInterval[] = [
      // Block 09:00–13:00 Tuesday
      {
        startMs: Date.parse(idtIso("2026-05-05", "09:00")),
        endMs: Date.parse(idtIso("2026-05-05", "13:00")),
      },
    ];
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy,
      nowMs: now,
      proposeCount: 2,
    });
    expect(r.verdict).toBe("PROPOSE");
    if (r.verdict === "PROPOSE") {
      // First proposal must be at or after 13:15 (busy_end + 15min before-buffer
      // applied to the next slot's start).
      const earliestAllowedMs = Date.parse(idtIso("2026-05-05", "13:15"));
      for (const slot of r.proposed) {
        // Either after the buffer or another day altogether.
        const sameDay = slot.startMs < Date.parse(idtIso("2026-05-06", "00:00"));
        if (sameDay) expect(slot.startMs).toBeGreaterThanOrEqual(earliestAllowedMs);
      }
    }
  });
});

describe("Scheduling - meeting type windows override working hours", () => {
  it("Discovery limited to 10:00–16:00 → 09:30 request rejected with outside_meeting_type_window", () => {
    const stricter: SchedulingPolicy = {
      ...ISRAEL_POLICY,
      meetingTypeWindows: {
        discovery_call: [
          { weekday: 0, start: "10:00", end: "16:00" },
          { weekday: 1, start: "10:00", end: "16:00" },
          { weekday: 2, start: "10:00", end: "16:00" },
          { weekday: 3, start: "10:00", end: "16:00" },
          { weekday: 4, start: "10:00", end: "16:00" },
        ],
      },
    };
    const requested = idtIso("2026-05-05", "09:30");
    const now = Date.parse("2026-05-04T05:00:00+03:00");
    const r = resolveAvailability({
      policy: stricter,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: requested,
    });
    expect(r.verdict).toBe("INVALID");
    if (r.verdict === "INVALID") expect(r.reason).toBe("outside_meeting_type_window");
  });
});
