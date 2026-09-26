import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What the inbox row says the last message was.
 *
 * ★ A FAILED outbound is a message the customer never received, and it was
 * being taken as the conversation's last message. That broke the row in two
 * ways at once:
 *
 *  - the list's `isUnread` returns false for anything whose
 *    `lastMessageDirection` is not INBOUND, so a customer whose question the
 *    bot failed to answer STOPPED SHOWING AS UNREAD;
 *  - `lastMessageBody` previewed text that was never delivered.
 *
 * ★★ And it disagreed with `lastMessageAt`, which already skips failed sends.
 * One rule, two derivations, opposite answers - so the sort key said "nothing
 * happened here" while the preview said "answered".
 *
 * ── On coverage ──
 * Dev holds ZERO messages with status FAILED (363 rows: DELIVERED, READ, SENT,
 * PENDING). So this cannot be demonstrated against real data here and these
 * assertions are the verification, not a green dev query.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    conversation: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("@chatcenter/shared", () => ({
  prisma,
  publishEvent: vi.fn(),
  outgoingMessageQueue: { add: vi.fn() },
  getInternalServiceKey: () => "test-internal-key",
  readDurableSetting: async () => null,
}));
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({ create: vi.fn() }));

import { list } from "../services/conversation.service";

/** The `messages` include the query actually asked for. */
function messagesInclude() {
  return prisma.conversation.findMany.mock.calls[0][0].include.messages;
}

describe("inbox row - the last message the customer actually received", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversation.findMany.mockResolvedValue([]);
    prisma.conversation.count.mockResolvedValue(0);
  });

  it("excludes FAILED sends from the last-message lookup", async () => {
    await list("t1", {});
    expect(messagesInclude().where).toEqual({ status: { not: "FAILED" } });
  });

  it("still asks for the NEWEST one, and only one", async () => {
    // The predicate must narrow the candidates, not change which end is taken:
    // a filter that accidentally dropped the ordering would surface the oldest
    // message as the preview, which looks like the inbox going stale.
    await list("t1", {});
    const inc = messagesInclude();
    expect(inc.orderBy).toEqual({ createdAt: "desc" });
    expect(inc.take).toBe(1);
  });

  it("projects direction and body from that row", async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: "c1",
        lastMessageAt: new Date("2026-03-04T05:06:07.000Z"),
        messages: [{ direction: "INBOUND", body: "are you open today?", createdAt: new Date() }],
      },
    ]);
    const res = await list("t1", {});
    expect(res.data[0].lastMessageDirection).toBe("INBOUND");
    expect(res.data[0].lastMessageBody).toBe("are you open today?");
    // The raw relation does not travel to the client.
    expect(res.data[0]).not.toHaveProperty("messages");
  });

  it("reports no last message rather than inventing one when every row was FAILED", async () => {
    // The include filtered them all out, so the relation comes back empty.
    // Null is the honest answer and `isUnread` treats it as not-unread only
    // because there is nothing the customer has sent since.
    prisma.conversation.findMany.mockResolvedValue([
      { id: "c1", lastMessageAt: null, messages: [] },
    ]);
    const res = await list("t1", {});
    expect(res.data[0].lastMessageDirection).toBeNull();
    expect(res.data[0].lastMessageBody).toBeNull();
  });
});
