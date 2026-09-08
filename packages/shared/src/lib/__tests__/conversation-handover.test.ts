import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The value of a handover history is that its count means something. What
 * these defend, in order:
 *
 *   1. A handover is a CHANGE of handler. A flow executor setting
 *      handledBy: "flow" on every node it walks would otherwise report one
 *      handover as eleven, and "last handover 3 hours ago" would mean "the bot
 *      advanced a step".
 *   2. The column and the history are written together or not at all. A history
 *      that is sometimes missing a row is a rumour.
 *   3. A no-op handover still applies the caller's other columns - a takeover
 *      that also sets `status` must not be dropped because the handler matched.
 */
const { prismaMock, txMock } = vi.hoisted(() => {
  const txMock = {
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    conversationHandover: { create: vi.fn() },
  };
  return {
    txMock,
    prismaMock: {
      $transaction: vi.fn(async (fn: any) => fn(txMock)),
      conversationHandover: { findFirst: vi.fn() },
    },
  };
});
vi.mock("../prisma", () => ({ prisma: prismaMock }));

import { recordHandover, latestHandover } from "../conversation-handover";

const AT = new Date("2026-09-08T07:40:00.000Z");

describe("recordHandover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txMock.conversation.update.mockResolvedValue({});
    txMock.conversationHandover.create.mockResolvedValue({
      id: "hv_1", fromHandler: "ai_agent", toHandler: "human", at: AT,
    });
  });

  it("records a real change and moves the column with it", async () => {
    txMock.conversation.findFirst.mockResolvedValue({ handledBy: "ai_agent" });

    const out = await recordHandover({
      tenantId: "t1", conversationId: "c1", to: "human", reason: "escalation",
      data: { isHandedOver: true, status: "WAITING" },
    });

    expect(out).toEqual({ id: "hv_1", from: "ai_agent", to: "human", at: AT });
    expect(txMock.conversation.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { isHandedOver: true, status: "WAITING", handledBy: "human" },
    });
    expect(txMock.conversationHandover.create).toHaveBeenCalledTimes(1);
  });

  it("writes the column and the row in ONE transaction", async () => {
    txMock.conversation.findFirst.mockResolvedValue({ handledBy: "ai_agent" });
    await recordHandover({ tenantId: "t1", conversationId: "c1", to: "human" });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  // The one that stops the count from being nonsense.
  it("writes NO history row when the handler has not changed", async () => {
    txMock.conversation.findFirst.mockResolvedValue({ handledBy: "flow" });
    const out = await recordHandover({ tenantId: "t1", conversationId: "c1", to: "flow" });
    expect(out).toBeNull();
    expect(txMock.conversationHandover.create).not.toHaveBeenCalled();
  });

  it("still applies the caller's other columns on a no-op handover", async () => {
    txMock.conversation.findFirst.mockResolvedValue({ handledBy: "human" });
    await recordHandover({
      tenantId: "t1", conversationId: "c1", to: "human", data: { status: "WAITING" },
    });
    expect(txMock.conversation.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "WAITING" },
    });
    expect(txMock.conversationHandover.create).not.toHaveBeenCalled();
  });

  it("does not touch the row at all when nothing changes and nothing else was asked", async () => {
    txMock.conversation.findFirst.mockResolvedValue({ handledBy: "human" });
    await recordHandover({ tenantId: "t1", conversationId: "c1", to: "human" });
    expect(txMock.conversation.update).not.toHaveBeenCalled();
  });

  it("treats a first assignment as a handover FROM null", async () => {
    // An unrouted conversation is a real state, not a missing value, and the
    // first time anything picks it up is genuinely a change of handler.
    txMock.conversation.findFirst.mockResolvedValue({ handledBy: null });
    txMock.conversationHandover.create.mockResolvedValue({
      id: "hv_2", fromHandler: null, toHandler: "ai_agent", at: AT,
    });
    const out = await recordHandover({ tenantId: "t1", conversationId: "c1", to: "ai_agent" });
    expect(out?.from).toBeNull();
    expect(out?.to).toBe("ai_agent");
  });

  it("is scoped by tenant, so one tenant cannot move another's conversation", async () => {
    txMock.conversation.findFirst.mockResolvedValue(null);
    const out = await recordHandover({ tenantId: "t-other", conversationId: "c1", to: "human" });
    expect(out).toBeNull();
    expect(txMock.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1", tenantId: "t-other" } }),
    );
    expect(txMock.conversation.update).not.toHaveBeenCalled();
  });
});

describe("latestHandover", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the most recent transition as ISO-8601", async () => {
    prismaMock.conversationHandover.findFirst.mockResolvedValue({
      at: AT, fromHandler: "ai_agent", toHandler: "human",
    });
    await expect(latestHandover("t1")).resolves.toEqual({
      at: "2026-09-08T07:40:00.000Z", from: "ai_agent", to: "human",
    });
  });

  it("returns null rather than a zero when nothing has been recorded", async () => {
    // A tenant deployed this morning and a tenant whose AI has never needed
    // help both have no handovers, and they must not render the same.
    prismaMock.conversationHandover.findFirst.mockResolvedValue(null);
    await expect(latestHandover("t1")).resolves.toBeNull();
  });

  it("asks for the newest, not the first", async () => {
    prismaMock.conversationHandover.findFirst.mockResolvedValue(null);
    await latestHandover("t1");
    expect(prismaMock.conversationHandover.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" }, orderBy: { at: "desc" } }),
    );
  });
});
