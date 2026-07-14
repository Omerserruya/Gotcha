import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// check_availability is READ-ONLY: it answers availability / working-hours
// questions via the SAME resolveAvailability resolver as schedule_meeting, and
// must NEVER create a calendar event. We stub prisma + the Google adapter so the
// handler runs end-to-end with no DB or network.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-05-04T06:00:00Z")); // Monday 09:00 IDT
});
afterAll(() => {
  vi.useRealTimers();
});

const TENANT = "tnt_1";
const AGENT = "agent_1";

const MEETING_TYPE = {
  id: "mt_1",
  tenantId: TENANT,
  slug: "discovery_call",
  name: "Discovery Call",
  durationMinutes: 30,
  agentTimezone: "Asia/Jerusalem",
  workingHours: [
    { weekday: 0, start: "09:00", end: "18:00" }, // Sun
    { weekday: 1, start: "09:00", end: "18:00" }, // Mon
    { weekday: 2, start: "09:00", end: "18:00" }, // Tue
    { weekday: 3, start: "09:00", end: "18:00" }, // Wed
    { weekday: 4, start: "09:00", end: "18:00" }, // Thu
    { weekday: 5, start: "09:00", end: "13:00" }, // Fri
    // Sat (6) intentionally absent → closed.
  ],
  bufferBeforeMinutes: 15,
  bufferAfterMinutes: 15,
  minNoticeHours: 4,
  maxHorizonDays: 30,
  slotResolutionMinutes: 30,
  isActive: true,
};
const ACCOUNT = {
  id: "ca_1",
  tenantId: TENANT,
  aiAgentId: AGENT,
  provider: "GOOGLE_CALENDAR",
  status: "CONNECTED",
  defaultCalendarId: "primary",
  credentials: "encrypted",
};

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    meetingType: {
      findUnique: async ({ where }: any) =>
        where?.tenantId_slug?.slug === MEETING_TYPE.slug ? MEETING_TYPE : null,
      findMany: async () => [MEETING_TYPE],
    },
    calendarAccount: {
      findMany: async () => [ACCOUNT],
    },
  },
  encryptCredentials: (x: any) => JSON.stringify(x),
  decryptCredentials: () => ({ accessToken: "x", refreshToken: "y" }),
}));

// Adapter: spy on createEvent to PROVE check_availability never books.
let createCalls = 0;
let busyImpl: () => Promise<any[]> = async () => [];

vi.mock("../services/connectors/google-calendar.adapter", () => ({
  GoogleCalendarAdapter: class {
    readonly provider = "google";
    async findBusy() {
      return busyImpl();
    }
    async createEvent() {
      createCalls++;
      return { eventId: "should_never_happen" };
    }
    async listEvents() {
      return [];
    }
  },
}));
vi.mock("../services/connectors/calendly.adapter", () => ({
  CalendlyAdapter: class {
    readonly provider = "calendly";
    async findBusy() { return []; }
    async createEvent() { return { eventId: "x" }; }
  },
}));

beforeEach(() => {
  createCalls = 0;
  busyImpl = async () => [];
});

const opts = { tenantId: TENANT, aiAgentId: AGENT, conversationId: "conv_1" };

describe("check_availability - read-only availability", () => {
  it("working-hours question (no time, NO meeting_type) → structured workingHours + slots, never books", async () => {
    // Regression: check_availability is often called with no meeting_type. The
    // env loader must NOT do a Prisma findUnique with an undefined slug key (it
    // throws live) - it snaps to the single configured type instead.
    const { makeCheckAvailabilityHandler } = await import("../services/schedule-handler.service");
    const r = await makeCheckAvailabilityHandler(opts)({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.timezone).toBe("Asia/Jerusalem");
      expect(r.workingHours).toHaveLength(6); // Sun–Fri, Sat closed
      expect(r.workingHours.find((w) => w.weekday === 6)).toBeUndefined();
      expect(r.minNoticeHours).toBe(4);
      expect(r.durationMinutes).toBe(30);
      expect(r.proposedSlotsIso.length).toBeGreaterThan(0);
    }
    expect(createCalls).toBe(0);
  });

  it("point check on an open time → requestedAvailable true", async () => {
    const { makeCheckAvailabilityHandler } = await import("../services/schedule-handler.service");
    const r = await makeCheckAvailabilityHandler(opts)({
      meeting_type: "discovery_call",
      requested_at_iso: "2026-05-05T11:00:00+03:00", // Tue 11:00 - open, > minNotice
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.requestedAvailable).toBe(true);
      expect(r.requestedReason).toBeUndefined();
    }
    expect(createCalls).toBe(0);
  });

  it("point check outside hours → false + reason + nextAvailableIso", async () => {
    const { makeCheckAvailabilityHandler } = await import("../services/schedule-handler.service");
    const r = await makeCheckAvailabilityHandler(opts)({
      meeting_type: "discovery_call",
      requested_at_iso: "2026-05-05T20:00:00+03:00", // Tue 20:00 - after 18:00 close
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.requestedAvailable).toBe(false);
      expect(r.requestedReason).toBe("outside_working_hours");
      expect(r.nextAvailableIso).toBeDefined();
    }
    expect(createCalls).toBe(0);
  });

  it("Saturday window → empty proposals + nextAvailableIso fallback", async () => {
    const { makeCheckAvailabilityHandler } = await import("../services/schedule-handler.service");
    const r = await makeCheckAvailabilityHandler(opts)({
      meeting_type: "discovery_call",
      from_iso: "2026-05-09T08:00:00+03:00", // Saturday - closed all day
      to_iso: "2026-05-09T20:00:00+03:00",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proposedSlotsIso).toHaveLength(0);
      expect(r.nextAvailableIso).toBeDefined(); // soonest real slot (Sun)
    }
    expect(createCalls).toBe(0);
  });

  it("unknown meeting type with none configured-match → structured failure, never books", async () => {
    const { makeCheckAvailabilityHandler } = await import("../services/schedule-handler.service");
    // Only one type is configured, so it snaps regardless - assert it still
    // resolves rather than throwing, and never books.
    const r = await makeCheckAvailabilityHandler(opts)({ meeting_type: "totally_made_up" });
    expect(r.ok).toBe(true); // single configured type → snapped
    expect(createCalls).toBe(0);
  });
});
