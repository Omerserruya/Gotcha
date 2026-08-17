import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The query behind the inbox's "handled by AI employees" section.
 *
 * The section's entire promise is "nobody is waiting on you for these". A row
 * that leaks in with a human on it breaks that promise in the worst direction:
 * an agent skips a conversation that was actually theirs. So the filter is
 * pinned condition by condition, and against its own complement - the default
 * list must keep excluding exactly what this one includes.
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

/** The AND clause the query built, flattened for assertions. */
function andClauses() {
  const where = prisma.conversation.findMany.mock.calls[0][0].where;
  return { where, and: where.AND || [] };
}

describe("inbox list - automatedOnly (the AI-handled section)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversation.findMany.mockResolvedValue([]);
    prisma.conversation.count.mockResolvedValue(0);
  });

  it("requires all three ownership conditions together", async () => {
    await list("t1", { automatedOnly: true });

    const { and } = andClauses();
    expect(and).toContainEqual({
      handledBy: { in: ["ai_agent", "flow"] },
      isHandedOver: false,
      assignedAgentId: null,
    });
  });

  it("excludes closed conversations - the section is a live view, not an archive", async () => {
    await list("t1", { automatedOnly: true });

    expect(andClauses().where.status).toEqual({ not: "CLOSED" });
  });

  it("lets an explicit status win over that default", async () => {
    await list("t1", { automatedOnly: true, status: "CLOSED" });

    expect(andClauses().where.status).toBe("CLOSED");
  });

  it("does NOT apply the default human-only exclusion as well", async () => {
    // Both clauses at once is an empty result set: nothing is simultaneously
    // AI-handled and (human OR handed over). A section that silently renders
    // zero rows reads as "the AI is idle", which is the opposite of the truth.
    await list("t1", { automatedOnly: true });

    const { and } = andClauses();
    expect(and.some((c: any) => Array.isArray(c.OR) && c.OR.some((o: any) => o.handledBy === "human"))).toBe(false);
  });

  it("wins over includeAutomated when both are set", async () => {
    await list("t1", { automatedOnly: true, includeAutomated: true });

    expect(andClauses().and).toContainEqual({
      handledBy: { in: ["ai_agent", "flow"] },
      isHandedOver: false,
      assignedAgentId: null,
    });
  });

  it("still honours the channel, department and search filters", async () => {
    // The section shows counts next to the human queues. A filter that applied
    // to one and not the other makes the two disagree on screen.
    await list("t1", { automatedOnly: true, channel: "WHATSAPP", departmentId: "d1", search: "dana" });

    const { where, and } = andClauses();
    expect(where.channel).toBe("WHATSAPP");
    expect(where.departmentId).toBe("d1");
    expect(and.some((c: any) => Array.isArray(c.OR) && c.OR.some((o: any) => o.customerName))).toBe(true);
  });

  it("the default list still excludes what this section includes", async () => {
    await list("t1", {});

    const { where, and } = andClauses();
    expect(and).toContainEqual({
      OR: [{ handledBy: null }, { handledBy: "human" }, { isHandedOver: true }],
    });
    expect(where.status).toBeUndefined();
  });
});
