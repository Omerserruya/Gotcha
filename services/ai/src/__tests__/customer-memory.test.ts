/**
 * GET /api/ai-assist/:conversationId/customer-memory - what GOTCHA remembers,
 * exactly as the AI is given it.
 *
 * Pinned:
 *   - through the real router: profile facts (empty values dropped, values
 *     capped at the prompt's 120) and imported history (low-confidence facts
 *     dropped, capped at 6), 404 for another tenant's conversation;
 *   - PARITY: every historical fact the route returns appears in the rendered
 *     prompt block and vice versa;
 *   - the bot's facts block reads ONLY through loadProfileFactsForPrompt, so the
 *     route and the prompt cannot drift (source guard).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";

const H = vi.hoisted(() => ({ profile: null as any, historical: null as any }));

vi.mock("@chatcenter/shared", () => ({
  // Conversation visibility guard, pass-through: this suite covers other
  // behaviour; the guard is proved in conversation-visibility-ai.test.ts.
  requireVisibleConversation: (_q: any, _s: any, n: any) => n(),
  visibleConversationFrom: () => (_q: any, _s: any, n: any) => n(),
  canViewConversation: async () => true,
  visibilityClause: () => null,
  viewerOf: (req: any) => ({ userId: req?.user?.userId }),
  requireInternalKey: (_q: any, _s: any, n: any) => n(),
  requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "agent1", role: "AGENT" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  resolveConversationLocale: async () => "en",
  resolveEffectiveLocale: async () => "en",
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  getRedis: () => ({}),
  isEntitled: async () => true,
  publishEvent: async () => undefined,
  normalizePhone: (s: string) => s.replace(/\D/g, ""),
  prisma: {
    conversation: {
      findFirst: async (a: any) => (a.where.id === "c1" && a.where.tenantId === "T"
        ? { id: "c1", customerExternalId: "+972501234567" } : null),
    },
    customerProfile: { findUnique: async () => H.profile },
    customerHistoricalMemory: {
      findFirst: async (a: any) => (a.where.tenantId === "T" && a.where.customerExternalId.in.includes("972501234567") ? H.historical : null),
    },
  },
}));
vi.mock("../services/intelligence-ingest.service", () => ({
  resolveIdentity: async (t: string, c: string) => (t === "T" && c === "c1" ? { identityKey: "wa:972501234567" } : null),
}));
vi.mock("../services/ai-assist.service", () => ({ getSuggestions: vi.fn(), getEffectiveCopilotConfig: async () => null }));
vi.mock("../services/agent-config-generator", () => ({ generateAllAgentConfigs: vi.fn(), generateAgentConfig: vi.fn() }));
vi.mock("../services/conversation-intelligence.service", () => ({ analyzeConversation: vi.fn(), getConversationIntelligence: vi.fn(), getConversationReplay: vi.fn() }));
vi.mock("../services/tool-execution.service", () => ({ getToolsForTenant: vi.fn(), executeTool: vi.fn(), getToolExecutions: vi.fn() }));
vi.mock("../services/agent-performance.service", () => ({ scoreAgent: vi.fn(), getAgentScore: vi.fn() }));
vi.mock("../services/followup-generator.service", () => ({ generateFollowup: vi.fn() }));
vi.mock("../services/customer-state.service", () => ({ buildCustomerState: vi.fn() }));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "gpt-4o-mini" }));

import aiAssistRoutes from "../routes/ai-assist";
import { renderHistoricalMemoryBlock } from "../services/historical-intelligence/memory-block.service";

const app = express();
app.use(express.json());
app.use("/api/ai-assist", aiAssistRoutes);

beforeEach(() => {
  H.profile = {
    facts: {
      business_type: { value: "Boutique", confidence: 0.9, source: "llm_live", observedAt: "2026-10-01T10:00:00Z" },
      empty_one: { value: "  ", confidence: 0.9 },
      long_note: { value: "x".repeat(300), confidence: 0.7, source: "llm_close" },
    },
  };
  H.historical = {
    summary: " Regular buyer of linen dresses. ",
    facts: [
      { text: "Prefers size M", confidence: "high" },
      { text: "Maybe lives in Haifa", confidence: "low" },
      { text: "Asks for gift wrapping", confidence: "medium" },
      ...Array.from({ length: 8 }, (_, i) => ({ text: `extra ${i}`, confidence: "high" })),
    ],
  };
});

describe("GET /:conversationId/customer-memory", () => {
  it("★ returns what the prompt gets: non-empty facts, capped; confident history, capped", async () => {
    const r = await request(app).get("/api/ai-assist/c1/customer-memory");
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.facts.map((f: any) => f.key)).toEqual(["business_type", "long_note"]);
    expect(d.facts[0]).toEqual({ key: "business_type", value: "Boutique", confidence: 0.9, source: "llm_live", observedAt: "2026-10-01T10:00:00Z" });
    expect(d.facts[1].value).toHaveLength(120);
    expect(d.historical.summary).toBe("Regular buyer of linen dresses.");
    expect(d.historical.facts).toHaveLength(6);
    expect(d.historical.facts).not.toContain("Maybe lives in Haifa");
  });

  it("★ PARITY: every historical fact on screen is in the prompt block, and every one in the block is on screen", async () => {
    const r = await request(app).get("/api/ai-assist/c1/customer-memory");
    const block = await renderHistoricalMemoryBlock({ tenantId: "T", customerExternalId: "+972501234567" });
    const blockFacts = block.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    expect(blockFacts).toEqual(r.body.data.historical.facts);
    expect(block).toContain(r.body.data.historical.summary);
  });

  it("no memory at all: empty facts and null history, not an error", async () => {
    H.profile = null; H.historical = null;
    const r = await request(app).get("/api/ai-assist/c1/customer-memory");
    expect(r.body.data).toEqual({ conversationId: "c1", facts: [], historical: null });
  });

  it("another tenant's conversation is a 404", async () => {
    expect((await request(app).get("/api/ai-assist/other/customer-memory")).status).toBe(404);
  });

  it("★ the bot's facts block reads profile facts ONLY through the shared loader", () => {
    const src = fs.readFileSync(path.join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function buildSessionFactsBlock"), src.indexOf("async function generateAIBotReplyInner"));
    expect(fn).toContain("loadProfileFactsForPrompt(");
    expect(fn).not.toMatch(/customerProfile/);
  });
});
