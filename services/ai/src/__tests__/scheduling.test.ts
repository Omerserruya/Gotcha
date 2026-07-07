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

  it("14:30 taken → proposes the NEAREST free slots around it, not the morning", () => {
    const requested = idtIso("2026-05-05", "14:30"); // Tue
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const busy: BusyInterval[] = [
      {
        startMs: Date.parse(idtIso("2026-05-05", "14:30")),
        endMs: Date.parse(idtIso("2026-05-05", "15:00")),
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
    if (r.verdict === "INVALID") {
      expect(r.reason).toBe("agent_busy");
      expect(r.proposed.length).toBeGreaterThan(0);
      const reqMs = Date.parse(requested);
      // Old behavior returned the day's first free slots (09:00/10:00/11:00).
      // New behavior anchors to the request: every proposal sits near 14:30.
      for (const s of r.proposed) {
        expect(Math.abs(s.startMs - reqMs)).toBeLessThanOrEqual(2 * 3600_000);
      }
      const nearest = Math.min(...r.proposed.map((s) => Math.abs(s.startMs - reqMs)));
      expect(nearest).toBeLessThanOrEqual(90 * 60_000);
    }
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

  it("RFC-9557 IANA zone-suffixed ISO is parsed (not bad_iso_input), same instant", () => {
    // LLM reasoners emit e.g. 2026-05-05T10:00:00+03:00[Asia/Jerusalem]; Date.parse
    // chokes on the bracket. The numeric offset must still resolve to the same instant.
    const now = Date.parse("2026-05-05T05:00:00+03:00"); // Tue 05:00 IDT
    const base = idtIso("2026-05-05", "10:00"); // 2026-05-05T10:00:00+03:00
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      requestedAtIso: `${base}[Asia/Jerusalem]`,
    });
    expect(r.verdict).toBe("VALID");
    if (r.verdict === "VALID") expect(r.slot.startMs).toBe(Date.parse(base));
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

describe("Scheduling - windowed enumeration (check_availability)", () => {
  it("window before the first open slot → no proposals", () => {
    // Tue 05:00, window only 05:00–08:00 (before 09:00 open) → empty.
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      windowStartMs: now,
      windowEndMs: Date.parse(idtIso("2026-05-05", "08:00")),
    });
    expect(r.verdict).toBe("PROPOSE");
    if (r.verdict === "PROPOSE") expect(r.proposed).toHaveLength(0);
  });

  it("window confined to one afternoon → every proposal falls inside it", () => {
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    const winStart = Date.parse(idtIso("2026-05-05", "14:00"));
    const winEnd = Date.parse(idtIso("2026-05-05", "17:00"));
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      windowStartMs: winStart,
      windowEndMs: winEnd,
    });
    expect(r.verdict).toBe("PROPOSE");
    if (r.verdict === "PROPOSE") {
      expect(r.proposed.length).toBeGreaterThan(0);
      for (const s of r.proposed) {
        expect(s.startMs).toBeGreaterThanOrEqual(winStart);
        expect(s.endMs).toBeLessThanOrEqual(winEnd);
      }
    }
  });

  it("window cannot widen past the policy horizon", () => {
    const now = Date.parse("2026-05-05T05:00:00+03:00");
    // Ask 60 days out, but maxHorizon is 30d → clamps to nothing.
    const r = resolveAvailability({
      policy: ISRAEL_POLICY,
      meetingType: DISCOVERY,
      busy: [],
      nowMs: now,
      windowStartMs: now + 60 * 24 * 3600_000,
      windowEndMs: now + 61 * 24 * 3600_000,
    });
    expect(r.verdict).toBe("PROPOSE");
    if (r.verdict === "PROPOSE") expect(r.proposed).toHaveLength(0);
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
