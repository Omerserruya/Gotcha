/**
 * Department transfer assignment ("How conversations are assigned on
 * transfer" - the renamed Queue Mode). The ONLY behavioral difference between
 * the two modes lives in transferToDepartment:
 *   ROUND_ROBIN → auto-assign to the least-busy ACTIVE member (status OPEN)
 *   CLAIM       → leave unassigned (status WAITING) for an agent to claim
 * Inbound routing never reads this field - it is transfer-time behavior only,
 * which is exactly what the UI copy now says.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    department: { findFirst: vi.fn() },
    message: { create: vi.fn() },
  } as any,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prisma: mocks.prismaMock,
    outgoingMessageQueue: { add: vi.fn() },
    getRedis: () => null,
  };
});

import { transferToDepartment } from "../services/conversation.service";

const { prismaMock } = mocks;

function member(userId: string, active: boolean, openConvs: number) {
  return { userId, user: { id: userId, name: userId, isActive: active, _count: { conversations: openConvs } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1" });
  prismaMock.conversation.update.mockImplementation(async (args: any) => ({
    ...args.data,
    id: "c1",
    assignedAgent: args.data.assignedAgentId ? { id: args.data.assignedAgentId, name: args.data.assignedAgentId } : null,
    department: { id: "d1", name: "Support" },
  }));
  prismaMock.message.create.mockResolvedValue({});
});

describe("transferToDepartment", () => {
  it("ROUND_ROBIN assigns the least-busy ACTIVE member and opens the conversation", async () => {
    prismaMock.department.findFirst.mockResolvedValue({
      id: "d1", name: "Support", queueMode: "ROUND_ROBIN",
      members: [member("busy", true, 7), member("idle", true, 1), member("inactive", false, 0)],
    });
    await transferToDepartment("t1", "c1", "d1");
    const write = prismaMock.conversation.update.mock.calls[0][0].data;
    expect(write.assignedAgentId).toBe("idle"); // least busy, never the inactive one
    expect(write.status).toBe("OPEN");
  });

  it("CLAIM leaves the conversation unassigned and WAITING", async () => {
    prismaMock.department.findFirst.mockResolvedValue({
      id: "d1", name: "Support", queueMode: "CLAIM",
      members: [member("a", true, 0)],
    });
    await transferToDepartment("t1", "c1", "d1");
    const write = prismaMock.conversation.update.mock.calls[0][0].data;
    expect(write.assignedAgentId).toBeNull();
    expect(write.status).toBe("WAITING");
  });

  it("ROUND_ROBIN with no active members degrades to the shared queue", async () => {
    prismaMock.department.findFirst.mockResolvedValue({
      id: "d1", name: "Support", queueMode: "ROUND_ROBIN",
      members: [member("gone", false, 0)],
    });
    await transferToDepartment("t1", "c1", "d1");
    const write = prismaMock.conversation.update.mock.calls[0][0].data;
    expect(write.assignedAgentId).toBeNull();
    expect(write.status).toBe("WAITING");
  });
});
