/**
 * Reply engine v2, one whole turn against fakes: the model is scripted, the
 * store and the database are doubles. Pins the turn's contract end to end:
 * every allowed tool offered (sorted, respond included), a store search
 * grounded into keys, cards staged from keys, Gate 3 rewrite then fallback,
 * shadow simulating writes on the platform's credits, Gate 1 stopping early.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

const h = vi.hoisted(() => ({
  responses: [] as any[],
  calls: [] as any[],
  scopeSeen: [] as Array<string | null>,
  dispatched: [] as any[],
  submitted: [] as any[],
  upserts: [] as any[],
  audits: [] as any[],
  staged: [] as any[],
  agentStatus: "ACTIVE",
  policy: {} as Record<string, string>,
}));

vi.mock("@chatcenter/shared", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    prisma: {
      aIAgent: { findUnique: async () => ({ id: "ag1", tenantId: "t1", name: "נועה", role: "customer_support", status: h.agentStatus, model: "gpt-6-luna", persona: { gender: "female" }, escalationMessage: "x" }) },
      conversation: { findFirst: async () => ({ id: "c1", tenantId: "t1", channel: "WEBCHAT", customerExternalId: "v1" }) },
      contact: { findFirst: async () => null },
      approvalRequest: { findMany: async () => [] },
      tenantIntegration: { findMany: async () => [{ integration: { slug: "woocommerce" } }] },
      conversationState: {
        findUnique: async () => null,
        upsert: async (a: any) => { h.upserts.push(a); return {}; },
        update: async () => ({}),
      },
      auditLog: { create: async (a: any) => { h.audits.push(a); return {}; } },
    },
    checkAiAllowed: async () => ({ allowed: true }),
    buildAgentToolsForAIAgent: async () => [
      { type: "function", function: { name: "escalate_to_human", description: "hand over", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "send_product_card", description: "card", parameters: { type: "object", properties: {} } } },
    ],
    evaluatePolicies: async ({ toolName }: any) => ({ decision: h.policy[toolName] ?? "ALLOW", reason: "test" }),
    dispatchToolCall: async (tc: any, ctx: any) => {
      h.dispatched.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments), sandbox: ctx.sandbox ?? null });
      if (tc.function.name === "woocommerce.list_products") return { toolCallId: tc.id, content: JSON.stringify({ ok: true, result: [{ id: 101, name: "Canvas Tote", price: "79" }] }) };
      return { toolCallId: tc.id, content: JSON.stringify({ ok: true, simulated: !!ctx.sandbox }) };
    },
  };
});

vi.mock("../services/ai.service", () => ({
  platformPaidScope: new AsyncLocalStorage<{ reason: string }>(),
  generateResponse: vi.fn(async (p: any) => {
    const { platformPaidScope } = await import("../services/ai.service");
    h.scopeSeen.push((platformPaidScope as any).getStore()?.reason ?? null);
    h.calls.push(p);
    const next = h.responses.shift();
    if (!next) throw new Error("no scripted response");
    return { content: next.content ?? "", toolCalls: next.toolCalls, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_tokens: 50 } };
  }),
}));
vi.mock("../lib/agent-model", () => ({ resolveAgentModel: () => "gpt-6-luna" }));
vi.mock("../services/conversation-history.service", () => ({
  loadRecentHistory: async () => [{ direction: "INBOUND", body: "יש לכם תיק בד?", metadata: null }],
}));
vi.mock("../services/company-context.service", () => ({ getCompanyContext: async () => ({ organizationName: "Demo Store", industry: "fashion" }) }));
vi.mock("../services/shopify-chat-turn.service", () => ({ prepareShopifyTurn: async () => null }));
vi.mock("../services/woo-chat-turn.service", () => ({
  WOO_COMPLEMENTARY_TOOL: { type: "function", function: { name: "woocommerce.complementary_products", description: "", parameters: {} } },
  prepareWebchatCommerceTurn: async () => ({
    provider: "woocommerce", productMessagingEnabled: true, suggestComplementary: false, carouselSize: 3, shown: [],
    staged: h.staged,
    sendShopifyProducts: async (a: any) => { h.staged.push({ products: a.products }); return { ok: true }; },
  }),
  webchatStorefrontBlock: async () => undefined,
  wooComplementaryProducts: vi.fn(), claimCrossSell: vi.fn(), releaseCrossSell: vi.fn(),
}));
vi.mock("../services/calendar-capability.service", () => ({ computeCalendarCapability: async () => ({ bookable: false }) }));
vi.mock("../services/schedule-handler.service", () => ({
  makeScheduleMeetingHandler: vi.fn(), makeCheckAvailabilityHandler: vi.fn(), makeRescheduleMeetingHandler: vi.fn(), makeCancelMeetingHandler: vi.fn(), resolveActiveBooking: async () => null,
}));
vi.mock("../services/connectors/custom-api.service", () => ({ executeCustomApiTool: vi.fn() }));
vi.mock("../services/connectors/integration-framework", () => ({ executeAdapterTool: vi.fn() }));
vi.mock("../services/discovery-integration.service", () => ({
  enrichProductSearchArgs: async ({ args }: any) => args,
  isComplementaryTool: () => false,
  complementaryAnchorAllowed: async () => ({ ok: true }),
  isProductSearchTool: (n: string) => n === "woocommerce.list_products",
  groundProductSearchResult: async () => ({
    provider: "woocommerce", tool: "woocommerce_product_search", status: "ok",
    candidates: [{ title: "Canvas Tote", productId: "101", price: 79, currency: "ILS", inventoryState: "in_stock", url: "u", attributes: {}, unknownAttributes: [] }],
    appliedFilters: [], unavailableFilters: [], safeModelSummary: "",
  }),
}));
vi.mock("../services/knowledge.service", () => ({ retrieveRelevantChunks: async () => [], buildKnowledgeContext: () => "" }));
vi.mock("../services/skill-runtime.service", () => ({ loadSkillContext: async () => ({ candidates: [] }), skillApprovalReason: () => null }));
vi.mock("../services/connectors/crm-adapter-resolver", () => ({ getCrmAdapter: vi.fn() }));
vi.mock("../services/crm-prefetch.service", () => ({ invalidateCrmPrefetch: vi.fn() }));
vi.mock("../services/ai-bot.service", () => ({ customToolDefinitions: async () => [], billingPauseSummary: () => "paused" }));
vi.mock("../services/tool-surface-adapters", () => ({
  buildAdapterToolSurface: async () => [
    { type: "function", function: { name: "woocommerce.list_products", description: "search", parameters: { type: "object", properties: { query: { type: "string" } } } } },
    { type: "function", function: { name: "woocommerce.create_coupon", description: "coupon", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "woocommerce.get_product", description: "one product", parameters: { type: "object", properties: { product_id: { type: "string" } } } } },
    { type: "function", function: { name: "woocommerce.delete_everything", description: "denied", parameters: { type: "object", properties: {} } } },
  ],
}));
vi.mock("../services/orchestrator", () => ({
  getActionOrchestrator: () => ({
    submit: async (p: any, exec: () => Promise<any>) => { h.submitted.push(p.tool); return { status: "completed", result: await exec(), attempts: 1 }; },
  }),
}));

import { runReplyEngineTurn } from "../services/reply-engine/engine";

const opts = { tenantId: "t1", conversationId: "c1", aiAgentId: "ag1", incomingMessage: "יש לכם תיק בד?" };
const tc = (id: string, name: string, args: any) => ({ id, function: { name, arguments: JSON.stringify(args) } });
const respond = (id: string, a: any) => tc(id, "respond", { state_update: { stage: "choosing", intent: "תיק בד", facts: {}, pending: [] }, claims: [], handoff: null, cards: [], ...a });

beforeEach(() => {
  for (const k of ["responses", "calls", "scopeSeen", "dispatched", "submitted", "upserts", "audits", "staged"] as const) (h as any)[k].length = 0;
  h.agentStatus = "ACTIVE";
  h.policy = { "woocommerce.delete_everything": "DENY" };
});

describe("one v2 turn, live", () => {
  it("offers every allowed tool sorted, grounds the search, stages the card, saves the state", async () => {
    h.responses.push(
      { toolCalls: [tc("call_1", "woocommerce.list_products", { query: "canvas tote" })] },
      { toolCalls: [respond("call_2", { reply: "יש! PRODUCT_1 ב‑₪79, מתאים לך?", cards: ["PRODUCT_1"], claims: [{ kind: "price", text: "₪79", source: "call_1" }] })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");

    const offered = h.calls[0].tools.map((t: any) => t.function.name);
    expect(offered).not.toContain("woocommerce.delete_everything");
    const tenantTools = offered.filter((n: string) => !["read_skill", "respond", "search_knowledge"].includes(n));
    expect(tenantTools).toEqual([...tenantTools].sort());
    expect(offered).toEqual(expect.arrayContaining(["respond", "search_knowledge", "woocommerce.create_coupon"]));
    // Done natively through respond (cards, handoff), so never a round of their own.
    expect(offered).not.toContain("escalate_to_human");
    expect(offered).not.toContain("send_product_card");
    // The starter library fits the cached prefix: inlined, so no read_skill round.
    expect(offered).not.toContain("read_skill");
    expect(h.calls[0].messages[0].content).toMatch(/# Playbooks/);
    expect(h.calls[0].toolChoice).toBe("required");
    expect(h.calls[0].model).toBe("gpt-6-luna");

    // The model saw a key, never the raw store payload.
    const toolMsg = h.calls[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("PRODUCT_1");
    expect(toolMsg.content).not.toContain('"id":101');

    expect(r.reply).toBe("יש! Canvas Tote ב‑₪79, מתאים לך?");
    expect(r.trace.gate3.rewrite).toBe("none");
    expect(h.submitted).toEqual(["woocommerce.list_products"]);
    expect(h.staged).toEqual([{ products: [{ productId: "101", variantId: undefined }] }]);
    expect(r.structuredMessages).toHaveLength(1);

    const saved = h.upserts[0];
    expect(saved.where.conversationId_lane).toEqual({ conversationId: "c1", lane: "live" });
    expect(saved.create.stage).toBe("choosing");
    expect(saved.create.offeredItems.map((o: any) => o.title)).toEqual(["Canvas Tote"]);
    expect(h.audits.some((a) => a.data.action === "ai.bot_turn" && a.data.metadata.engine === "v2")).toBe(true);
    expect(h.scopeSeen.every((s) => s === null)).toBe(true);
  });

  it("a respond sent beside other tools waits for their results", async () => {
    h.responses.push(
      { toolCalls: [tc("a", "woocommerce.list_products", { query: "x" }), respond("b", { reply: "early" })] },
      { toolCalls: [respond("c", { reply: "יש Canvas Tote במלאי." })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.reply).toBe("יש Canvas Tote במלאי.");
    expect(r.trace.rounds).toBe(2);
  });

  it("Gate 3: one targeted rewrite, then the safe reply with a handoff", async () => {
    h.responses.push(
      { toolCalls: [respond("r1", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("r2", { reply: "בטח, ₪150 בלבד." })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].toolChoice).toEqual({ type: "function", function: { name: "respond" } });
    expect(h.calls[1].messages.at(-1).content).toMatch(/120/);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(r.reply).not.toMatch(/₪/);
    expect(r.escalation?.reason).toMatch(/^ai_handoff:/);
  });

  it("Gate 3 fails twice on a PRODUCT turn: the turn's own products, never a handoff", async () => {
    h.responses.push(
      { toolCalls: [tc("p1", "woocommerce.list_products", { query: "tote" })] },
      { toolCalls: [respond("p2", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("p3", { reply: "בטח, ₪150 בלבד." })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(r.escalation).toBeNull();
    expect(r.reply).toBe("הנה מה שיש לנו שמתאים.");
    expect(h.staged).toEqual([{ products: [{ productId: "101", variantId: undefined }] }]);
  });

  it("a Hebrew name for an English title passes Gate 3 (eval 2026-11-16)", async () => {
    h.responses.push(
      { toolCalls: [tc("q1", "woocommerce.list_products", { query: "tote" })] },
      { toolCalls: [respond("q2", { reply: "יש תיק בד קנבס ב‑₪79, מתאים לך?", claims: [{ kind: "product", text: "תיק בד קנבס", source: "q1" }, { kind: "price", text: "₪79", source: "q1" }] })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("none");
    expect(r.escalation).toBeNull();
  });

  it("a library over the inline budget is listed: read_skill offered, an opened playbook inlined on later turns", async () => {
    process.env.REPLY_ENGINE_INLINE_SKILLS_CHARS = "0";
    const { prisma } = await import("@chatcenter/shared");
    const { starterStoreSkills } = await import("../services/starter-skills");
    const key = starterStoreSkills("woocommerce", "he")[0].key;
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", activeSkill: key, facts: {}, offeredItems: [], pending: [], turnCount: 1 });
    h.responses.push({ toolCalls: [respond("i1", { reply: "בטח, מה מספר ההזמנה?" })] });
    try {
      await runReplyEngineTurn(opts, "autonomous");
    } finally {
      (prisma as any).conversationState.findUnique = async () => null;
      delete process.env.REPLY_ENGINE_INLINE_SKILLS_CHARS;
    }
    expect(h.calls[0].tools.map((t: any) => t.function.name)).toContain("read_skill");
    expect(h.calls[0].messages[0].content).not.toMatch(/# Playbooks/);
    const turnPart = h.calls[0].messages.find((m: any, i: number) => i > 0 && m.role === "system")?.content ?? "";
    expect(turnPart).toMatch(/Playbook in use/);
    expect(turnPart).toMatch(/# Playbook:/);
  });

  it("the role skill is a line in the prefix, never a readable playbook in the list", async () => {
    h.responses.push({ toolCalls: [respond("j1", { reply: "בטח." })] });
    await runReplyEngineTurn(opts, "autonomous");
    expect(h.calls[0].messages[0].content).toMatch(/Your job:/);
    expect(h.calls[0].messages[0].content).not.toMatch(/- role_/);
  });

  it("A08: \"no info\" without reading the product -> it reads the product, then answers", async () => {
    const q = { ...opts, incomingMessage: "הסוודר מרינו מגרד?" };
    h.responses.push(
      { toolCalls: [respond("a1", { reply: "אין לי כאן מידע על זה, אפשר לבדוק מול הצוות." })] },
      { toolCalls: [tc("a2", "woocommerce.get_product", { product_id: "55" })] },
      { toolCalls: [respond("a3", { reply: "הוא בכלל מכותנה אורגנית 100%, לא מרינו, אז לא מגרד." })] },
    );
    const r = await runReplyEngineTurn(q, "autonomous");
    expect(h.calls[1].toolChoice).toBe("required");
    expect(h.dispatched.map((d) => d.name)).toContain("woocommerce.get_product");
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(r.reply).toMatch(/כותנה/);
  });

  it("a semicolon is fixed before send, not sent", async () => {
    h.responses.push({ toolCalls: [respond("s1", { reply: "יש במלאי; מתאים לך?" })] });
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.reply).toBe("יש במלאי, מתאים לך?");
  });

  it("the stable prefix carries the legacy bans for a Hebrew conversation", async () => {
    h.responses.push({ toolCalls: [respond("b1", { reply: "בטח." })] });
    await runReplyEngineTurn(opts, "autonomous");
    expect(h.calls[0].messages[0].content).toMatch(/Never write/);
    expect(h.calls[0].messages[0].content).toContain("קיבלתי את התקציב");
  });

  it("Gate 3: a rewrite that passes is sent", async () => {
    h.responses.push(
      { toolCalls: [respond("r1", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("r2", { reply: "אפשר לבדוק לך את המחיר, איזה תיק?" })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(r.reply).toBe("אפשר לבדוק לך את המחיר, איזה תיק?");
  });

  it("read_skill opens a playbook from the list", async () => {
    h.responses.push(
      { toolCalls: [tc("s1", "read_skill", { name: "role_support" })] },
      { toolCalls: [respond("s2", { reply: "בטח, מה מספר ההזמנה?" })] },
    );
    await runReplyEngineTurn(opts, "autonomous");
    const toolMsg = h.calls[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toMatch(/Skill|Playbook/);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("one v2 turn, shadow", () => {
  it("runs on the platform's credits, simulates writes, never stages cards or writes the live lane", async () => {
    h.responses.push(
      { toolCalls: [tc("w1", "woocommerce.create_coupon", { amount: 10 }), tc("w2", "woocommerce.list_products", { query: "tote" })] },
      { toolCalls: [respond("w3", { reply: "יש Canvas Tote.", cards: ["PRODUCT_1"] })] },
    );
    const r = await runReplyEngineTurn(opts, "shadow");
    expect(h.scopeSeen.every((s) => s === "reply_engine_shadow")).toBe(true);
    expect(h.submitted).toEqual([]);
    const coupon = h.dispatched.find((d) => d.name === "woocommerce.create_coupon");
    expect(coupon.sandbox).toEqual({ enabled: true, writes: "safe" });
    expect(r.trace.tools.find((t) => t.tool === "woocommerce.create_coupon")?.decision).toBe("simulated");
    expect(h.staged).toEqual([]);
    expect(h.upserts[0].where.conversationId_lane.lane).toBe("shadow");
    expect(h.audits.some((a) => a.data.action === "ai.bot_turn")).toBe(false);
    expect(r.awaitingApproval).toBeNull();
  });

  it("an approval tool is simulated, not proposed", async () => {
    h.policy["woocommerce.create_coupon"] = "REQUIRE_APPROVAL";
    h.responses.push(
      { toolCalls: [tc("w1", "woocommerce.create_coupon", { amount: 10 })] },
      { toolCalls: [respond("w2", { reply: "העברתי לאישור של הצוות." })] },
    );
    await runReplyEngineTurn(opts, "shadow");
    expect(h.dispatched).toHaveLength(0);
    expect(h.submitted).toEqual([]);
  });
});

describe("Gate 1", () => {
  it("an inactive employee never reaches the model", async () => {
    h.agentStatus = "PAUSED";
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(h.calls).toHaveLength(0);
    expect(r.reply).toBeNull();
    expect(r.escalation?.reason).toBe("agent_inactive:PAUSED");
  });
});
