/**
 * ★ The real runAgent passes its user's visibility to the tools: when the
 * (scripted) model asks for a conversation count, the query that reaches the
 * DB carries the inbox's visibility clause for a department-restricted user.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ counts: [] as any[], round: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const t = {
    findFirst: async () => null, findMany: async () => [], findUnique: async () => null,
    count: async (a: any) => { H.counts.push(a.where); return 3; },
  };
  return { ...actual, prisma: { conversation: t, message: { ...t, count: async () => 0 }, contact: t, tenantTool: t, approvalRequest: t } };
});
vi.mock("../services/agent-memory.service", () => ({
  appendToMemory: async () => undefined,
  getAgentMemory: async () => [],
  memoryToChatMessages: () => [],
  sanitizeHistoryForLLM: (x: any) => x,
}));
vi.mock("../services/ai.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    // Round 1: ask for a count. Round 2: answer.
    streamResponse: async function* () {
      H.round++;
      if (H.round === 1) {
        yield { done: true, content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "system_count_conversations", arguments: "{}" } }], usage: {} };
      } else {
        yield { contentDelta: "3 open." };
        yield { done: true, content: "3 open.", toolCalls: [], usage: {} };
      }
    },
  };
});

import { runAgent } from "../services/agent-runtime.service";

beforeEach(() => { H.counts = []; H.round = 0; });

describe("★ runAgent → tools carry the user's visibility", () => {
  it("a restricted user's count query has the clause; an ADMIN's does not", async () => {
    const run = (viewer: any) => runAgent({
      operator: { tenantId: "T", userId: viewer.userId, viewer },
      client: null, message: "how many open?", sessionId: "s", ephemeral: true, aiAgentId: null,
    } as any, () => {});
    await run({ userId: "u1", role: "AGENT", departmentId: "sales" });
    expect(H.counts[0].OR).toEqual(expect.arrayContaining([{ assignedAgentId: "u1" }]));
    H.counts = []; H.round = 0;
    await run({ userId: "a1", role: "ADMIN" });
    expect(H.counts[0].OR).toBeUndefined();
  });
});
