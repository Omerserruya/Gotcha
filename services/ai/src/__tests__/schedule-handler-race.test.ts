import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Freeze wall-clock time so the hardcoded REQUESTED date below stays inside
// min_notice (4h) and max_horizon (30d) every time the test runs. Without
// this, REQUESTED drifts into the past as real time advances. Using fake
// timers only for system time (setSystemTime) - actual setTimeout is left
// real so the handler's retry logic still works.
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date"],
  });
  vi.setSystemTime(new Date("2026-05-04T06:00:00Z")); // Monday 09:00 IDT
});
afterAll(() => {
  vi.useRealTimers();
});

// We test the slot_taken race path by stubbing the prisma + adapter modules
// so the handler runs end-to-end without a database or network. The whole
// point of this file is the retry-on-conflict logic - not the adapters.

const TENANT = "tnt_1";
const AGENT = "agent_1";

// In-memory state the mocks read from / write to.
const state: any = {
  meetingType: {
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
  },
  account: {
    id: "ca_1",
    tenantId: TENANT,
    aiAgentId: AGENT,
    provider: "GOOGLE_CALENDAR",
    status: "CONNECTED",
    defaultCalendarId: "primary",
    credentials: "encrypted",
  },
};

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    meetingType: {
      findUnique: async ({ where }: any) => {
        if (where?.tenantId_slug?.slug === state.meetingType.slug) return state.meetingType;
        return null;
      },
    },
    calendarAccount: {
      findMany: async () => [state.account],
    },
  },
  encryptCredentials: (x: any) => JSON.stringify(x),
  decryptCredentials: () => ({ accessToken: "x", refreshToken: "y" }),
}));

// Stub adapter - controlled per test.
let adapterCreateImpl: (s: { startMs: number; endMs: number }) => Promise<any> = async () => {
  throw new Error("not configured");
};
let adapterFindBusyImpl: () => Promise<any[]> = async () => [];
let createCallCount = 0;

vi.mock("../services/connectors/google-calendar.adapter", () => ({
  GoogleCalendarAdapter: class {
    readonly provider = "google";
    async findBusy() {
      return adapterFindBusyImpl();
    }
    async createEvent(opts: any) {
      createCallCount++;
      return adapterCreateImpl(opts);
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
  createCallCount = 0;
  adapterFindBusyImpl = async () => [];
  adapterCreateImpl = async () => ({ eventId: "evt_ok", joinUrl: "https://meet.example/abc" });
});

// Tuesday 11:00 IDT - well inside working hours, > minNotice from `nowMs`.
// Compute requested date dynamically so we land between min_notice (4h) and
// max_horizon (30 days). +7 days is safely inside the window at any test runtime.
// Monday 11:00 Asia/Jerusalem - inside fake-now's min_notice & max_horizon.
const REQUESTED = "2026-05-05T11:00:00+03:00";

describe("schedule_meeting - race-condition retry", () => {
  it("VALID on first try → returns success without retrying", async () => {
    const { makeScheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeScheduleMeetingHandler({ tenantId: TENANT, aiAgentId: AGENT, conversationId: "conv_test" });
    const r = await handler({
      duration_minutes: 30,
      meeting_type: "discovery_call",
      requested_at_iso: REQUESTED,
      customer_email: "u@x.com",
    });
    expect(r.ok).toBe(true);
    expect(createCallCount).toBe(1);
  });

  it("first create fails → re-validates → succeeds on retry", async () => {
    let calls = 0;
    adapterCreateImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("conflict");
      return { eventId: "evt_retry", joinUrl: "https://meet.example/retry" };
    };
    const { makeScheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeScheduleMeetingHandler({ tenantId: TENANT, aiAgentId: AGENT, conversationId: "conv_test" });
    const r = await handler({
      duration_minutes: 30,
      meeting_type: "discovery_call",
      requested_at_iso: REQUESTED,
      customer_email: "u@x.com",
    });
    expect(r.ok).toBe(true);
    expect(createCallCount).toBe(2);
    if (r.ok) expect(r.eventId).toBe("evt_retry");
  });

  it("first create fails AND fresh busy now overlaps → INVALID slot_taken with userMessage", async () => {
    // First findBusy: empty (validation passes). Create fails. Second
    // findBusy (recheck): returns a busy slot covering the requested time.
    // The recheck must see INVALID and the handler must NOT retry create.
    adapterCreateImpl = async () => {
      throw new Error("conflict_409");
    };
    const requestedMs = Date.parse(REQUESTED);
    let busyCalls = 0;
    adapterFindBusyImpl = async () => {
      busyCalls++;
      if (busyCalls === 1) return [];
      return [{ startMs: requestedMs, endMs: requestedMs + 30 * 60_000, source: "google" as const }];
    };
    const { makeScheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeScheduleMeetingHandler({ tenantId: TENANT, aiAgentId: AGENT, conversationId: "conv_test" });
    const r = await handler({
      duration_minutes: 30,
      meeting_type: "discovery_call",
      requested_at_iso: REQUESTED,
      customer_email: "u@x.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "verdict" in r && r.verdict === "INVALID") {
      expect(r.reason).toContain("slot_taken");
      expect(r.userMessage?.he).toContain("נתפס");
      expect(r.userMessage?.en).toContain("just booked");
      expect(r.requestedSlotIso).toBeDefined();
    }
    // First attempt: 1 create. Recheck failed → no second create.
    expect(createCallCount).toBe(1);
  });

  it("first create fails, recheck still VALID, but second create also fails → INVALID slot_taken", async () => {
    let calls = 0;
    adapterCreateImpl = async () => {
      calls++;
      throw new Error(`conflict_attempt_${calls}`);
    };
    adapterFindBusyImpl = async () => []; // recheck stays VALID
    const { makeScheduleMeetingHandler } = await import("../services/schedule-handler.service");
    const handler = makeScheduleMeetingHandler({ tenantId: TENANT, aiAgentId: AGENT, conversationId: "conv_test" });
    const r = await handler({
      duration_minutes: 30,
      meeting_type: "discovery_call",
      requested_at_iso: REQUESTED,
      customer_email: "u@x.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "verdict" in r && r.verdict === "INVALID") {
      expect(r.reason).toContain("slot_taken");
      expect(r.userMessage?.he).toBeDefined();
    }
    expect(createCallCount).toBe(2); // attempted twice, never confirmed
  });
});
