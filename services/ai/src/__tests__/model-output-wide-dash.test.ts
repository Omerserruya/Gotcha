/**
 * ★ No wide dash (em, en, horizontal bar) in model text the product shows.
 * The model writes them anyway; each output site strips them:
 *   - operator-facing text gets a regular hyphen (withoutWideDashes)
 *   - customer-style text (the agent loop's reply, the voice sample) gets the
 *     customer reply rule (humanizeReply: a comma, never a spaced hyphen)
 * Every case below answers with dashes and asserts none come out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ content: "" }));
const DASHED = "Fast\u2014friendly \u2013 clear\u2015done";
const WIDE = /[\u2013\u2014\u2015]/;

vi.mock("../services/ai.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    generateResponse: async () => ({ content: H.content, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
  };
});
vi.mock("../services/knowledge.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, retrieveRelevantChunks: async () => [], buildKnowledgeContext: () => "" };
});
vi.mock("../services/company-context.service", () => ({ getCompanyContext: async () => ({ organizationName: "Lumiere" }) }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const model = (row: any = null, rows: any[] = []) => ({
    findFirst: async () => row, findUnique: async () => row, findMany: async () => rows, count: async () => 0,
    update: async (a: any) => a.data, create: async (a: any) => a.data, upsert: async (a: any) => a.create,
  });
  const agent = { id: "ag1", tenantId: "T", name: "Noa", role: "SALES", goal: "sell", identity: {}, persona: {}, description: "", channels: [] };
  return {
    ...actual,
    authenticate: (req: any, _r: any, next: any) => { req.user = { userId: "u1", role: "SYSTEM_ADMIN", tenantId: "T" }; req.tenantId = "T"; next(); },
    resolveTenant: (_q: any, _r: any, next: any) => next(),
    requireActiveTenant: () => (_q: any, _r: any, next: any) => next(),
    requireSystemAdmin: () => (_q: any, _r: any, next: any) => next(),
    requireInternalKey: (_q: any, _r: any, next: any) => next(),
    prisma: new Proxy({}, {
      get: (_t, name: string) => {
        if (name === "aIAgent") return model(agent);
        if (name === "message") return model(null, [{ id: "m1", direction: "INBOUND", body: "Hi", createdAt: new Date(0), senderName: "Dana" }]);
        if (name === "conversation") return model({ id: "c1", tenantId: "T", channel: "WHATSAPP", customerName: "Dana" });
        if (name === "$transaction") return async (x: any) => (typeof x === "function" ? x({}) : Promise.all(x));
        return model();
      },
    }),
  };
});

import { tuneEmployeeChat } from "../services/employee-tuning.service";
import { writeReply } from "../services/agent-loop/writer";
import { generateReadinessReport } from "../services/agent-readiness.service";
import { generateSalesContext } from "../services/sales-context-generator.service";
import { extractFieldsLive } from "../services/intelligence-live-extract.service";
import { summarizePostConversation } from "../services/post-conversation-summarizer.service";
import systemChat from "../routes/system-chat";
import voiceSample from "../routes/internal-voice-sample";
import actionPlanner from "../routes/action-planner";

const app = (path: string, r: any) => { const a = express(); a.use(express.json()); a.use(path, r); return a; };

beforeEach(() => { H.content = ""; });

describe("★ operator-facing model text: a regular hyphen", () => {
  it("employee tuning: the reply and the persona it writes", async () => {
    H.content = JSON.stringify({ reply: DASHED, persona: { personality: DASHED, instructions: [DASHED] } });
    const r = await tuneEmployeeChat({ tenantId: "T", locale: "en", name: "Noa", role: "sales", persona: {}, messages: [{ role: "user", content: "be warm" }] } as any);
    expect(WIDE.test(JSON.stringify(r))).toBe(false);
    expect(r.reply).toContain("Fast-friendly - clear-done");
  });

  it("the readiness report's questions and recommendations", async () => {
    H.content = JSON.stringify({ questions: [{ question: DASHED, coverage: "full", reason: DASHED }], recommendations: [{ type: "other", title: DASHED, detail: DASHED }] });
    const r: any = await generateReadinessReport("T", "ag1", "en");
    expect(r.error).toBeUndefined();
    expect(r.questions[0].question).toBe("Fast-friendly - clear-done");
    expect(WIDE.test(JSON.stringify(r))).toBe(false);
  });

  it("the sales context autofill", async () => {
    H.content = JSON.stringify({ whatWeSell: DASHED, idealCustomerProfile: DASHED, problemsSolved: [DASHED], disqualifiers: [DASHED] });
    const r = await generateSalesContext("T", "ag1");
    expect(r?.whatWeSell).toBe("Fast-friendly - clear-done");
    expect(WIDE.test(JSON.stringify(r))).toBe(false);
  });

  it("live field extraction", async () => {
    H.content = JSON.stringify({ company: DASHED });
    const r = await extractFieldsLive({ tenantId: "T", conversationId: "c1", fields: ["company"] });
    expect(WIDE.test(JSON.stringify(r))).toBe(false);
  });

  it("the post-conversation summary", async () => {
    H.content = JSON.stringify({ summary: DASHED, bullets: [DASHED], action_items: [{ title: DASHED }] });
    const r = await summarizePostConversation({ tenantId: "T", conversationId: "c1", channel: "chat", locale: "en" } as any);
    expect(WIDE.test(JSON.stringify(r))).toBe(false);
  });

  it("the knowledge ask (system chat)", async () => {
    H.content = DASHED;
    const r = await request(app("/api/system-chat", systemChat)).post("/api/system-chat/ask").send({ question: "what?" });
    expect(r.status).toBe(200);
    expect(r.body.answer).toBe("Fast-friendly - clear-done");
  });

  it("the action planner's plan", async () => {
    H.content = JSON.stringify({ steps: [{ description: DASHED }] });
    const r = await request(app("/api/action-planner", actionPlanner)).post("/api/action-planner/plan").send({ prompt: "follow up" });
    expect(r.status).toBe(200);
    expect(WIDE.test(JSON.stringify(r.body))).toBe(false);
  });
});

describe("★ customer-style text: the customer reply rule", () => {
  it("the agent loop's reply joins with a comma, never a dash", async () => {
    H.content = "Sure\u2014I can help \u2013 tomorrow works";
    const r = await writeReply({ purpose: "help", keyPoints: ["help"] } as any, { tenantId: "T", conversationId: "c1", language: "en" } as any);
    expect(r).toBe("Sure, I can help, tomorrow works");
  });

  it("the voice sample", async () => {
    H.content = "Sorry about that\u2014let me check";
    const r = await request(app("/", voiceSample)).post("/internal/voice-sample").send({ tenantId: "T", guidance: "warm" });
    expect(r.status).toBe(200);
    expect(r.body.reply).toBe("Sorry about that, let me check");
  });
});
