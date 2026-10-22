/**
 * The agent loop answers in the customer's language (Omer, 2026-10-12: the
 * reply language follows the customer and is not a setting).
 *
 * The adapter used to map AIAgent.languages to a fixed Writer language, and
 * that field defaults to {english:true} - so an agent left at its default
 * would have answered a Hebrew customer in English once the loop went live.
 * With no language pinned, the Writer's prompt says "the customer's language".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ agent: null as any, loopInput: null as any }));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    aIAgent: { findUnique: async () => H.agent },
    conversation: { findFirst: async () => ({ customerExternalId: "972541113421", customerName: "דנה", channel: "WHATSAPP" }) },
    message: { findMany: async () => [{ direction: "INBOUND", body: "שלום, מתי אתם פתוחים?", messageType: "text" }] },
  },
}));
vi.mock("../services/ai.service", () => ({ getDefaultModel: () => "test-model" }));
vi.mock("../services/plan-context.service", () => ({ loadCommittedGoal: async () => null }));
vi.mock("../services/agent-loop/memory-store", () => ({ loadAgentMemory: async () => ({}), saveAgentMemory: async () => undefined }));
vi.mock("../services/agent-loop/permissions-bridge", () => ({ loadToolGrants: async () => null }));
vi.mock("../services/agent-loop/operation-status", () => ({ isOperationAutonomous: () => false }));
vi.mock("../services/agent-loop/agent-loop", () => ({
  runAgentLoop: async (inp: any) => { H.loopInput = inp; throw new Error("captured"); },
}));

import { runAgentLoopForBotTurn } from "../services/agent-loop/bot-loop-adapter";

const run = () =>
  runAgentLoopForBotTurn({ tenantId: "t1", conversationId: "c1", aiAgentId: "a1", incomingMessage: "שלום, מתי אתם פתוחים?" }, "shadow")
    .catch(() => undefined);

beforeEach(() => { H.loopInput = null; });

describe("the loop's reply language is the customer's", () => {
  it("an agent at its default {english:true} pins no language", async () => {
    H.agent = { id: "a1", languages: { english: true } };
    await run();
    expect(H.loopInput).not.toBeNull();
    expect(H.loopInput.language).toBeUndefined();
  });

  it("nor does an agent set to Hebrew or Arabic: the customer decides", async () => {
    for (const languages of [{ hebrew: true }, { arabic: true }]) {
      H.agent = { id: "a1", languages };
      await run();
      expect(H.loopInput.language, JSON.stringify(languages)).toBeUndefined();
    }
  });
});
