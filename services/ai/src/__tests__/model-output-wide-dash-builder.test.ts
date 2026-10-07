/**
 * ★ No wide dash in model text (continued): the employee builder's stream and
 * what it writes into the draft, the customer brief (new and cached), and the
 * generated employee description.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ content: "", stream: [] as any[], updates: [] as any[], briefWrites: [] as any[], briefRow: null as any }));
const DASHED = "Fast\u2014friendly \u2013 clear\u2015done";
const WIDE = /[\u2013\u2014\u2015]/;

vi.mock("../services/ai.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    generateResponse: async () => ({ content: H.content, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    streamResponse: async function* () { const ev = H.stream.shift() ?? { done: true, content: "", toolCalls: [], usage: {} }; for (const e of Array.isArray(ev) ? ev : [ev]) yield e; },
  };
});
vi.mock("../services/agent-memory.service", () => ({
  appendToMemory: async () => undefined, getSessionMemory: async () => [], memoryToChatMessages: () => [], sanitizeHistoryForLLM: (x: any) => x,
}));
vi.mock("../services/memory/customer-context.service", () => ({
  loadCustomerContext: async () => ({ personId: "p1", crmContactId: null, vendor: null, crmObjectKind: null, sibling_conversation_ids: [], recent_summaries: [], open_issues: [], recent_crm_notes: [], recent_activities: [], sentiment_trend: [], facts: [], profile: {} }),
}));
vi.mock("../services/customer-commerce-facts.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, loadCustomerCommerceFacts: async () => null };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const agent = { id: "ag1", tenantId: "T", name: "Noa", role: "customer_support", goal: "help", identity: {}, knowledgeBases: [], status: "DRAFT" };
  const model = (row: any = null, rows: any[] = []) => ({
    findFirst: async () => row, findUnique: async () => row, findMany: async () => rows, count: async () => 0,
    update: async (a: any) => { H.updates.push(a.data); return { ...row, ...a.data }; },
    create: async (a: any) => ({ id: "new1", ...a.data }), upsert: async (a: any) => a.create,
    deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }),
  });
  return {
    ...actual,
    authenticate: (req: any, _r: any, next: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "T" }; req.tenantId = "T"; next(); },
    resolveTenant: (_q: any, _r: any, next: any) => next(),
    requireActiveTenant: () => (_q: any, _r: any, next: any) => next(),
    requirePermissionOrRole: () => (_q: any, _r: any, next: any) => next(),
    requirePermission: () => (_q: any, _r: any, next: any) => next(),
    prisma: new Proxy({}, {
      get: (_t, name: string) => {
        if (name === "aIAgent") return model(agent);
        if (name === "conversation") return model({ channel: "WHATSAPP", customerExternalId: "972500000000", customerName: "Dana" });
        if (name === "customerBrief") {
          const m = model(H.briefRow);
          return { ...m, upsert: async (a: any) => { H.briefWrites.push(a); return { id: "b1", ...a.create, generatedAt: new Date(0) }; }, create: async (a: any) => { H.briefWrites.push(a); return { id: "b1", ...a.data, generatedAt: new Date(0) }; } };
        }
        if (name === "$transaction") return async (x: any) => (typeof x === "function" ? x(new Proxy({}, { get: () => model() })) : Promise.all(x));
        return model();
      },
    }),
  };
});

import { runBuilder } from "../services/agent-builder.service";
import { getCustomerBrief, refreshCustomerBriefFromConversation } from "../services/customer-brief.service";
import aiAgents from "../routes/ai-agents";

beforeEach(() => { H.content = ""; H.stream = []; H.updates = []; H.briefWrites = []; H.briefRow = null; });

describe("★ the employee builder", () => {
  it("streams no wide dash, and writes none into the draft", async () => {
    H.stream = [
      { done: true, content: "", usage: {}, toolCalls: [{ id: "t1", type: "function", function: { name: "set_company_overview", arguments: JSON.stringify({ overview: DASHED }) } }] },
      [{ contentDelta: "Great\u2014" }, { contentDelta: "next \u2013 your goal?" }, { done: true, content: "Great\u2014next \u2013 your goal?", toolCalls: [], usage: {} }],
    ];
    const events: any[] = [];
    await runBuilder({ tenantId: "T", userId: "u1", agentId: "ag1", message: "we sell lamps", locale: "en" } as any, (e) => { events.push(e); });
    const tokens = events.filter((e) => e.type === "token").map((e) => e.text).join("");
    expect(tokens).toBe("Great-next - your goal?");
    expect(WIDE.test(JSON.stringify(events))).toBe(false);
    const written = H.updates.find((d) => d.identity)?.identity?.companyOverview;
    expect(written).toBe("Fast-friendly - clear-done");
  });
});

describe("★ the customer brief", () => {
  it("a newly generated brief is stored without one", async () => {
    H.content = JSON.stringify({ brief: DASHED, signals: [DASHED], tone: DASHED, mood: null, recommended_behaviors: [DASHED] });
    await refreshCustomerBriefFromConversation({ tenantId: "T", conversationId: "c1", locale: "en" });
    expect(H.briefWrites.length).toBe(1);
    expect(WIDE.test(JSON.stringify(H.briefWrites[0]))).toBe(false);
  });

  it("a brief cached before the rule is read without one", async () => {
    H.briefRow = { id: "b1", identityKey: "person:p1", brief: DASHED, signals: [], tone: null, mood: null, recommendedBehaviors: [], locale: "en", generatedAt: new Date(0) };
    const r = await getCustomerBrief({ tenantId: "T", hints: { personId: "p1" } as any, locale: "en" });
    expect(r?.brief).toBe("Fast-friendly - clear-done");
  });
});

describe("★ the generated employee description", () => {
  it("POST /generate keeps no wide dash in the description", async () => {
    H.content = DASHED;
    const a = express(); a.use(express.json()); a.use("/api/ai-agents", aiAgents);
    const r = await request(a).post("/api/ai-agents/generate").send({ answers: { role: "support", responsibility: "answer questions" } });
    expect(r.status).toBeLessThan(300);
    expect(JSON.stringify(r.body)).toContain("Fast-friendly - clear-done");
    expect(WIDE.test(JSON.stringify(r.body))).toBe(false);
  });
});
