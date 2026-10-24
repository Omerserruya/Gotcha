/**
 * The Copilot side chat's round loop (OpenAIProvider.chatWithAgent with
 * `sidePanel`). The model is a script; the surface and dispatch are spies.
 * Pinned:
 *   - the surface offered is the READ tools plus propose_reply, never an action;
 *   - a read the model asks for really runs, an action it asks for anyway does not;
 *   - propose_reply ends the round with {text, draft}, even when the same
 *     round also asked for a lookup;
 *   - the last round is forced to answer;
 *   - without `sidePanel` (the old panel) nothing changes: the full surface, no
 *     propose_reply.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  script: [] as any[],
  calls: [] as any[],
  dispatched: [] as string[],
}));

vi.mock("@chatcenter/shared", async () => {
  // The real classification table, not a copy of it.
  const effect = await vi.importActual<any>("../../../../packages/shared/src/lib/tool-effect");
  return {
    classifyToolEffect: effect.classifyToolEffect,
    prisma: { contact: { findFirst: async () => null } },
    publishEvent: async () => undefined,
    dispatchToolCall: async (tc: any) => {
      H.dispatched.push(tc.function.name);
      return { toolCallId: tc.id, content: JSON.stringify({ ok: true, inStock: 3 }) };
    },
  };
});
vi.mock("../services/ai.service", () => ({
  getDefaultModel: () => "gpt-test",
  generateResponse: async (p: any) => {
    H.calls.push(p);
    return H.script.shift() ?? { content: "fallback" };
  },
}));
vi.mock("../services/knowledge.service", () => ({ retrieveRelevantChunks: async () => [], buildKnowledgeContext: () => "" }));
vi.mock("../services/crm-prefetch.service", () => ({ prefetchCrmContext: async () => null, renderCrmContextBlock: () => "" }));
vi.mock("../services/plan-context.service", () => ({ assemblePlanContext: async () => ({}) }));
vi.mock("../services/prompt-builder.service", () => ({
  buildAgentPrompt: () => "SYSTEM",
  computeCurrentPlanForOpts: () => null,
  renderOutputContractInstruction: () => "CONTRACT",
}));
vi.mock("../services/behavior-engine.service", () => ({
  computeBehaviorState: () => ({ outputContract: "x" }),
  shouldRetrieveKB: () => false,
}));
vi.mock("../services/copilot-diagnostics.service", () => ({
  logCopilotPlan: () => undefined, logCopilotTool: () => undefined, plannerReasonForTool: () => "",
  noToolDecision: () => ({}), summarizeToolResult: () => "",
}));
vi.mock("../services/capability-runtime/calendar.port.prod", () => ({ createProdCalendarPort: () => ({}) }));
vi.mock("../services/capability-runtime/calendar.execute", () => ({ isCalendarTool: () => false, executeCalendarToolAdvisory: vi.fn() }));
const fn = (name: string) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } });
vi.mock("../services/copilot-tool-surface.service", () => ({
  assembleCopilotToolSurface: async () => {
    const tools = [fn("woocommerce.search_products"), fn("get_contact"), fn("issue_refund"), fn("schedule_meeting")];
    return { tools, toolFunctionNames: tools.map((t) => t.function.name), calendarBookable: false, hasActiveBooking: false };
  },
}));

import { OpenAIProvider, parseProposeReply } from "../services/openai.provider";

const provider = new OpenAIProvider("k");
const call = (name: string, args: any = {}, id = `tc_${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });
const params = (o: any = {}) => ({
  tenantId: "T", conversationId: "c1", customerName: "Dana",
  messages: [{ direction: "INBOUND", body: "יש במלאי את המעיל?", createdAt: new Date().toISOString() }],
  copilotConfig: { isActive: true, model: "gpt-test", copilotMode: "CHAT" } as any,
  agentMessage: "what do I tell her?",
  chatHistory: [],
  customerData: { externalId: "9725", channel: "WEBCHAT", status: "OPEN", createdAt: new Date().toISOString(), isHandedOver: true },
  sidePanel: { draftLocale: "he" },
  ...o,
});
const offered = (i = 0) => (H.calls[i].tools as any[]).map((t) => t.function.name).sort();

beforeEach(() => { H.script = []; H.calls = []; H.dispatched = []; });

describe("★ the side chat reads, never acts", () => {
  it("offers the read tools and propose_reply only", async () => {
    H.script = [{ toolCalls: [call("propose_reply", { message: "ok" })] }];
    await provider.chatWithAgent(params());
    expect(offered()).toEqual(["get_contact", "propose_reply", "woocommerce.search_products"]);
  });

  it("a lookup runs, then propose_reply answers with a draft in the customer's language", async () => {
    H.script = [
      { toolCalls: [call("woocommerce.search_products", { query: "מעיל" })] },
      { toolCalls: [call("propose_reply", { message: "3 in stock. Here is a reply:", draft: "כן, יש 3 במלאי." })] },
    ];
    const r = await provider.chatWithAgent(params());
    expect(r).toEqual({ text: "3 in stock. Here is a reply:", draft: "כן, יש 3 במלאי.", toolsCalled: ["woocommerce.search_products"] });
    expect(H.dispatched).toEqual(["woocommerce.search_products"]);
    expect(JSON.stringify(H.calls[0].messages)).toContain("written in Hebrew");
  });

  it("★ an action the model calls anyway is refused at dispatch", async () => {
    H.script = [
      { toolCalls: [call("issue_refund", { amount: 100 })] },
      { toolCalls: [call("propose_reply", { message: "I can't refund; you can." })] },
    ];
    const r = await provider.chatWithAgent(params());
    expect(H.dispatched).toEqual([]);
    expect(r.text).toBe("I can't refund; you can.");
    const toolMsg = H.calls[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("Not available in the side chat");
  });

  it("propose_reply in the same round as a lookup ends the round; the lookup does not run", async () => {
    H.script = [{ toolCalls: [call("woocommerce.search_products"), call("propose_reply", { message: "done" })] }];
    const r = await provider.chatWithAgent(params());
    expect(r.text).toBe("done");
    expect(H.dispatched).toEqual([]);
    expect(H.calls).toHaveLength(1);
  });

  it("the third round is forced to propose_reply", async () => {
    H.script = [
      { toolCalls: [call("get_contact", {}, "a")] },
      { toolCalls: [call("get_contact", {}, "b")] },
      { toolCalls: [call("propose_reply", { message: "final" })] },
    ];
    const r = await provider.chatWithAgent(params());
    expect(r.text).toBe("final");
    expect(H.calls[0].toolChoice).toBeUndefined();
    expect(H.calls[2].toolChoice).toEqual({ type: "function", function: { name: "propose_reply" } });
  });

  it("plain text without the terminator is still an answer, with no draft", async () => {
    H.script = [{ content: "Just tell her it's in stock." }];
    expect(await provider.chatWithAgent(params())).toEqual({ text: "Just tell her it's in stock.", toolsCalled: [] });
  });

  it("an empty answer is a failure, not a blank success", async () => {
    H.script = [{ content: "" }];
    expect((await provider.chatWithAgent(params())).failed).toBe(true);
  });
});

describe("the old panel (no sidePanel) is unchanged", () => {
  it("full surface, no propose_reply, actions still only recommended", async () => {
    H.script = [{ toolCalls: [call("issue_refund")] }, { content: "Recommend a refund." }];
    const r = await provider.chatWithAgent(params({ sidePanel: undefined }));
    expect(offered()).toEqual(["get_contact", "issue_refund", "schedule_meeting", "woocommerce.search_products"]);
    expect(H.dispatched).toEqual([]);
    expect(r.text).toBe("Recommend a refund.");
  });
});

describe("parseProposeReply", () => {
  it("needs a message; a blank draft is no draft", () => {
    expect(parseProposeReply('{"message":"  hi "}')).toEqual({ text: "hi" });
    expect(parseProposeReply('{"message":"hi","draft":"  "}')).toEqual({ text: "hi" });
    expect(parseProposeReply('{"draft":"x"}')).toBeNull();
    expect(parseProposeReply("not json")).toBeNull();
  });
});
