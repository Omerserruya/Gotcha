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
  slowReads: 0,
  history: null as any[] | null,
  lexical: [] as any[],
  groundTitle: "Canvas Tote",
  docAddress: null as string | null,
  groundStatus: "ok" as string,
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
      if (tc.function.name === "woocommerce.list_products" && h.slowReads > 0) { h.slowReads--; await new Promise((r) => setTimeout(r, 900)); }
      if (tc.function.name === "woocommerce.list_products" && h.failReads > 0) { h.failReads--; return { toolCallId: tc.id, content: JSON.stringify({ ok: false, failure: "errored", reason: "woocommerce_500" }) }; }
      if (tc.function.name === "woocommerce.get_product" && JSON.parse(tc.function.arguments).product_id === "denied") return { toolCallId: tc.id, content: JSON.stringify({ ok: false, failure: "refused", reason: "access_denied_cross_customer: this chat may only access the customer's own records." }) };
      if (tc.function.name === "woocommerce.list_products") return { toolCallId: tc.id, content: JSON.stringify({ ok: true, result: [{ id: 101, name: "Canvas Tote", price: "79" }] }) };
      // A product read returns its text (the number rule needs the "100%" a reply may quote).
      if (tc.function.name === "woocommerce.get_product" && JSON.parse(tc.function.arguments).product_id === "55") return { toolCallId: tc.id, content: JSON.stringify({ ok: true, result: { id: 55, name: "סוודר", description: "100% כותנה אורגנית" } }) };
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
vi.mock("../services/conversation-history.service", async (orig) => ({
  ...(await orig<any>()),
  loadRecentHistory: async () => h.history ?? [{ direction: "INBOUND", body: "יש לכם תיק בד?", metadata: null }],
}));
vi.mock("../services/company-context.service", () => ({ getCompanyContext: async () => ({ organizationName: "Demo Store", industry: "fashion" }) }));
vi.mock("../services/shopify-chat-turn.service", () => ({ prepareShopifyTurn: async () => null }));
vi.mock("../services/woo-chat-turn.service", async (orig) => ({
  ...(await orig<any>()),
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
vi.mock("../services/connectors/integration-framework", () => ({ executeAdapterTool: vi.fn(), registerAdapter: vi.fn() }));
vi.mock("../services/discovery-integration.service", () => ({
  enrichProductSearchArgs: async ({ args }: any) => args,
  isComplementaryTool: () => false,
  complementaryAnchorAllowed: async () => ({ ok: true }),
  isProductSearchTool: (n: string) => n === "woocommerce.list_products",
  groundProductSearchResult: async () => ({
    provider: "woocommerce", tool: "woocommerce_product_search", status: h.groundStatus,
    candidates: [{ title: h.groundTitle, productId: "101", price: 79, currency: "ILS", inventoryState: "in_stock", url: "u", attributes: {}, unknownAttributes: [] }],
    appliedFilters: [], unavailableFilters: [], safeModelSummary: h.groundTitle,
  }),
}));
vi.mock("../services/knowledge.service", () => ({
  retrieveRelevantChunks: async () => [], buildKnowledgeContext: (c: any[]) => c.map((x) => x.content).join("\n"), shouldRecordKnowledgeGap: () => false,
  lexicalKnowledge: async () => h.lexical, mergeKnowledge: (v: any[], l: any[]) => [...v, ...l],
  knowledgeLimit: () => 5, documentAddress: async () => h.docAddress,
}));
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
  h.slowReads = 0;
  h.history = null;
  h.lexical = [];
  h.groundTitle = "Canvas Tote";
  h.docAddress = null;
  h.groundStatus = "ok";
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

    // U+2011 (a non-breaking hyphen) goes out as a plain "-" (prod replay 6).
    expect(r.reply).toBe("יש! Canvas Tote ב-₪79, מתאים לך?");
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
    // Nothing of either draft survives: ONE more targeted rewrite is tried (prod replay 9), then the fallback.
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1].toolChoice).toEqual({ type: "function", function: { name: "respond" } });
    expect(h.calls[2].messages.find((m: any) => m.role === "system" && /could not be sent as written/.test(m.content))?.content).toMatch(/Write the full answer/);
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
    // Not a product ask (that one now searches first, prod replay 8).
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה לגבי המחיר?" }, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(r.reply).toBe("אפשר לבדוק לך את המחיר, איזה תיק?");
  });

  it("read_skill opens a playbook from the list", async () => {
    h.responses.push(
      { toolCalls: [tc("s1", "read_skill", { name: "role_support" })] },
      { toolCalls: [respond("s2", { reply: "בטח, מה מספר ההזמנה?" })] },
    );
    await runReplyEngineTurn({ ...opts, incomingMessage: "איפה ההזמנה שלי?" }, "autonomous");
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

describe("prod replay 2 (2026-11-16): a canned team line never replaces a real answer", () => {
  const withState = async (row: any, fn: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [], turnCount: 3, ...row });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };

  it("★ style only, twice: the rewrite is cleaned and sent, no fallback, no team question", async () => {
    h.responses.push(
      { toolCalls: [respond("y1", { reply: "מצאתי תיק בד, מתאים לך?" })] },
      { toolCalls: [respond("y2", { reply: "מצאתי כמה תיקי בד, איזה צבע מתאים לך?" })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("cleaned");
    expect(r.reply).toBe("יש כמה תיקי בד, איזה צבע מתאים לך?");
    expect(h.teamQuestions).toEqual([]);
    expect(r.escalation).toBeNull();
  });

  it("★ the rewrite has a FACT problem but the original only style: the original goes out, cleaned", async () => {
    h.responses.push(
      { toolCalls: [respond("y3", { reply: "מצאתי תיק בד, מתאים לך?" })] },
      { toolCalls: [respond("y4", { reply: "יש תיק בד ב-₪150." })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("cleaned");
    expect(r.reply).toBe("יש תיק בד, מתאים לך?");
  });

  it("★ a needless handoff, twice: sent without the handoff, never the canned line", async () => {
    h.responses.push(
      { toolCalls: [respond("n1", { reply: "אפשר לשלם בתשלומים בקופה באתר.", handoff: "instalments" })] },
      { toolCalls: [respond("n2", { reply: "אפשר לשלם בתשלומים בקופה באתר.", handoff: "instalments" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("cleaned");
    expect(r.escalation).toBeNull();
    expect(r.reply).toBe("אפשר לשלם בתשלומים בקופה באתר.");
  });

  it("★ unread product: the rewrite round reads the product (one tool round), then answers; two model calls at most", async () => {
    h.responses.push(
      { toolCalls: [respond("u1", { reply: "אין לי כאן מידע על זה, אבדוק מול הצוות." })] },
      { toolCalls: [tc("u3", "woocommerce.get_product", { product_id: "55" })] },
      { toolCalls: [respond("u4", { reply: "הוא מכותנה אורגנית, נעים ולא מגרד." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "הסוודר מגרד?" }, "autonomous");
    expect(h.calls.map((c) => c.toolChoice)).toEqual(["required", "required", { type: "function", function: { name: "respond" } }]);
    expect(h.dispatched.map((d) => d.name)).toContain("woocommerce.get_product");
    expect((r.trace as any).rewriteRounds).toBe(2);
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(r.reply).toMatch(/כותנה/);
  });

  it("★ the rewrite never takes more than two model calls (prod replay 5: p95 17s)", async () => {
    h.responses.push(
      { toolCalls: [respond("v1", { reply: "אין לי כאן מידע על זה, אבדוק מול הצוות." })] },
      { toolCalls: [respond("v2", { reply: "אין לי מידע על זה." })] },
      { toolCalls: [respond("v3", { reply: "never asked for" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "הסוודר מגרד?" }, "autonomous");
    expect(h.calls).toHaveLength(2);
    expect((r.trace as any).rewriteRounds).toBe(1);
    expect(r.reply).not.toBe("never asked for");
  });
;

  it("★ the canned line goes out once: it is marked in the state (hidden from the model)", async () => {
    h.responses.push(
      { toolCalls: [respond("c1", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("c2", { reply: "בטח, ₪150 בלבד." })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(r.reply).toBe("העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.");
    expect(h.upserts[0].create.facts._cannedTeamLineAt).toBeTruthy();
  });

  it("★ the canned line already went out: nothing is sent, the question still reaches the team once", async () => {
    await withState({ facts: { _cannedTeamLineAt: new Date().toISOString() } }, async () => {
      h.responses.push(
        { toolCalls: [respond("c3", { reply: "התיק עולה ₪120." })] },
        { toolCalls: [respond("c4", { reply: "בטח, ₪150 בלבד." })] },
      );
      const r = await runReplyEngineTurn(opts, "autonomous");
      expect(r.trace.gate3.rewrite).toBe("silent");
      expect(r.reply).toBeNull();
      expect(r.escalation).toBeNull();
      expect(h.teamQuestions).toHaveLength(1);
      // The engine's mark is not shown to the model.
      expect(JSON.stringify(h.calls[0].messages)).not.toContain("_cannedTeamLineAt");
    });
  });

  it("★ a person is needed after the canned line went out: the handoff happens, no second canned line", async () => {
    await withState({ facts: { _cannedTeamLineAt: new Date().toISOString() } }, async () => {
      h.responses.push(
        { toolCalls: [respond("c5", { reply: "התיק עולה ₪120." })] },
        { toolCalls: [respond("c6", { reply: "בטח, ₪150 בלבד." })] },
      );
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני רוצה לדבר עם נציג" }, "autonomous");
      expect(r.reply).toBeNull();
      expect(r.escalation?.reason).toMatch(/^ai_handoff:/);
    });
  });

  it("★ an order lookup refused as another customer's: the model is told to ask for the order number", async () => {
    h.responses.push(
      { toolCalls: [tc("o1", "woocommerce.get_product", { product_id: "denied" })] },
      { toolCalls: [respond("o2", { reply: "מה מספר ההזמנה?" })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    const toolMsg = h.calls[1].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "o1");
    expect(toolMsg.content).toMatch(/ask for it/);
    expect(toolMsg.content).toMatch(/do not retry with a phone number or an email/);
    expect(r.trace.tools[0]).toMatchObject({ outcome: "error", errorKind: "access_denied_cross_customer" });
  });
});

describe("prod replay 3 (2026-11-16), through a whole turn", () => {
  it("★ a store search times out: the model is told to search narrower, never to say it could not check; a give-up reply gets that search", async () => {
    process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS = "500";
    h.slowReads = 1;
    h.responses.push(
      { toolCalls: [tc("w1", "woocommerce.list_products", { query: "תיקי בד לחוף" })] },
      { toolCalls: [respond("w2", { reply: "לא הצלחתי לבדוק את זה כרגע." })] },
      { toolCalls: [respond("w4", { reply: "יש לנו תיק בד קנבס, לאיזה שימוש?" })] },
    );
    let r: any;
    try { r = await runReplyEngineTurn(opts, "autonomous"); } finally { delete process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS; }
    const note = h.calls[1].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "w1")?.content;
    expect(note).toMatch(/narrower query/);
    expect(note).not.toMatch(/say you could not check/);
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("gave_up_search");
    // The engine searched again itself, narrower, and the model answered in ONE more call.
    expect(h.dispatched.filter((d) => d.name === "woocommerce.list_products").map((d) => d.args.query)).toEqual(["תיקי בד לחוף", "תיקי בד"]);
    expect(h.calls[2].toolChoice).toEqual({ type: "function", function: { name: "respond" } });
    expect(h.calls).toHaveLength(3);
    expect(r.trace.tools.map((t: any) => t.outcome)).toEqual(["timeout", "ok"]);
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(r.reply).toBe("יש לנו תיק בד קנבס, לאיזה שימוש?");
  });

  it("★ \"the address is not available\" without searching: search_knowledge runs, the answer comes from it", async () => {
    h.responses.push(
      { toolCalls: [respond("k1", { reply: "הכתובת המדויקת לא זמינה כרגע." })] },
      { toolCalls: [respond("k3", { reply: "הסטודיו ברחוב הרצל 5 בתל אביב." })] },
    );
    // The vector search misses it; the keyword fallback finds the chunk that says it.
    h.lexical = [{ content: "איסוף עצמי מהסטודיו ברחוב הרצל 5 בתל אביב", score: 0.33, documentTitle: "משלוחים", chunkIndex: 0 }];
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה הסטודיו?" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("unread_knowledge");
    expect(r.trace.tools.map((t: any) => t.tool)).toContain("search_knowledge");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "auto_knowledge_1")?.content).toMatch(/הרצל 5/);
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(r.reply).toBe("הסטודיו ברחוב הרצל 5 בתל אביב.");
  });

  it("★ a cleanup that leaves a word or two for a question is not sent as the answer", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const OPEN = { kind: "promise", text: "checking with the team: הכיסא הגיע פגום", at: new Date().toISOString() };
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [OPEN], turnCount: 3 });
    h.responses.push(
      { toolCalls: [respond("x1", { reply: "העברתי את השאלה לצוות. תודה!" })] },
      { toolCalls: [respond("x2", { reply: "העברתי את השאלה לצוות. בשמחה!" })] },
    );
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "ויש לכם גם בצבע שחור?" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect(r.trace.gate3.rewrite).not.toBe("cleaned");
    expect(r.reply).not.toBe("בשמחה!");
    expect(r.reply).not.toBe("תודה!");
  });
});

describe("prod replay 4 (2026-11-16), through a whole turn", () => {
  it("★ the model reads a person's reply as a person's, not its own", async () => {
    h.history = [
      { direction: "INBOUND", body: "יש לכם משטח במבוק?", metadata: null },
      { direction: "OUTBOUND", body: "כן, יש בהיר וכהה.", senderName: "dana@shop.co.il", metadata: null },
      { direction: "INBOUND", body: "יש לכם תיק בד?", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("p1", { reply: "בטח, לאיזה שימוש?" })] });
    await runReplyEngineTurn(opts, "autonomous");
    const sent = JSON.stringify(h.calls[0].messages);
    expect(sent).toContain("[Human team member Dana, not you, wrote to the customer]: כן, יש בהיר וכהה.");
    expect(h.calls[0].messages.filter((m: any) => m.role === "assistant" && /בהיר וכהה/.test(m.content))).toHaveLength(0);
    // The customer's latest message is not sent twice.
    expect(h.calls[0].messages.filter((m: any) => m.content === "יש לכם תיק בד?")).toHaveLength(1);
  });

  it("★ \"we don't sell it\" with no search: the search runs before the answer", async () => {
    h.responses.push(
      { toolCalls: [respond("b1", { reply: "משטחי במבוק אנחנו לא מוכרים." })] },
      { toolCalls: [respond("b3", { reply: "יש לנו תיק בד קנבס, לאיזה שימוש?" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש משטחי במבוק?" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("ungrounded_absence");
    // The engine searched the customer's own words itself; one model call for the answer.
    expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toBe("יש משטחי במבוק?");
    expect(h.calls).toHaveLength(2);
    expect(r.trace.gate3.rewrite).toBe("rewritten");
  });

  it("★ an absence claim the search contradicts is never sent: its sentence goes, else the products found", async () => {
    h.groundTitle = "משטח במבוק כהה";
    h.responses.push(
      { toolCalls: [respond("b4", { reply: "משטחי במבוק אנחנו לא מוכרים." })] },
      { toolCalls: [respond("b5", { reply: "במבוק אנחנו לא מוכרים, מצטערים." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש משטחי במבוק?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/לא מוכרים/);
    // Nothing else was in the reply: the products the search returned, not a canned line.
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(r.reply).toBe("הנה מה שיש לנו שמתאים.");
  });
});

describe("prod replay 5 (2026-11-16), through a whole turn", () => {
  it("★ an absence sentence the search contradicts is cut; a remnant that no longer answers gets ONE targeted rewrite (prod replay 9)", async () => {
    h.groundTitle = "משטח במבוק כהה";
    h.responses.push(
      { toolCalls: [respond("f1", { reply: "יש לנו משטחים בכמה גדלים. במבוק אנחנו לא מוכרים." })] },
      { toolCalls: [respond("f2", { reply: "יש לנו משטחים בכמה גדלים. במבוק אנחנו לא מוכרים." })] },
      { toolCalls: [respond("f3", { reply: "כן, יש לנו משטח במבוק כהה, ואפשר לראות אותו כאן." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש משטחי במבוק?" }, "autonomous");
    const note = h.calls[2].messages.find((m: any) => m.role === "system" && /could not be sent as written/.test(m.content))?.content ?? "";
    expect(note).toMatch(/במבוק אנחנו לא מוכרים/);
    expect(note).toMatch(/יש משטחי במבוק\?/);
    expect((r.trace as any).rewrite2).toBe(true);
    expect(r.trace.gate3.rewrite).toBe("cleaned");
    expect(r.reply).toBe("כן, יש לנו משטח במבוק כהה, ואפשר לראות אותו כאן.");
  });

  it("★ the targeted rewrite fails too: the original minus only its offending sentence", async () => {
    h.responses.push(
      { toolCalls: [respond("g1", { reply: "ההכוונה הקודמת לא הייתה נכונה, מצטערים. נעדכן אותך ברגע שההחזרה תגיע אלינו למחסן ונבדוק אותה." })] },
      { toolCalls: [respond("g2", { reply: "נעדכן אותך כשזה יגיע." })] },
      { toolCalls: [respond("g3", { reply: "נעדכן אותך." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "שלחתי את ההחזרה אתמול" }, "autonomous");
    expect(h.calls).toHaveLength(3);
    expect(r.trace.gate3.rewrite).toBe("cleaned_partial");
    expect(r.reply).toBe("ההכוונה הקודמת לא הייתה נכונה, מצטערים.");
  });
;

  it("★ \"yes\" to its own offer of a person: the handoff happens even if the rewrite forgets it", async () => {
    h.history = [
      { direction: "INBOUND", body: "חייבו אותי פעמיים ואין הזמנה", metadata: null },
      { direction: "OUTBOUND", body: "מצטערים לשמוע. זה דחוף? אם כן אעביר לנציג שימשיך כאן.", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "כן", metadata: null },
    ];
    h.responses.push(
      { toolCalls: [respond("y1", { reply: "בסדר, מה עוד אפשר לבדוק?" })] },
      { toolCalls: [respond("y2", { reply: "בסדר, מה עוד אפשר לבדוק?" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("ignored_yes");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:the customer accepted/);
  });

  it("★ the business address from the profile is in the prompt", async () => {
    const cc = await import("../services/company-context.service");
    const spy = vi.spyOn(cc, "getCompanyContext").mockResolvedValue({ organizationName: "Tehila", address: "הרצל 5, נהריה" } as any);
    h.responses.push({ toolCalls: [respond("a1", { reply: "בטח." })] });
    try { await runReplyEngineTurn(opts, "autonomous"); } finally { spy.mockRestore(); }
    expect(h.calls[0].messages[0].content).toContain("Address: הרצל 5, נהריה");
  });
});

describe("prod replay 6 (2026-11-16), through a whole turn", () => {
  it("★ \"a person will continue\" with no handoff: the handoff is set in code", async () => {
    h.responses.push({ toolCalls: [respond("p1", { reply: "נציג מהצוות ימשיך איתך כאן." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אוקיי" }, "autonomous");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:the reply says a person will continue/);
    expect((r.trace as any).handoffSetInCode).toBe(true);
  });

  it("★ a yes to its own offer answered with the canned team line: a handoff, and a handoff's words", async () => {
    h.history = [
      { direction: "INBOUND", body: "חייבו אותי פעמיים", metadata: null },
      { direction: "OUTBOUND", body: "זה דחוף? אם כן אעביר לנציג שימשיך כאן.", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "כן", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("q1", { reply: "זה כבר אצל הצוות, והתשובה תגיע כאן בצ'אט.", team_question: "חיוב כפול" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן" }, "autonomous");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:the customer accepted/);
    expect(r.reply).toBe("מעבירים לנציג מהצוות שימשיך איתך כאן.");
  });

  it("★ the same paragraph twice: rewritten, else nothing is sent", async () => {
    const para = "כדי לבדוק את ההזמנה צריך את מספר ההזמנה, והטלפון ששמור עליה לא תואם למספר שממנו כותבים.";
    h.history = [
      { direction: "INBOUND", body: "איפה ההזמנה?", metadata: null },
      { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "נו?", metadata: null },
    ];
    h.responses.push(
      { toolCalls: [respond("d1", { reply: para })] },
      { toolCalls: [respond("d2", { reply: para })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "נו?" }, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("silent");
    expect(r.reply).toBeNull();
  });

  it("★ the rewrite respects the turn budget: none when the turn is already late", async () => {
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "5000";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    h.responses.push({ toolCalls: [respond("l1", { reply: "מצאתי תיק בד, מתאים לך?" })] });
    const { generateResponse } = await import("../services/ai.service");
    const orig = (generateResponse as any).getMockImplementation();
    (generateResponse as any).mockImplementationOnce(async (p: any) => { const out = await orig(p); shift = 4500; return out; });
    let r: any;
    try { r = await runReplyEngineTurn(opts, "autonomous"); } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    expect(h.calls).toHaveLength(1);
    expect(r.trace.rewriteCut).toBe("budget");
    expect(r.trace.gate3.rewrite).toBe("cleaned");
    expect(r.reply).toBe("יש תיק בד, מתאים לך?");
  });
});

describe("prod replay 7 (2026-11-17), through a whole turn", () => {
  it("★ a yes to its own offer: THE handoff line, whatever the model wrote", async () => {
    h.history = [
      { direction: "INBOUND", body: "הקופון לא עובד", metadata: null },
      { direction: "OUTBOUND", body: "מצטערים. רוצה שאעביר לנציג שיבדוק?", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "כן", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("y1", { reply: "את הקופון מזינים בעמוד התשלום, בשדה קוד קופון." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן" }, "autonomous");
    expect(r.reply).toBe("מעבירים לנציג מהצוות שימשיך איתך כאן.");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:/);
  });

  it("★ \"no information\" on an open complaint: the question goes to the team, and the reply says so", async () => {
    h.responses.push({ toolCalls: [respond("e1", { reply: "מצטערים, אין לי מידע על זה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ההזמנה עדיין לא הגיעה, כבר שבועיים" }, "autonomous");
    expect((r.trace as any).deadEndToTeam).toBe(true);
    expect(h.teamQuestions).toHaveLength(1);
    expect(r.reply).toMatch(/העברתי את זה לצוות/);
  });
});

describe("prod replay 8 (2026-11-17), through a whole turn", () => {
  it("★ a call request the reply ignores: recorded for the team, and the reply says so", async () => {
    h.responses.push({ toolCalls: [respond("c1", { reply: "בשמחה לעזור כאן בצ'אט." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יכול להתקשר אלי?" }, "autonomous");
    expect((r.trace as any).callToTeam).toBe(true);
    expect(h.teamQuestions[0].question).toMatch(/^call request:/);
    expect(r.reply).toMatch(/הבקשה לשיחה/);
  });
});

describe("prod replay 8: a failed store search", () => {
  it("★ the model is told to search narrower, never to say the catalogue failed or to hand over", async () => {
    h.groundStatus = "error";
    h.responses.push(
      { toolCalls: [tc("x1", "woocommerce.list_products", { query: "משטח" })] },
      { toolCalls: [respond("x2", { reply: "איזה גודל מחפשים?" })] },
    );
    await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לראות משטחים?" }, "autonomous");
    const note = h.calls[1].messages.find((m: any) => m.role === "tool" && m.tool_call_id === "x1")?.content;
    expect(note).toMatch(/^PRODUCT_SEARCH_FAILED: /);
    expect(note).toMatch(/narrower query/);
    expect(note).not.toMatch(/offer a human handoff|can't check the catalog/);
  });
});

describe("prod replay 9 (2026-11-17), through a whole turn", () => {
  it("★ a safety complaint never ends without a person: the handoff is set in code, the answer kept", async () => {
    h.history = [
      { direction: "INBOUND", body: "המכשיר מתהפך על המשטח, זה מסוכן", metadata: null },
      { direction: "OUTBOUND", body: "מצטערים מאוד. מה גודל המכשיר?", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "30 על 40", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("s1", { reply: "תודה על הפרטים, זה עוזר להבין." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "30 על 40" }, "autonomous");
    expect((r.trace as any).safetyHandoff).toBe(true);
    expect(r.escalation?.reason).toMatch(/^ai_handoff:safety/);
    // Replay 13: the stop-use line only when the customer's own message describes the issue ("30 על 40" does not).
    expect(r.reply).toBe("תודה על הפרטים, זה עוזר להבין. מעבירים לנציג מהצוות שימשיך איתך כאן.");
  });

  it("★ \"already with the team\" for another subject: this ask is recorded as a new team question", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const OPEN = { kind: "promise", text: "checking with the team: הקופון WELCOME10 לא עובד בתשלום", at: new Date().toISOString() };
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [OPEN], turnCount: 3 });
    h.responses.push({ toolCalls: [respond("t1", { reply: "זה כבר אצל הצוות, והתשובה תגיע כאן בצ'אט." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "ויש את התיק בצבע ירוק זית?" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect((r.trace as any).newSubjectToTeam).toBe(true);
    expect(h.teamQuestions.map((q) => q.question)).toEqual(["ויש את התיק בצבע ירוק זית?"]);
    expect(r.reply).toBe("העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.");
  });
});

describe("prod replay 11: the whole turn answers inside the budget", () => {
  it("★ with little time left after a round, the next call must answer", async () => {
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "5000";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const { generateResponse } = await import("../services/ai.service");
    const orig = (generateResponse as any).getMockImplementation();
    (generateResponse as any).mockImplementationOnce(async (p: any) => { const out = await orig(p); shift = 2000; return out; });
    h.responses.push(
      { toolCalls: [tc("b1", "woocommerce.list_products", { query: "תיק" })] },
      { toolCalls: [respond("b2", { reply: "יש תיק בד קנבס, לאיזה שימוש?" })] },
    );
    let r: any;
    try { r = await runReplyEngineTurn(opts, "autonomous"); } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    expect(h.calls[1].toolChoice).toEqual({ type: "function", function: { name: "respond" } });
    expect(r.trace.roundsCut).toBe(1);
  });
});

describe("prod replay 11 rating: safety sticks", () => {
  it("★ once seen, a safety conversation stays one (the fact is saved; a later turn without the words still hands over)", async () => {
    const { prisma } = await import("@chatcenter/shared");
    h.responses.push({ toolCalls: [respond("z1", { reply: "מבינים, נבדוק." })] });
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _safetyAt: new Date().toISOString() }, offeredItems: [], pending: [], turnCount: 5 });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה עם המעצור?" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect(r.trace.safetyHandoff).toBe(true);
    // "ומה עם המעצור?" names a part but describes nothing: the handoff, not the stop-use line (replay 13).
    expect(r.reply).not.toMatch(/להפסיק להשתמש/);
  });
  it("★ the customer describes the issue: the stop-use line, once, and not again on the next reply", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _safetyAt: new Date().toISOString() }, offeredItems: [], pending: [], turnCount: 5 });
    h.responses.push({ toolCalls: [respond("z3", { reply: "מבינים, מצטערים." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "המעצור לא מונע את זה" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect((r.reply.match(/להפסיק להשתמש/g) ?? [])).toHaveLength(1);
    // The previous reply already had it: not again.
    h.history = [
      { direction: "INBOUND", body: "המכשיר מתהפך", metadata: null },
      { direction: "OUTBOUND", body: "מצטערים. עד שנציג מהצוות יבדוק, מומלץ להפסיק להשתמש בזה.", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "המעצור לא מונע את זה", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("z4", { reply: "מבינים." })] });
    const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: "המעצור לא מונע את זה" }, "autonomous");
    expect(r2.reply).not.toMatch(/להפסיק להשתמש/);
  });
  it("★ the first sight of a safety word saves the fact", async () => {
    h.responses.push({ toolCalls: [respond("z2", { reply: "מצטערים לשמוע, מעבירים לנציג מהצוות שימשיך איתך כאן.", handoff: "tipping" })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "המכשיר נהפך על המשטח" }, "autonomous");
    expect(h.upserts[0].create.facts._safetyAt).toBeTruthy();
  });
});

describe("prod replay 12: placeholders and the stop-use line", () => {
  it("★ a template placeholder at the start: a short neutral opener, no model call", async () => {
    h.history = [{ direction: "INBOUND", body: "[template attachment]", metadata: null }];
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "[template attachment]" }, "autonomous");
    expect(h.calls).toHaveLength(0);
    expect(r.reply).toBe("היי, במה אפשר לעזור?");
  });
  it("★ a placeholder later in the conversation: nothing", async () => {
    h.history = [
      { direction: "INBOUND", body: "היי", metadata: null },
      { direction: "OUTBOUND", body: "היי! במה אפשר לעזור?", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "[Unsupported message]", metadata: null },
    ];
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "[Unsupported message]" }, "autonomous");
    expect(h.calls).toHaveLength(0);
    expect(r.reply).toBeNull();
  });
  it("★ a sticky safety conversation and an unrelated ask: the handoff, but no stop-use line", async () => {
    const { prisma } = await import("@chatcenter/shared");
    h.responses.push({ toolCalls: [respond("u1", { reply: "תודה על הפנייה, נשמח לשמוע עוד." })] });
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _safetyAt: new Date().toISOString() }, offeredItems: [], pending: [], turnCount: 5 });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לשיתוף פעולה עם תוכן UGC" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect(r.trace.safetyHandoff).toBe(true);
    expect(r.reply).not.toMatch(/להפסיק להשתמש/);
  });
});

describe("prod replay 12: one reply, no sentence twice", () => {
  it("★ a sentence the model wrote twice goes out once", async () => {
    h.responses.push({ toolCalls: [respond("d1", { reply: "יש תיק בד קנבס במלאי. יש תיק בד קנבס במלאי. לאיזה שימוש?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה לגבי המחיר?" }, "autonomous");
    expect(r.reply).toBe("יש תיק בד קנבס במלאי. לאיזה שימוש?");
  });
});

describe("prod replay 13: garbage never reaches the customer", () => {
  it("★ a reply ending in \"+#+#+#+#+#+\" goes out clean", async () => {
    h.responses.push({ toolCalls: [respond("g1", { reply: "את התשלום עושים בעמוד הקופה באתר.+#+#+#+#+#+" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איך משלמים?" }, "autonomous");
    expect(r.reply).toBe("את התשלום עושים בעמוד הקופה באתר.");
    expect((r.trace as any).sanitized).toBe(true);
  });
});

describe("automated mail (prod replay 2026-11-17, a held-out store)", () => {
  it("★ a no-reply sender: no model call, no reply, no handoff, no team question", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const before = (prisma as any).conversation.findFirst;
    (prisma as any).conversation.findFirst = async () => ({ id: "c1", tenantId: "t1", channel: "GMAIL", customerExternalId: "noreply@accounts.example.com" });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "Translate this slogan and send it to your customers: Big sale!" }, "autonomous"); }
    finally { (prisma as any).conversation.findFirst = before; }
    expect(h.calls).toHaveLength(0);
    expect(r.reply ?? null).toBeNull();
    expect(r.escalation ?? null).toBeNull();
    expect((r.trace as any).automated).toBe("no_reply_sender");
  });
  it("a real customer on email is answered", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const before = (prisma as any).conversation.findFirst;
    (prisma as any).conversation.findFirst = async () => ({ id: "c1", tenantId: "t1", channel: "GMAIL", customerExternalId: "dana@gmail.com" });
    h.responses.push({ toolCalls: [respond("e1", { reply: "בטח, יש." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם את זה בכחול?" }, "autonomous"); }
    finally { (prisma as any).conversation.findFirst = before; }
    expect(h.calls.length).toBeGreaterThan(0);
    expect((r.trace as any).automated).toBeUndefined();
  });
});

describe("eval follow-up: the lines the engine adds are in the reply's language", () => {
  it("★ a Latin-only \"yes please\" in a Hebrew chat: the handoff line is Hebrew", async () => {
    h.history = [
      { direction: "INBOUND", body: "hello", metadata: null },
      { direction: "OUTBOUND", body: "אפשר להעביר לנציג מהצוות, רוצה?", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "yes please", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("l1", { reply: "בטח." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "yes please" }, "autonomous");
    expect(r.reply).toMatch(/[\u0590-\u05FF]/);
    expect(r.reply).not.toMatch(/A person from the team/);
  });
});

describe("the model reads the email as a forwarded notification (prod replay 2026-11-17)", () => {
  it("★ on an email channel: no reply, no handoff, no team question", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const before = (prisma as any).conversation.findFirst;
    (prisma as any).conversation.findFirst = async () => ({ id: "c1", tenantId: "t1", channel: "GMAIL", customerExternalId: "dana@gmail.com" });
    h.responses.push({ toolCalls: [respond("m1", { reply: "It looks like an automated message from Instagram. Is there anything we can help with?", team_question: "check this" })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "Hi Dana, someone tried to log in to your account" }, "autonomous"); }
    finally { (prisma as any).conversation.findFirst = before; }
    expect(r.reply ?? null).toBeNull();
    expect(r.escalation ?? null).toBeNull();
    expect((r.trace as any).automated).toBe("model_framed");
  });
  it("on WhatsApp the same reply is an answer (a customer asking about a message they got)", async () => {
    h.responses.push({ toolCalls: [respond("m2", { reply: "It looks like an automated message from Instagram, not from us." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "is this message from you?" }, "autonomous");
    expect((r.trace as any).automated).toBeUndefined();
  });
});

describe("a needless handoff takes its words with it (prod replay 2026-11-17, Smoovee)", () => {
  it("★ \"passed to the team\" left behind becomes a real team question; \"a person continues\" is cut", async () => {
    h.responses.push(
      { toolCalls: [respond("n1", { reply: "מבינים. העברנו את הבדיקה לצוות. נציג מהצוות ימשיך איתך כאן.", handoff: "check" })] },
      { toolCalls: [respond("n2", { reply: "מבינים. העברנו את הבדיקה לצוות. נציג מהצוות ימשיך איתך כאן.", handoff: "check" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי זה יגיע?" }, "autonomous");
    expect(r.escalation ?? null).toBeNull();
    expect(r.reply).not.toMatch(/ימשיך איתך/);
    // "Passed to the team" is kept only together with a real team question.
    // The model's own sentence (not a canned team line), now true.
    expect(r.reply).toMatch(/העברנו את הבדיקה לצוות/);
    expect((r.trace as any).teamQuestion).toBeTruthy();
  });
});

describe("3ca1dabe rating: engine passes", () => {
  it("★ a platform event is no customer text", async () => {
    const { placeholderOnly, stripUnmatchedEdges, sanitizeReply } = await import("../services/reply-engine/engine");
    for (const t of ["[edit message]", "[Message deleted]", "[deleted message]", "[הודעה נערכה]", "[poll]"]) expect(placeholderOnly(t), t).toBe(true);
    expect(placeholderOnly("[edit] the price?")).toBe(false);
    expect(sanitizeReply('" I can check that for you.')).toBe("I can check that for you.");
    expect(stripUnmatchedEdges("(see the sizes")).toBe("see the sizes");
    expect(stripUnmatchedEdges('"Oak" is in stock.')).toBe('"Oak" is in stock.');
    expect(stripUnmatchedEdges("Yes (in black).")).toBe("Yes (in black).");
  });
  it("★ a payment problem gets no cards and no product list", async () => {
    h.responses.push(
      { toolCalls: [tc("p0", "woocommerce.list_products", { query: "תיק" })] },
      { toolCalls: [respond("p1", { reply: "מצטערים על זה. אפשר לשלם גם בכרטיס אשראי או בביט. הנה מה שיש לנו:", cards: ["PRODUCT_1"] })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא מצליח לשלם עם ביימי" }, "autonomous");
    expect((r.trace as any).cards ?? []).toEqual([]);
    expect(r.reply).not.toMatch(/Canvas Tote/);
  });
});

describe("2f6ff7e3 rating: engine passes", () => {
  it("★ the tenant's own team member on WhatsApp is not answered", async () => {
    const { internalSender } = await import("../services/reply-engine/engine");
    const db = { user: { findMany: async () => [{ phoneNumber: "+972-50-123-4567" }] } };
    expect(await internalSender("t1", "WHATSAPP", "972501234567", db)).toBe(true);
    expect(await internalSender("t1", "WHATSAPP", "972509999999", db)).toBe(false);
    expect(await internalSender("t1", "WEBCHAT", "972501234567", db)).toBe(false);
  });
  it("★ a fallback's own bullets are not listed again", async () => {
    const { textProductList } = await import("../services/reply-engine/engine");
    const c = [{ title: "Canvas Tote", price: 79, currency: "ILS", inventoryState: "in_stock", url: "https://x/t" }];
    expect(textProductList({ reply: "x", cards: [] } as any, "הנה מה שיש לנו שמתאים:\n• Canvas Tote, ₪79", c as any, "he")).toBeNull();
    expect(textProductList({ reply: "x", cards: [] } as any, "יש לנו את Canvas Tote.", c as any, "he")?.text).toMatch(/Canvas Tote/);
  });
});

describe("2f6ff7e3 rating: whole turns", () => {
  it("★ a repeat team question with new digits updates the open item", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: התשלום בביימי לא עבר", at: new Date().toISOString() }], turnCount: 3 });
    h.responses.push({ toolCalls: [respond("d1", { reply: "תודה על הפרטים.", team_question: "התשלום בביימי לא עבר" })] });
    let rr: any;
    try { rr = await runReplyEngineTurn({ ...opts, incomingMessage: "הכרטיס נגמר ב-4155, התשלום בביימי לא עבר" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    const saved = h.upserts.at(-1);
    const pending = (saved?.update?.pending ?? saved?.create?.pending ?? []) as any[];
    expect(rr?.trace?.teamQuestionRepeat).toBe(true);
    expect(pending.some((p) => /customer gave: 4155/.test(String(p.text)))).toBe(true);
  });
  it("★ the tenant's own team member on WhatsApp: no model call, no reply", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const conv = (prisma as any).conversation.findFirst;
    (prisma as any).conversation.findFirst = async () => ({ id: "c1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "972501234567" });
    (prisma as any).user = { findMany: async () => [{ phoneNumber: "+972 50-123-4567" }] };
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "היי, מה המצב?" }, "autonomous"); }
    finally { (prisma as any).conversation.findFirst = conv; delete (prisma as any).user; }
    expect(h.calls).toHaveLength(0);
    expect(r.reply ?? null).toBeNull();
    expect((r.trace as any).internal).toBe(true);
  });
});
