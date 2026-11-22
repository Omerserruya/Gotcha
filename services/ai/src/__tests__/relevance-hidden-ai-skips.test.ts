/**
 * Hidden conversations get no automation (2026-11-22), the ai's own paths: live extraction, copilot
 * suggestions, the post-chat pipeline (summary, CRM write, follow-up, brief) and the close analysis each
 * read the label when they run and stop on a hidden one. Not hidden: they go on as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  hidden: false,
  hiddenCalls: [] as any[],
  conv: {} as any,
  specs: vi.fn(async () => []),
  entitled: vi.fn(async () => false),
  pipeline: vi.fn(async () => ({ ok: true, summarized: false, crmWritten: false, tasksCreated: 0, followupScheduled: false, notes: [] as string[] })),
  prior: vi.fn(async () => ({ analyzedAt: new Date("2100-01-01"), metadata: { source: "close-analysis" } })),
}));

vi.mock("@chatcenter/shared/src/lib/relevance-hidden", async (orig) => ({
  ...(await orig<any>()),
  isConversationHidden: vi.fn(async (...a: any[]) => { H.hiddenCalls.push(a.slice(0, 2)); return H.hidden; }),
  logHiddenSkip: vi.fn(),
}));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  prisma: {
    conversation: { findUnique: async () => H.conv, findFirst: async () => H.conv },
    conversationIntelligence: { findUnique: H.prior },
  },
  isEntitled: H.entitled,
  subscribeToEvents: () => ({ close: async () => undefined }),
  resolveEffectiveLocale: async () => ({ effective: "en" }),
  // The analysis goes on to its lock after the reads this test is about: stop it there.
  getRedis: () => { throw new Error("stop at the lock"); },
}));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", getMicroModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
vi.mock("../services/post-conversation-config.service", () => ({ getExtractionFieldSpecs: H.specs }));
vi.mock("../services/intelligence-live-extract.service", () => ({ extractFieldsLive: vi.fn(async () => []) }));
vi.mock("../services/intelligence-ingest.service", () => ({ ingestConversationFacts: vi.fn() }));
vi.mock("../services/skills", () => ({ requiredKnowledgeFor: () => [] }));
vi.mock("../services/post-chat-pipeline.service", () => ({ runPostChatPipeline: H.pipeline }));
vi.mock("../services/customer-brief.service", () => ({ refreshCustomerBriefFromConversation: vi.fn(async () => null) }));
vi.mock("../routes/crm-panel", () => ({ syncCloseToCrm: vi.fn(async () => undefined) }));

import { runExtraction } from "../workers/intelligence-live/subscriber";
import { handleClosed } from "../workers/post-chat/subscriber";
import { runIfEligible } from "../services/copilot-suggestions.service";
import { analyzeConversationOnClose } from "../services/conversation-analysis.service";

beforeEach(() => {
  H.hidden = false; H.hiddenCalls = [];
  [H.specs, H.entitled, H.pipeline, H.prior].forEach((f) => f.mockClear());
});

describe("live extraction", () => {
  beforeEach(() => { H.conv = { status: "OPEN", channel: "WHATSAPP", assignedAiAgentId: null }; });
  it("hidden: no extraction at all", async () => {
    H.hidden = true;
    await runExtraction("c1", "t1");
    expect(H.hiddenCalls).toEqual([["t1", "c1"]]);
    expect(H.specs).not.toHaveBeenCalled();
  });
  it("not hidden: extracts as before", async () => {
    await runExtraction("c1", "t1");
    expect(H.specs).toHaveBeenCalledWith("t1");
  });
});

describe("copilot suggestions", () => {
  beforeEach(() => { H.conv = { status: "OPEN", channel: "WHATSAPP", assignedAgentId: "u1", isHandedOver: true, handledBy: "human", chatbotNodeId: null, assignedAiAgentId: null }; });
  it("hidden: skipped, reason hidden, before the entitlement read", async () => {
    H.hidden = true;
    expect(await runIfEligible("t1", "c1")).toEqual({ status: "skipped", reason: "hidden" });
    expect(H.entitled).not.toHaveBeenCalled();
  });
  it("not hidden: goes on to the entitlement as before", async () => {
    expect(await runIfEligible("t1", "c1")).toEqual({ status: "skipped", reason: "not_entitled" });
    expect(H.entitled).toHaveBeenCalled();
  });
});

describe("the post-chat pipeline", () => {
  const closed = { event: "conversation:closed", tenantId: "t1", data: { id: "c1", channel: "WHATSAPP" } } as any;
  it("hidden: no summary, CRM write, follow-up or brief", async () => {
    H.hidden = true;
    await handleClosed(closed);
    expect(H.hiddenCalls).toEqual([["t1", "c1"]]);
    expect(H.pipeline).not.toHaveBeenCalled();
  });
  it("not hidden: the pipeline runs as before", async () => {
    await handleClosed(closed);
    expect(H.pipeline).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", conversationId: "c1" }));
  });
});

describe("the close analysis", () => {
  beforeEach(() => { H.conv = { id: "c1", status: "CLOSED", channel: "WHATSAPP", isTest: false, customerExternalId: "9725", origin: "LIVE", lastMessageAt: new Date("2026-11-22"), updatedAt: new Date("2026-11-22"), aiSummary: null }; });
  it("hidden: answers hidden before any analysis read", async () => {
    H.hidden = true;
    expect(await analyzeConversationOnClose("t1", "c1", { trigger: "closed", force: true })).toBe("hidden");
    expect(H.prior).not.toHaveBeenCalled();
  });
  it("not hidden: goes on as before", async () => {
    await expect(analyzeConversationOnClose("t1", "c1", { trigger: "closed", force: true })).rejects.toThrow("stop at the lock");
    expect(H.prior).toHaveBeenCalled();
  });
});
