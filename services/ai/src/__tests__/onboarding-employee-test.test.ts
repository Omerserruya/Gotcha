/**
 * The onboarding employee test (2026-10-23): the real runtime, sandboxed, read
 * only, store reads as the owner - and none of that can leak onto a channel
 * turn. Mocks only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  conv: null as any,
  setting: null as string | null,
  agent: { id: "ag1" } as any,
  turn: null as any,
  sandboxCalls: [] as any[],
  scopeDuringTurn: null as any,
  replyOpts: [] as any[],
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => H.setting,
    prisma: {
      ...actual.prisma,
      conversation: { findFirst: async () => H.conv },
      aIAgent: { findFirst: async () => H.agent },
    },
  };
});
vi.mock("../services/sandbox-conversation.service", async () => {
  const { platformPaidScope } = await import("../services/ai.service");
  return {
    runSandboxTurn: async (input: any) => {
      H.sandboxCalls.push(input);
      H.scopeDuringTurn = platformPaidScope.getStore() ?? null;
      return H.turn;
    },
  };
});

import { onboardingTestFor, readOnlySurface } from "../services/ai-bot.service";
import { testOnboardingEmployee, orderNumberIn } from "../services/onboarding-employee-test.service";
import { platformPaidScope } from "../services/ai.service";

const fn = (name: string) => ({ type: "function", function: { name } });

beforeEach(() => {
  H.conv = { customerExternalId: "sandbox:ag1:u1", handledBy: "sandbox" };
  H.setting = "ag1";
  H.agent = { id: "ag1" };
  H.sandboxCalls = []; H.scopeDuringTurn = null; H.replyOpts = [];
  H.turn = {
    reply: "ההזמנה #1043 נשלחה אתמול",
    diagnostics: { knowledgeUsed: [{ title: "משלוחים", sourceType: "text" }] },
    toolCallLog: [{ tool: "shopify.get_order", result: JSON.stringify({ order: { name: "#1043", fulfillment_status: "fulfilled" } }) }],
  };
});

describe("the flag counts only where it can", () => {
  const base = { tenantId: "T", conversationId: "c1", sandbox: { enabled: true as const, writes: "safe" as const }, onboardingTest: { actorUserId: "u1" } };
  it("a sandboxed turn in a sandbox conversation: honoured", async () => {
    expect(await onboardingTestFor(base)).toEqual({ actorUserId: "u1" });
  });
  it("a REAL conversation with the same flag: dropped, so it keeps the customer guard", async () => {
    H.conv = { customerExternalId: "972501234567", handledBy: "ai_agent" };
    expect(await onboardingTestFor(base)).toBeNull();
  });
  it("not sandboxed: dropped", async () => {
    expect(await onboardingTestFor({ ...base, sandbox: undefined })).toBeNull();
  });
  it("a sandbox: prefix without the sandbox marker: dropped", async () => {
    H.conv = { customerExternalId: "sandbox:x", handledBy: "ai_agent" };
    expect(await onboardingTestFor(base)).toBeNull();
  });
  it("store reads take the owner scope ONLY through the honoured flag; otherwise 'customer'", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    const scopes = src.match(/accessScope: [^,\n]+/g) ?? [];
    expect(scopes.length).toBeGreaterThanOrEqual(2);
    for (const s of scopes) expect(s).toBe('accessScope: opts.onboardingTest ? "internal" : "customer"');
    // ...and opts.onboardingTest is replaced by the checked value before the turn runs.
    expect(src).toContain("opts = { ...opts, onboardingTest: honoured ?? undefined };");
  });
});

describe("the channel path can never set it", () => {
  it("/api/ai-bot/reply forwards named fields only: an onboardingTest in the body never reaches the runtime", async () => {
    vi.resetModules();
    // The worker's own key: the route is internal-only.
    process.env.INTERNAL_SERVICE_KEY = "test-internal-key-0123456789abcdef0123456789";
    vi.doMock("../services/ai-bot.service", () => ({
      generateAIBotReply: async (opts: any) => { H.replyOpts.push(opts); return { reply: "ok" }; },
    }));
    const { default: router } = await import("../routes/ai-bot");
    const app = express();
    app.use(express.json());
    app.use("/api/ai-bot", router);
    await request(app).post("/api/ai-bot/reply").set("x-internal-key", process.env.INTERNAL_SERVICE_KEY!).send({
      tenantId: "T", conversationId: "c1", aiAgentId: "ag1", incomingMessage: "hi",
      onboardingTest: { actorUserId: "attacker" }, sandbox: { enabled: true, writes: "real" },
    });
    expect(H.replyOpts).toHaveLength(1);
    expect(H.replyOpts[0].onboardingTest).toBeUndefined();
    expect(H.replyOpts[0].sandbox).toBeUndefined();
    vi.doUnmock("../services/ai-bot.service");
  });
});

describe("read-only surface", () => {
  it("keeps reads, drops every action, write and hand-over - so no approval path can open", () => {
    const tools = [
      fn("shopify.get_order"), fn("woocommerce.list_orders"), fn("search_knowledge_base"),
      fn("shopify.create_refund"), fn("shopify.cancel_order"), fn("escalate_to_human"), fn("integration_create_lead"), fn("woocommerce.update_order"),
    ];
    expect(readOnlySurface(tools as any).map((t: any) => t.function.name).sort()).toEqual(["shopify.get_order", "woocommerce.list_orders"].concat(
      readOnlySurface([fn("search_knowledge_base")] as any).map((t: any) => t.function.name),
    ).sort());
    for (const w of ["shopify.create_refund", "shopify.cancel_order", "escalate_to_human", "integration_create_lead", "woocommerce.update_order"]) {
      expect(readOnlySurface([fn(w)] as any)).toEqual([]);
    }
  });
  it("background CRM rounds and the CRM prefetch are off for the test turn", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("if (!opts.onboardingTest) {\n    const committedSoFar");
    expect(src).toContain("const prefetch = opts.onboardingTest ? null : await prefetchCrmContext(");
    expect(src).toContain('const loopMode = opts.onboardingTest ? "off" : agentLoopMode(opts.tenantId);');
  });
});

describe("the test", () => {
  it("runs the real sandbox turn: reset (only its 2 messages), safe writes, read-only owner test, platform-paid", async () => {
    const r = await testOnboardingEmployee({ tenantId: "T", userId: "u1", question: "איפה ההזמנה 1043?" });
    expect(H.sandboxCalls).toEqual([{
      tenantId: "T", agentId: "ag1", userId: "u1", message: "איפה ההזמנה 1043?", writes: "safe", reset: true,
      onboardingTest: { actorUserId: "u1" },
    }]);
    expect(H.scopeDuringTurn).toEqual({ reason: "onboarding_test" });
    expect(platformPaidScope.getStore()).toBeUndefined();
    expect(r).toEqual({
      answer: "ההזמנה #1043 נשלחה אתמול",
      toolsUsed: [{ name: "shopify.get_order", ok: true }],
      sources: [{ title: "משלוחים", sourceType: "text" }],
      usedRealOrder: true, orderNumber: "1043", platform: "shopify",
    });
  });

  it("a refused order lookup is not a real order", async () => {
    H.turn.toolCallLog = [{ tool: "shopify.get_order", result: "access_denied: no identity" }];
    const r = await testOnboardingEmployee({ tenantId: "T", userId: "u1", question: "q" });
    expect(r).toMatchObject({ usedRealOrder: false, orderNumber: null, toolsUsed: [{ name: "shopify.get_order", ok: false }] });
  });

  it("before go-live: 409 NOT_LIVE, no turn", async () => {
    H.setting = null;
    await expect(testOnboardingEmployee({ tenantId: "T", userId: "u1", question: "q" })).rejects.toMatchObject({ code: "NOT_LIVE" });
    expect(H.sandboxCalls).toEqual([]);
  });
});

describe("order numbers as the customer sees them", () => {
  it.each([
    ['{"order":{"name":"#1043"}}', "1043"],
    ['{"orders":[{"number":"5521"}]}', "5521"],
    ['{"order_number":1001}', "1001"],
    ['{"product":{"name":"Shirt"}}', null],
    ["not json", null],
  ])("%s -> %s", (r, n) => expect(orderNumberIn(r)).toBe(n));
});
