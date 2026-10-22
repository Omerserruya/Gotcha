/**
 * The one producer of "Call missed" / "Call answered" automation events: the
 * call-state transition. DB-free (prisma, queue and bus are doubles).
 *
 *   - ★ an inbound call that is MISSED → call_missed; answered and ENDED →
 *     call_answered; keyed on the session (one job per call per type)
 *   - an outbound call, a call that ended unanswered, a non-terminal state →
 *     nothing
 *   - ★ a queue failure never fails the call's own transition
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  row: null as any,
  added: [] as any[],
  queueFails: false,
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    voiceCallSession: {
      findUnique: async () => (H.row ? { ...H.row } : null),
      findUniqueOrThrow: async () => ({ ...H.row }),
      updateMany: async (a: any) => { if (a.where?.id === H.row.id) Object.assign(H.row, a.data); return { count: 1 }; },
    },
  },
}));
vi.mock("../lib/queue", () => ({
  incomingMessageQueue: {
    add: async (name: string, data: any, opts: any) => {
      if (H.queueFails) throw new Error("redis down");
      H.added.push({ name, data, opts });
    },
  },
}));
vi.mock("../lib/event-bus", () => ({ publishEvent: async () => undefined }));
vi.mock("../lib/agent-presence", () => ({ markBusy: async () => undefined }));

import { transitionVoiceCallSessionState, callAutomationType } from "../lib/voice-session-store";

const session = (o: any = {}) => ({
  id: "vs1", tenantId: "T", direction: "inbound", state: "RINGING", status: "ringing", stateHistory: [],
  answeredAt: null, customerNumber: "+972501234567", conversationId: "c1", callSid: "CA1", ...o,
});

beforeEach(() => { H.added = []; H.queueFails = false; });

describe("★ call automation events", () => {
  it("an inbound missed call → one call_missed job, keyed on the call", async () => {
    H.row = session();
    const r = await transitionVoiceCallSessionState("vs1", "MISSED", { reason: "no_answer" });
    expect(r.ok).toBe(true);
    expect(H.added).toEqual([{
      name: "automation-event",
      data: { tenantId: "T", type: "call_missed", eventKey: "call:vs1", payload: { sessionId: "vs1" } },
      opts: expect.objectContaining({ jobId: "callev_call_missed_vs1" }),
    }]);
    // BullMQ refuses a custom id with ":".
    expect(H.added[0].opts.jobId).not.toContain(":");
  });

  it("an inbound call that was answered → call_answered when it ENDS (not when answered)", async () => {
    H.row = session({ state: "CONNECTING" });
    await transitionVoiceCallSessionState("vs1", "ACTIVE");
    expect(H.added).toEqual([]);
    await transitionVoiceCallSessionState("vs1", "ENDED", { reason: "hangup_by_customer" });
    expect(H.added.map((a) => a.data.type)).toEqual(["call_answered"]);
  });

  it("outbound calls, an unanswered end, FAILED: nothing", () => {
    expect(callAutomationType({ direction: "outbound", answeredAt: null } as any, "MISSED")).toBeNull();
    expect(callAutomationType({ direction: "outbound", answeredAt: new Date() } as any, "ENDED")).toBeNull();
    expect(callAutomationType({ direction: "inbound", answeredAt: null } as any, "ENDED")).toBeNull();
    expect(callAutomationType({ direction: "inbound", answeredAt: new Date() } as any, "FAILED")).toBeNull();
  });

  it("★ a queue failure does not fail the call's transition", async () => {
    H.row = session();
    H.queueFails = true;
    const r = await transitionVoiceCallSessionState("vs1", "MISSED");
    expect(r.ok).toBe(true);
    expect(H.row.state).toBe("MISSED");
  });
});
