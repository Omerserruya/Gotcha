import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Freeze time so REQUESTED times stay inside min_notice (4h) + max_horizon (30d).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-05-04T06:00:00Z")); // Monday 09:00 IDT
});
afterAll(() => {
  vi.useRealTimers();
});

// This suite proves the booking-store behavior that replaced the audit/email
// scan: (1) schedule_meeting reschedules an existing booking instead of creating
// a duplicate, (2) reschedule/cancel resolve the EXACT eventId from the store,
// (3) cancel flips the stored status, (4) >1 active meeting → ask which.

const TENANT = "tnt_1";
const AGENT = "agent_1";
const CONV = "conv_1";
const CUST = "972500000000";

const MEETING_TYPE = {
  id: "mt_1",
  tenantId: TENANT,
  slug: "discovery_call",
  name: "Discovery Call",
  durationMinutes: 30,
  agentTimezone: "Asia/Jerusalem",
  workingHours: [
    { weekday: 0, start: "09:00", end: "18:00" },
    { weekday: 1, start: "09:00", end: "18:00" },
    { weekday: 2, start: "09:00", end: "18:00" },
    { weekday: 3, start: "09:00", end: "18:00" },
    { weekday: 4, start: "09:00", end: "18:00" },
    { weekday: 5, start: "09:00", end: "13:00" },
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

// In-memory booking store the prisma mock reads/writes.
let store: any[] = [];
// Controllable audit trail for the legacy-fallback resurrection test.
let auditRows: any[] = [];

function matches(row: any, where: any): boolean {
  for (const k of Object.keys(where)) {
    if (where[k] === undefined) continue;
    if (row[k] !== where[k]) return false;
  }
  return true;
}

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
    auditLog: {
      findMany: async () => auditRows,
    },
    meetingBooking: {
      findUnique: async ({ where }: any) => {
        const { provider, eventId } = where.provider_eventId;
        return store.find((r) => r.provider === provider && r.eventId === eventId) ?? null;
      },
      findMany: async ({ where, orderBy }: any) => {
        let rows = store.filter((r) => matches(r, where));
        if (orderBy?.startAt === "asc") {
          rows = [...rows].sort(
            (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
          );
        }
        return rows;
      },
      upsert: async ({ where, create, update }: any) => {
        const { provider, eventId } = where.provider_eventId;
        const existing = store.find((r) => r.provider === provider && r.eventId === eventId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `bk_${store.length + 1}`, ...create };
        store.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let n = 0;
        for (const r of store) {
          if (r.provider === where.provider && r.eventId === where.eventId) {
            Object.assign(r, data);
            n++;
          }
        }
        return { count: n };
      },
    },
  },
  encryptCredentials: (x: any) => JSON.stringify(x),
  decryptCredentials: () => ({ accessToken: "x", refreshToken: "y" }),
}));

// Adapter spies.
let createCalls = 0;
let updateCalls = 0;
let cancelCalls = 0;
let lastUpdateEventId: string | null = null;
let lastCancelEventId: string | null = null;

vi.mock("../services/connectors/google-calendar.adapter", () => ({
  GoogleCalendarAdapter: class {
    readonly provider = "google";
    async findBusy() {
      return [];
    }
    async createEvent() {
      createCalls++;
      return { eventId: `evt_new_${createCalls}`, joinUrl: "https://meet.example/new" };
    }
    async updateEvent(opts: any) {
      updateCalls++;
      lastUpdateEventId = opts.eventId;
      return { eventId: opts.eventId, joinUrl: "https://meet.example/moved" };
    }
    async cancelEvent(opts: any) {
      cancelCalls++;
      lastCancelEventId = opts.eventId;
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
  store = [];
  auditRows = [];
  createCalls = 0;
  updateCalls = 0;
  cancelCalls = 0;
  lastUpdateEventId = null;
  lastCancelEventId = null;
});

// Monday & Tuesday 11:00 IDT - inside working hours, inside notice/horizon.
const SLOT_A = "2026-05-05T11:00:00+03:00"; // Tue
const SLOT_B = "2026-05-06T14:00:00+03:00"; // Wed

function seedBooking(eventId: string, startIso: string, extra: any = {}) {
  const startMs = Date.parse(startIso);
  store.push({
    id: `bk_seed_${store.length + 1}`,
    tenantId: TENANT,
    aiAgentId: AGENT,
    conversationId: CONV,
    customerExternalId: CUST,
    customerEmail: "u@x.com",
    provider: "GOOGLE_CALENDAR",
    calendarAccountId: ACCOUNT.id,
    eventId,
    meetingTypeSlug: "discovery_call",
    startAt: new Date(startMs),
    endAt: new Date(startMs + 30 * 60_000),
    customerTimezone: "Asia/Jerusalem",
    status: "ACTIVE",
    ...extra,
  });
}

const handlerOpts = {
  tenantId: TENANT,
  aiAgentId: AGENT,
  conversationId: CONV,
  customerExternalId: CUST,
  customerEmail: "u@x.com",
};

describe("booking store - schedule_meeting dedupe", () => {
  it("no existing booking → CREATES and records ACTIVE", async () => {
    const { makeScheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeScheduleMeetingHandler(handlerOpts);
    const r = await handler({
      duration_minutes: 30,
      meeting_type: "discovery_call",
      requested_at_iso: SLOT_A,
      customer_email: "u@x.com",
      customer_timezone: "Asia/Jerusalem",
    });
    expect(r.ok).toBe(true);
    expect(createCalls).toBe(1);
    expect(updateCalls).toBe(0);
    expect(store.filter((b) => b.status === "ACTIVE")).toHaveLength(1);
  });

  it("existing booking → RESCHEDULES (no duplicate create)", async () => {
    seedBooking("evt_existing", SLOT_A);
    const { makeScheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeScheduleMeetingHandler(handlerOpts);
    const r = await handler({
      duration_minutes: 30,
      meeting_type: "discovery_call",
      requested_at_iso: SLOT_B, // "move it"
      customer_email: "u@x.com",
      customer_timezone: "Asia/Jerusalem",
    });
    expect(r.ok).toBe(true);
    expect(createCalls).toBe(0); // crucial: no duplicate event
    expect(updateCalls).toBe(1);
    expect(lastUpdateEventId).toBe("evt_existing");
    // Still exactly one active row, now at SLOT_B.
    const active = store.filter((b) => b.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(new Date(active[0].startAt).getTime()).toBe(Date.parse(SLOT_B));
  });

  it("no new time → defers to check_availability (no create/update)", async () => {
    // schedule_meeting is now write-only: with no chosen time there's nothing to
    // book, so it returns needsAvailabilityCheck and touches no calendar - even
    // when a booking already exists (the model uses reschedule/cancel for that).
    seedBooking("evt_existing", SLOT_A);
    const { makeScheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeScheduleMeetingHandler(handlerOpts);
    const r = await handler({
      duration_minutes: 30,
      meeting_type: "discovery_call",
      customer_email: "u@x.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_time_selected");
      expect((r as any).needsAvailabilityCheck).toBe(true);
    }
    expect(createCalls).toBe(0);
    expect(updateCalls).toBe(0);
  });
});

describe("booking store - reschedule_meeting", () => {
  it("resolves exact eventId from store and PATCHes it", async () => {
    seedBooking("evt_target", SLOT_A);
    const { makeRescheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeRescheduleMeetingHandler(handlerOpts);
    const r = await handler({ requested_at_iso: SLOT_B, customer_timezone: "Asia/Jerusalem" });
    expect(r.ok).toBe(true);
    expect(updateCalls).toBe(1);
    expect(createCalls).toBe(0);
    expect(lastUpdateEventId).toBe("evt_target");
  });

  it("no booking → no_existing_meeting", async () => {
    const { makeRescheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeRescheduleMeetingHandler(handlerOpts);
    const r = await handler({ requested_at_iso: SLOT_B });
    expect(r.ok).toBe(false);
    if (!r.ok && "reason" in r) expect(r.reason).toBe("no_existing_meeting");
  });

  it("two active bookings → asks which (multiple_active_meetings), no PATCH", async () => {
    seedBooking("evt_a", SLOT_A);
    seedBooking("evt_b", SLOT_B);
    const { makeRescheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeRescheduleMeetingHandler(handlerOpts);
    const r = await handler({ requested_at_iso: SLOT_B });
    expect(r.ok).toBe(false);
    if (!r.ok && "reason" in r) expect(r.reason).toContain("multiple_active_meetings");
    expect(updateCalls).toBe(0);
  });
});

describe("booking store - cancel_meeting", () => {
  it("cancels exact event and flips stored status to CANCELLED", async () => {
    seedBooking("evt_target", SLOT_A);
    const { makeCancelMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeCancelMeetingHandler(handlerOpts);
    const r = await handler();
    expect(r.ok).toBe(true);
    expect(cancelCalls).toBe(1);
    expect(lastCancelEventId).toBe("evt_target");
    expect(store.find((b) => b.eventId === "evt_target")?.status).toBe("CANCELLED");
    // A subsequent resolve must find nothing active.
    expect(store.filter((b) => b.status === "ACTIVE")).toHaveLength(0);
  });

  it("two active bookings → asks which, no cancel", async () => {
    seedBooking("evt_a", SLOT_A);
    seedBooking("evt_b", SLOT_B);
    const { makeCancelMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeCancelMeetingHandler(handlerOpts);
    const r = await handler();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("multiple_active_meetings");
    expect(cancelCalls).toBe(0);
  });
});

describe("booking store - legacy fallback must not resurrect a cancelled event", () => {
  it("CANCELLED store row + stale audit for same event → stays empty (no resurrection)", async () => {
    // Store knows this event as CANCELLED.
    seedBooking("evt_cancelled", SLOT_A, { status: "CANCELLED" });
    // But the audit trail still shows it as a successful past booking.
    const startMs = Date.parse(SLOT_A);
    auditRows = [
      {
        metadata: {
          toolCalls: [
            {
              tool: "schedule_meeting",
              decision: "executed",
              args: { meeting_type: "discovery_call", customer_email: "u@x.com" },
              result: JSON.stringify({
                ok: true,
                verdict: "VALID",
                eventId: "evt_cancelled",
                startMs,
                endMs: startMs + 30 * 60_000,
              }),
            },
          ],
        },
      },
    ];
    const { resolveActiveBookings } = await import("../services/schedule-handler.service");
    const active = await resolveActiveBookings(handlerOpts);
    expect(active).toHaveLength(0); // must NOT come back from the dead
    // And the store row is still CANCELLED (not flipped back to ACTIVE).
    expect(store.find((b) => b.eventId === "evt_cancelled")?.status).toBe("CANCELLED");
  });

  it("genuinely new legacy event (not in store) → backfilled + returned", async () => {
    const startMs = Date.parse(SLOT_A);
    auditRows = [
      {
        metadata: {
          toolCalls: [
            {
              tool: "schedule_meeting",
              decision: "executed",
              args: { meeting_type: "discovery_call", customer_email: "u@x.com" },
              result: JSON.stringify({
                ok: true,
                verdict: "VALID",
                eventId: "evt_legacy_new",
                startMs,
                endMs: startMs + 30 * 60_000,
              }),
            },
          ],
        },
      },
    ];
    const { resolveActiveBookings } = await import("../services/schedule-handler.service");
    const active = await resolveActiveBookings(handlerOpts);
    expect(active).toHaveLength(1);
    expect(active[0].eventId).toBe("evt_legacy_new");
    // Backfilled into the store as ACTIVE for next turn.
    expect(store.find((b) => b.eventId === "evt_legacy_new")?.status).toBe("ACTIVE");
  });
});
