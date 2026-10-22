/**
 * ★ Which closes reach the conversation analysis (the post-chat subscriber):
 *   - `conversation:closed` (agent, bot, idle timeout, WhatsApp handoff): the
 *     pipeline first, then the analysis (it reuses the pipeline's summary)
 *   - `conversation:updated` with status CLOSED (the flow builder's close
 *     node, an expired comment-DM bridge): the analysis only, never the
 *     pipeline's CRM writes
 *   - any other update, and VOICE: nothing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ handler: null as null | ((e: any) => void), order: [] as string[], analyses: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    subscribeToEvents: (h: any) => { H.handler = h; return {} as any; },
    resolveEffectiveLocale: async () => ({ effective: "he" }),
    prisma: { conversation: { findUnique: async (a: any) => ({ channel: a.where.id === "voice1" ? "VOICE" : "WHATSAPP" }) } },
  };
});
vi.mock("../services/post-chat-pipeline.service", () => ({
  runPostChatPipeline: async () => { H.order.push("pipeline"); return { ok: true, summarized: true, crmWritten: false, tasksCreated: 0, followupScheduled: false, notes: [] }; },
}));
vi.mock("../services/customer-brief.service", () => ({ refreshCustomerBriefFromConversation: async () => null }));
vi.mock("../routes/crm-panel", () => ({ syncCloseToCrm: async () => { H.order.push("crm"); } }));
vi.mock("../services/conversation-analysis.service", () => ({
  analyzeConversationOnClose: async (tenantId: string, id: string, o: any) => { H.order.push("analysis"); H.analyses.push({ tenantId, id, ...o }); return "analyzed"; },
}));

import { startPostChatSubscriber } from "../workers/post-chat/subscriber";
startPostChatSubscriber();

const fire = async (e: any) => { H.handler!(e); await new Promise((r) => setTimeout(r, 20)); };

beforeEach(() => { H.order = []; H.analyses = []; });

describe("★ every close reaches the analysis", () => {
  it("closed: pipeline, then the analysis", async () => {
    await fire({ event: "conversation:closed", tenantId: "T", data: { id: "c1", channel: "WHATSAPP" } });
    expect(H.order.indexOf("pipeline")).toBeLessThan(H.order.indexOf("analysis"));
    expect(H.analyses).toEqual([{ tenantId: "T", id: "c1", trigger: "closed" }]);
  });

  it("closed with conversationId instead of id (the WhatsApp handoff's shape)", async () => {
    await fire({ event: "conversation:closed", tenantId: "T", data: { conversationId: "c2", reason: "continued_on_whatsapp" } });
    expect(H.analyses).toEqual([{ tenantId: "T", id: "c2", trigger: "closed" }]);
  });

  it("updated with status CLOSED (a flow's close node): the analysis only", async () => {
    await fire({ event: "conversation:updated", tenantId: "T", data: { id: "c3", status: "CLOSED" } });
    expect(H.order).toEqual(["analysis"]);
    expect(H.analyses).toEqual([{ tenantId: "T", id: "c3", trigger: "updated" }]);
  });

  it("any other update: nothing", async () => {
    await fire({ event: "conversation:updated", tenantId: "T", data: { id: "c4", status: "OPEN" } });
    await fire({ event: "conversation:updated", tenantId: "T", data: { id: "c4" } });
    expect(H.order).toEqual([]);
  });

  it("a call: nothing (voice has its own post-call analysis)", async () => {
    await fire({ event: "conversation:closed", tenantId: "T", data: { id: "voice1" } });
    expect(H.order).toEqual([]);
  });
});
