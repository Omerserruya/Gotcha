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
  teamQuestions: [] as any[],
  historyQueries: [] as any[],
  failReads: 0,
}));

vi.mock("@chatcenter/shared", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    prisma: {
      aIAgent: { findUnique: async () => ({ id: "ag1", tenantId: "t1", name: "נועה", role: "customer_support", status: h.agentStatus, model: "gpt-6-luna", persona: { gender: "female" }, escalationMessage: "x" }) },
      conversation: { findFirst: async () => ({ id: "c1", tenantId: "t1", channel: "WEBCHAT", customerExternalId: "v1" }) },
      contact: { findFirst: async () => null },
      message: { findMany: async (a: any) => { h.historyQueries.push(a); return [{ direction: "INBOUND", body: "יש לכם תיק בד?", metadata: null }]; } },
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
    recordUnansweredQuestion: async (q: any) => { h.teamQuestions.push(q); },
    buildAgentToolsForAIAgent: async () => [
      { type: "function", function: { name: "escalate_to_human", description: "hand over", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "send_product_card", description: "card", parameters: { type: "object", properties: {} } } },
    ],
    evaluatePolicies: async ({ toolName }: any) => ({ decision: h.policy[toolName] ?? "ALLOW", reason: "test" }),
    dispatchToolCall: async (tc: any, ctx: any) => {
      h.dispatched.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments), sandbox: ctx.sandbox ?? null });
      if (tc.function.name === "woocommerce.list_products" && h.failReads > 0) { h.failReads--; return { toolCallId: tc.id, content: JSON.stringify({ ok: false, failure: "errored", reason: "woocommerce_500" }) }; }
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
vi.mock("../services/knowledge.service", () => ({ retrieveRelevantChunks: async () => [], buildKnowledgeContext: () => "", shouldRecordKnowledgeGap: () => false }));
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
  for (const k of ["responses", "calls", "scopeSeen", "dispatched", "submitted", "upserts", "audits", "staged", "teamQuestions", "historyQueries"] as const) (h as any)[k].length = 0;
  h.failReads = 0;
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

  it("Gate 3: one targeted rewrite, then the safe reply; nothing asked for a person, so a team question, not a handoff", async () => {
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
    expect(r.escalation).toBeNull();
    expect(h.teamQuestions).toHaveLength(1);
  });

  it("the safe reply still hands over when the customer asked for a person", async () => {
    const q = { ...opts, incomingMessage: "אני רוצה לדבר עם נציג" };
    h.responses.push(
      { toolCalls: [respond("r1", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("r2", { reply: "בטח, ₪150 בלבד." })] },
    );
    const r = await runReplyEngineTurn(q, "autonomous");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:/);
  });

  it("a handoff nobody asked for is rewritten into an answer plus a team question (eval: discount, instalments)", async () => {
    const q = { ...opts, incomingMessage: "אפשר לשלם בתשלומים?" };
    h.responses.push(
      { toolCalls: [respond("h1", { reply: "מעבירים אותך לנציג שימשיך מכאן.", handoff: "instalments question" })] },
      { toolCalls: [respond("h2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "האם אפשר לשלם בתשלומים?" })] },
    );
    const r = await runReplyEngineTurn(q, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("needless_handoff");
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(r.escalation).toBeNull();
    expect(h.teamQuestions[0]).toMatchObject({ question: "האם אפשר לשלם בתשלומים?", askerKey: "c1" });
    const saved = h.upserts[0].create;
    expect(saved.pending.map((p: any) => p.kind)).toContain("promise");
  });

  it("a failed store read is retried once and logged with its outcome", async () => {
    h.failReads = 1;
    h.responses.push(
      { toolCalls: [tc("f1", "woocommerce.list_products", { query: "tote" })] },
      { toolCalls: [respond("f2", { reply: "יש Canvas Tote במלאי." })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    const rec = r.trace.tools.find((t: any) => t.tool === "woocommerce.list_products");
    expect(rec).toMatchObject({ retried: true, outcome: "ok", resultCount: 1 });
    const audit = h.audits.find((a) => a.data.action === "ai.bot_turn");
    expect(audit.data.metadata.toolCalls[0]).toMatchObject({ tool: "woocommerce.list_products", outcome: "ok", resultCount: 1, retried: true });
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

describe("the model", () => {
  it("REPLY_ENGINE_MODEL sets v2's model without touching the platform default", async () => {
    process.env.REPLY_ENGINE_MODEL = "gpt-6-luna-test";
    h.responses.push({ toolCalls: [respond("m1", { reply: "בטח." })] });
    try { await runReplyEngineTurn(opts, "autonomous"); } finally { delete process.env.REPLY_ENGINE_MODEL; }
    expect(h.calls[0].model).toBe("gpt-6-luna-test");
  });
});

describe("one v2 turn, replay (scripts/replay-v2.ts)", () => {
  it("history is cut at the replayed message; platform-paid; nothing written but its own lane", async () => {
    const asOf = new Date("2026-11-10T10:00:00Z");
    h.policy["woocommerce.create_coupon"] = "ALLOW";
    h.responses.push(
      { toolCalls: [tc("x1", "woocommerce.create_coupon", { amount: 10 }), tc("x2", "woocommerce.list_products", { query: "tote" })] },
      { toolCalls: [respond("x3", { reply: "יש Canvas Tote.", cards: ["PRODUCT_1"], team_question: "יש הנחה?" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, replay: { asOf, messageId: "m9" } }, "autonomous");
    expect(h.historyQueries[0].where.createdAt).toEqual({ lte: asOf });
    expect(h.scopeSeen.every((s) => s === "reply_engine_replay")).toBe(true);
    expect(h.calls[0].metadata.type).toBe("ai_bot_replay");
    expect(h.submitted).toEqual([]);
    expect(h.dispatched.find((d) => d.name === "woocommerce.create_coupon").sandbox).toEqual({ enabled: true, writes: "safe" });
    expect(h.staged).toEqual([]);
    expect(h.teamQuestions).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.upserts[0].where.conversationId_lane.lane).toBe("replay");
    expect(r.trace.teamQuestion).toBe("יש הנחה?");
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

describe("prod replay 2026-11-16 defects, through a whole turn", () => {
  const OPEN = { kind: "promise", text: "checking with the team: הלקוח מדווח שהכיסא הגיע פגום וחסר בורג", at: new Date().toISOString() };
  const withOpenTeamQuestion = async (fn: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [OPEN], turnCount: 3 });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };

  it("★ the same team question on a later turn is NOT recorded again, and the open one stays", async () => {
    await withOpenTeamQuestion(async () => {
      h.responses.push({ toolCalls: [respond("t1", { reply: "אנחנו פתוחים בימים א עד ה.", team_question: "הכיסא הגיע פגום וחסר בורג, הלקוח מחכה" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה שעות הפתיחה?" }, "autonomous");
      expect(h.teamQuestions).toEqual([]);
      expect(r.trace.teamQuestion).toBeNull();
      expect(r.trace.teamQuestionRepeat).toBe(true);
      const saved = h.upserts[0].create;
      expect(saved.pending.filter((p: any) => String(p.text).startsWith("checking with the team: "))).toHaveLength(1);
    });
  });

  it("★ saying again \"I passed it to the team\" is rewritten into an answer to the new message", async () => {
    await withOpenTeamQuestion(async () => {
      h.responses.push(
        { toolCalls: [respond("t2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט." })] },
        { toolCalls: [respond("t3", { reply: "אנחנו פתוחים בימים א עד ה." })] },
      );
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה שעות הפתיחה?" }, "autonomous");
      expect((r.trace.gate3.problems.find((p: any) => p.kind === "style") as any)?.codes).toContain("repeated_team_line");
      expect(r.trace.gate3.rewrite).toBe("rewritten");
      expect(r.reply).toBe("אנחנו פתוחים בימים א עד ה.");
    });
  });

  it("a NEW, different question still goes to the team while another is open", async () => {
    await withOpenTeamQuestion(async () => {
      h.responses.push({ toolCalls: [respond("t4", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "האם אפשר לשלם בתשלומים?" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
      expect(h.teamQuestions).toHaveLength(1);
      expect(r.trace.teamQuestion).toBe("האם אפשר לשלם בתשלומים?");
      expect(r.trace.gate3.rewrite).toBe("none");
    });
  });

  it("★ a damaged delivery in the customer's words keeps its handoff (no needless_handoff rewrite)", async () => {
    h.responses.push({ toolCalls: [respond("d1", { reply: "מצטערים מאוד לשמוע. מישהו מהצוות ימשיך איתך כאן כדי לסדר את זה.", handoff: "damaged delivery" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "הכיסא הגיע והרגליים לא מחוברות, וגם חסר בורג" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).not.toContain("needless_handoff");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:damaged delivery/);
  });

  it("★ replay: a simulated write reaches the model as a live result, never a simulation note", async () => {
    h.policy["woocommerce.create_coupon"] = "ALLOW";
    h.responses.push(
      { toolCalls: [tc("s1", "woocommerce.create_coupon", { amount: 10 })] },
      { toolCalls: [respond("s2", { reply: "שלחתי לך קופון של 10%." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, replay: { asOf: new Date(), messageId: "m1" } }, "autonomous");
    const toolMsg = h.calls[1].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "s1");
    expect(toolMsg.content).not.toMatch(/simulat|sandbox|test/i);
    // Judged as live would judge it: the coupon is "done", so the reply is not an unsupported claim.
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).not.toContain("unsupported_action");
    expect(r.trace.tools.find((t: any) => t.tool === "woocommerce.create_coupon")?.decision).toBe("simulated");
  });
});
