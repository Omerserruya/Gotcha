/**
 * The AI service's conversation routes apply the inbox's visibility rule - the
 * SAME shared implementation the conversation service uses, run for real here
 * against a prisma double that evaluates the visibility OR.
 *
 * A department-restricted agent gets 404 (as for a missing id) on another
 * department's conversation: suggestions, customer memory, TOOL EXECUTION,
 * the commerce panel and its order ACTIONS, and the customer snapshot. An
 * admin reaches the handler. A request with no user fails closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: null as any,
  convs: [
    { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null },
    { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null },
  ],
  reached: [] as string[],
}));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    return (row[k] ?? null) === v;
  });
}

// The shared guard imports prisma from its own module, not the barrel.
vi.mock("@chatcenter/shared/src/lib/prisma", () => ({
  prisma: { conversation: { findFirst: async (a: any) => H.convs.find((c) => matches(c, a.where)) ?? null } },
}));

vi.mock("@chatcenter/shared", async () => {
  const real = await import("@chatcenter/shared/src/lib/conversation-visibility");
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...real,
    authenticate: (req: any, _r: any, n: any) => { if (H.viewer) req.user = { ...H.viewer }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireRole: () => pass,
    requirePermission: () => pass,
    requireEntitlement: () => pass,
    requireInternalKey: pass,
    hasPermission: async () => true,
    isCustomerScopedAction: () => true,
    isOrderScopedAction: () => false,
    resolveConversationLocale: async () => "en",
    resolveEffectiveLocale: async () => "en",
    readDurableSetting: async () => null,
    writeDurableSetting: async () => undefined,
    getRedis: () => ({ get: async () => null, set: async () => "OK" }),
    isEntitled: async () => true,
    publishEvent: async () => undefined,
    normalizePhone: (s: string) => s,
    prisma: {
      conversation: { findFirst: async (a: any) => H.convs.find((c) => matches(c, a.where)) ?? null },
      message: { findFirst: async () => null, findMany: async () => [] },
    },
  };
});
vi.mock("../services/ai-assist.service", () => ({ getSuggestions: vi.fn(), getEffectiveCopilotConfig: async () => ({ copilotMode: "READY_MESSAGE" }) }));
vi.mock("../services/customer-memory.service", () => ({ getCustomerMemory: async () => { H.reached.push("memory"); return { facts: [], historical: null }; } }));
vi.mock("../services/tool-execution.service", () => ({
  getToolsForTenant: vi.fn(), getToolExecutions: vi.fn(),
  executeTool: async () => { H.reached.push("tool"); return { ok: true }; },
}));
vi.mock("../services/agent-config-generator", () => ({ generateAllAgentConfigs: vi.fn(), generateAgentConfig: vi.fn() }));
vi.mock("../services/conversation-intelligence.service", () => ({ analyzeConversation: vi.fn(), getConversationIntelligence: vi.fn(), getConversationReplay: vi.fn() }));
vi.mock("../services/agent-performance.service", () => ({ scoreAgent: vi.fn(), getAgentScore: vi.fn() }));
vi.mock("../services/followup-generator.service", () => ({ generateFollowup: vi.fn() }));
vi.mock("../services/customer-state.service", () => ({ buildCustomerState: vi.fn() }));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "gpt-4o-mini" }));
vi.mock("../services/commerce-context.service", () => ({ buildCommerceContextResponse: async () => { H.reached.push("commerce"); return { state: "not_connected" }; } }));
vi.mock("../services/commerce-actions.service", () => ({ executeCommerceAction: async () => { H.reached.push("action"); return { ok: true }; } }));
vi.mock("../services/customer-snapshot.service", () => ({ buildCustomerSnapshot: async () => { H.reached.push("snapshot"); return {}; } }));

import aiAssist from "../routes/ai-assist";
import commerce from "../routes/commerce-context";
import snapshot from "../routes/customer-snapshot";

const app = express();
app.use(express.json());
app.use("/api/ai-assist", aiAssist);
app.use("/api/commerce-context", commerce);
app.use("/api/customer-snapshot", snapshot);

const SALES_AGENT = { userId: "agent1", role: "AGENT", departmentId: "sales" };
const ADMIN = { userId: "admin1", role: "ADMIN" };
beforeEach(() => { H.reached.length = 0; H.viewer = SALES_AGENT; });

const doors = (id: string) => [
  () => request(app).get(`/api/ai-assist/${id}/suggestions`),
  () => request(app).get(`/api/ai-assist/${id}/customer-memory`),
  () => request(app).post(`/api/ai-assist/${id}/tools/execute`).send({ toolId: "t1", input: {} }),
  () => request(app).get(`/api/commerce-context/${id}`),
  () => request(app).post(`/api/commerce-context/${id}/actions`).send({ action: "add_note", payload: { note: "x" } }),
  () => request(app).get(`/api/customer-snapshot?conversationId=${id}`),
];

describe("★ a department-restricted agent", () => {
  it("gets 404 on every AI door into another department's conversation, and no handler runs", async () => {
    for (const door of doors("c_support")) {
      const r = await door();
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Conversation not found" });
    }
    expect(H.reached).toEqual([]);
  });

  it("reaches the handlers for their own department's conversation", async () => {
    await request(app).get("/api/ai-assist/c_sales/customer-memory");
    await request(app).get("/api/commerce-context/c_sales");
    await request(app).get("/api/customer-snapshot?conversationId=c_sales");
    expect(H.reached).toEqual(["memory", "commerce", "snapshot"]);
  });
});

describe("admin and the fail-closed edge", () => {
  it("an admin reaches the handler for any department", async () => {
    H.viewer = ADMIN;
    await request(app).get("/api/ai-assist/c_support/customer-memory");
    await request(app).get("/api/commerce-context/c_support");
    expect(H.reached).toEqual(["memory", "commerce"]);
  });

  it("★ no authenticated user → 404, never 'unrestricted'", async () => {
    H.viewer = null;
    expect((await request(app).get("/api/ai-assist/c_support/customer-memory")).status).toBe(404);
    expect(H.reached).toEqual([]);
  });
});
