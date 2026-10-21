/**
 * The canonical message writer, and why it could not be used.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 18 files create messages directly and only this one updates `lastMessageAt`
 * inside the transaction. The refactor to one writer is blocked on shape, not on
 * will: ★ `create` DECIDED `status` for its callers - PENDING for outbound,
 * DELIVERED for inbound - and 17 of the 18 writers already know the send
 * outcome. The flow executor writes SENT or FAILED depending on whether an
 * external id came back; the sandbox writes SENT for a message no provider saw.
 *
 * ★ And the FAILED rule lives here rather than at each call site. It was found
 * while fixing the flow executor, and had it stayed there, every writer moved
 * into this function afterwards would have reintroduced the bug - the opposite
 * of what consolidating the writers is for.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  created: null as any,
  convUpdates: [] as any[],
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    $transaction: async (fn: any) => fn({
      message: {
        create: async (a: any) => {
          state.created = a.data;
          return { id: "m1", createdAt: new Date("2026-09-26T10:00:00Z"), ...a.data };
        },
      },
      conversation: {
        update: async (a: any) => { state.convUpdates.push(a); return {}; },
      },
    }),
  },
  publishEvent: async () => undefined,
  withHistoricalRecords: (fn: any) => fn(),
}));
vi.mock("../lib/socket", () => ({ getIO: () => { throw new Error("no io in tests"); } }));

import { create } from "../services/message.service";

const base = { tenantId: "t1", conversationId: "cv1", direction: "OUTBOUND" as const, body: "hi" };

beforeEach(() => { state.created = null; state.convUpdates = []; });

describe("★ the caller's send outcome is respected", () => {
  it("★ accepts an explicit status", async () => {
    await create({ ...base, status: "SENT" });

    // The reason 17 writers could not use this function.
    expect(state.created.status).toBe("SENT");
  });

  it("keeps the old default when status is omitted", async () => {
    await create({ ...base });
    expect(state.created.status).toBe("PENDING");

    state.created = null;
    await create({ ...base, direction: "INBOUND" });
    expect(state.created.status).toBe("DELIVERED");
  });

  it("carries errorMessage and replyToExternalId", async () => {
    await create({ ...base, status: "FAILED", errorMessage: "recipient blocked", replyToExternalId: "wamid.X" });

    expect(state.created.errorMessage).toBe("recipient blocked");
    expect(state.created.replyToExternalId).toBe("wamid.X");
  });
});

describe("★ a FAILED send does not move the conversation's sort key", () => {
  it("★ skips the lastMessageAt update on FAILED", async () => {
    await create({ ...base, status: "FAILED", errorMessage: "send failed" });

    // A message the customer never received must not make the conversation look
    // answered: the last real thing that happened is still their inbound, and
    // moving the column would demote somebody still waiting.
    expect(state.convUpdates).toHaveLength(0);
  });

  it("updates it on every other status", async () => {
    for (const status of ["PENDING", "SENT", "DELIVERED", "READ"] as const) {
      state.convUpdates = [];
      await create({ ...base, status });
      expect(state.convUpdates, status).toHaveLength(1);
      expect(state.convUpdates[0].data.lastMessageAt).toBeTruthy();
    }
  });

  it("★ sets it from the MESSAGE's createdAt, not from now", async () => {
    await create({ ...base, status: "SENT" });

    // Matching the message rather than the clock keeps the column and the thread
    // in agreement, which is what a keyset cursor over both depends on.
    expect(state.convUpdates[0].data.lastMessageAt).toEqual(new Date("2026-09-26T10:00:00Z"));
  });

  it("still writes the message itself when the send failed", async () => {
    await create({ ...base, status: "FAILED" });

    // The failure is a record, not a reason to lose the row - the diagnosable
    // FAILED row is the point.
    expect(state.created.body).toBe("hi");
    expect(state.created.status).toBe("FAILED");
  });
});
