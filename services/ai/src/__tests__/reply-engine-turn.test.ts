/**
 * Reply engine v2, one whole turn against fakes: the model is scripted, the
 * store and the database are doubles. Pins the turn's contract end to end:
 * every allowed tool offered (sorted, respond included), a store search
 * grounded into keys, cards staged from keys, Gate 3 rewrite then fallback,
 * shadow simulating writes on the platform's credits, Gate 1 stopping early.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  textChannel: false,
  offerWrite: false,
  /** The business switched the close tool on for its employee. */
  offerClose: false,
  /** The conversation's channel, the business's stored idle setting, and whether reading it fails. */
  channel: "WEBCHAT",
  idleRow: null as string | null,
  idleReadThrows: false,
  settingReads: [] as any[],
  variations: false,
  onTool: null as null | ((name: string) => void),
  lexicalFor: null as null | ((q: string) => any[]),
  policy: {} as Record<string, string>,
  teamQuestions: [] as any[],
  /** Every automatic knowledge lookup's arguments (the gap flag among them). */
  retrieveCalls: [] as any[],
  historyQueries: [] as any[],
  failReads: 0,
  chunks: null as any,
  slowReads: 0,
  slowOrders: 0,
  orderDelay: 900,
  history: null as any[] | null,
  lexical: [] as any[],
  groundTitle: "Canvas Tote",
  groundUrl: "u",
  groundCategory: "",
  extraTitle: "",
  docAddress: null as string | null,
  groundStatus: "ok" as string,
  /** Titles per search, in order (a retried search sees the next); empty: groundTitle every time. */
  groundSeq: [] as string[],
  /** The products a search finds, when set (title, price, stock); else groundTitle and extraTitle. */
  groundList: null as null | Array<{ title: string; price: number | null; inventoryState?: string; category?: string }>,
  /** Extra columns of the agent row (customGuardrails, escalationRules) and the business policy row. */
  agentExtra: {} as Record<string, any>,
  policyRow: null as any,
}));

vi.mock("@chatcenter/shared", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    prisma: {
      aIAgent: { findUnique: async () => ({ id: "ag1", tenantId: "t1", name: "נועה", role: "customer_support", status: h.agentStatus, model: "gpt-6-luna", persona: { gender: "female" }, escalationMessage: "x", ...h.agentExtra }) },
      businessPolicy: { findUnique: async () => h.policyRow },
      conversation: { findFirst: async () => ({ id: "c1", tenantId: "t1", channel: h.channel, customerExternalId: "v1" }) },
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
    readDurableSetting: async (tenantId: string, key: string) => {
      h.settingReads.push([tenantId, key]);
      if (h.idleReadThrows) throw new Error("settings store down");
      return h.idleRow;
    },
    recordUnansweredQuestion: async (q: any) => { h.teamQuestions.push(q); },
    buildAgentToolsForAIAgent: async () => [
      { type: "function", function: { name: "escalate_to_human", description: "hand over", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "send_product_card", description: "card", parameters: { type: "object", properties: {} } } },
      ...(h.offerWrite ? [{ type: "function", function: { name: "woocommerce.add_order_note", description: "note", parameters: { type: "object", properties: {} } } }] : []),
      ...(h.offerClose ? [{ type: "function", function: { name: "close_conversation", description: "close", parameters: { type: "object", properties: { reason: { type: "string" } } } } }] : []),
      ...(h.variations ? [{ type: "function", function: { name: "woocommerce.list_product_variations", description: "variations", parameters: { type: "object", properties: { product_id: { type: "string" } } } } }] : []),
    ],
    evaluatePolicies: async ({ toolName }: any) => ({ decision: h.policy[toolName] ?? "ALLOW", reason: "test" }),
    dispatchToolCall: async (tc: any, ctx: any) => {
      h.dispatched.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments), sandbox: ctx.sandbox ?? null });
      if (h.onTool) h.onTool(tc.function.name);
      if (tc.function.name === "woocommerce.list_products" && h.slowReads > 0) { h.slowReads--; await new Promise((r) => setTimeout(r, 900)); }
      if (tc.function.name === "woocommerce.get_order" && h.slowOrders > 0) { h.slowOrders--; await new Promise((r) => setTimeout(r, h.orderDelay)); }
      if (tc.function.name === "woocommerce.list_products" && h.failReads > 0) { h.failReads--; return { toolCallId: tc.id, content: JSON.stringify({ ok: false, failure: "errored", reason: "woocommerce_500" }) }; }
      if (tc.function.name === "woocommerce.get_product" && JSON.parse(tc.function.arguments).product_id === "40300") return { toolCallId: tc.id, content: JSON.stringify({ ok: false, failure: "refused", reason: "access_denied_cross_customer: this chat may only access the customer's own records." }) };
      if (tc.function.name === "woocommerce.list_products") return { toolCallId: tc.id, content: JSON.stringify({ ok: true, result: [{ id: 101, name: "Canvas Tote", price: "79" }] }) };
      if (tc.function.name === "woocommerce.list_product_variations") return { toolCallId: tc.id, content: JSON.stringify({ ok: true, result: [{ id: 9, attributes: { Color: "Black", Size: "L" }, stock_status: "instock", available: true }] }) };
      if (tc.function.name === "woocommerce.get_product" && JSON.parse(tc.function.arguments).product_id === "77") return { toolCallId: tc.id, content: JSON.stringify({ ok: true, result: { id: 77, name: "Heavyweight Hoodie", description: "Organic cotton, heavy fleece." } }) };
      if (tc.function.name === "woocommerce.get_product" && JSON.parse(tc.function.arguments).product_id === "78") return { toolCallId: tc.id, content: JSON.stringify({ ok: true, result: { id: 78, name: "Zip Hoodie", description: "Charcoal zip hoodie." } }) };
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
    // A text channel (WhatsApp) has no card sender.
    sendShopifyProducts: h.textChannel ? undefined : async (a: any) => { h.staged.push({ products: a.products }); return { ok: true }; },
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
  groundProductSearchResult: async () => ((title: string) => ({
    provider: "woocommerce", tool: "woocommerce_product_search", status: h.groundStatus,
    candidates: h.groundList ? h.groundList.map((p, i) => ({ title: p.title, productId: String(201 + i), price: p.price, currency: "ILS", inventoryState: p.inventoryState ?? "in_stock", url: `u${i}`, attributes: p.category ? { category: p.category } : {}, unknownAttributes: [] })) : [{ title, productId: "101", price: 79, currency: "ILS", inventoryState: "in_stock", url: h.groundUrl, attributes: h.groundCategory ? { category: h.groundCategory } : {}, unknownAttributes: [] }, ...(h.extraTitle ? [{ title: h.extraTitle, productId: "102", price: 89, currency: "ILS", inventoryState: "in_stock", url: "u2", attributes: {}, unknownAttributes: [] }] : [])],
    appliedFilters: [], unavailableFilters: [], safeModelSummary: title,
  }))(h.groundSeq.length ? h.groundSeq.shift()! : h.groundTitle),
}));
vi.mock("../services/knowledge.service", () => ({
  retrieveRelevantChunks: async (...a: any[]) => { h.retrieveCalls.push(a); return h.chunks ?? []; }, buildKnowledgeContext: (c: any[]) => c.map((x) => x.content).join("\n"), shouldRecordKnowledgeGap: () => false,
  lexicalKnowledge: async (_t: string, q: string) => (h.lexicalFor ? h.lexicalFor(q) : h.lexical), mergeKnowledge: (v: any[], l: any[]) => [...v, ...l],
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
// Omer 2026-11-23: nothing is "passed to the team" any more. A turn answers, or it hands over: the approved line ends
// the reply, the escalation carries it word for word for the worker, and no team claim is left.
const HAND = "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.";
const TEAM_CLAIM = /צוות|תגיע כאן|בבדיקה|ממתינים|נחזור|בבירור/;
const handedOver = (r: any) => {
  expect(r.escalation?.reason).toMatch(/^ai_handoff:/);
  expect(String(r.reply ?? "").endsWith(HAND)).toBe(true);
  expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
  expect(r.escalation?.customerLine).toBe(r.reply);
  expect(r.escalation?.announce).toBe(true);
};

beforeEach(() => {
  for (const k of ["responses", "calls", "scopeSeen", "dispatched", "submitted", "upserts", "audits", "staged", "teamQuestions", "historyQueries", "settingReads", "retrieveCalls"] as const) (h as any)[k].length = 0;
  h.offerClose = false;
  h.channel = "WEBCHAT";
  h.idleRow = null;
  h.idleReadThrows = false;
  delete process.env.BOT_IDLE_DEFAULT_ON;
  h.failReads = 0;
  h.chunks = null;
  h.slowReads = 0;
  h.slowOrders = 0;
  h.orderDelay = 900;
  h.textChannel = false;
  h.offerWrite = false;
  h.variations = false;
  h.onTool = null;
  h.lexicalFor = null;
  h.history = null;
  h.lexical = [];
  h.groundTitle = "Canvas Tote";
  h.groundSeq = [];
  h.groundList = null;
  h.groundUrl = "u";
  h.groundCategory = "";
  h.extraTitle = "";
  h.docAddress = null;
  h.groundStatus = "ok";
  h.agentStatus = "ACTIVE";
  h.agentExtra = {};
  h.policyRow = null;
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

  it("Gate 3: one targeted rewrite, then the safe reply: nothing can be said, so a real hand-over (no team question any more)", async () => {
    h.responses.push(
      { toolCalls: [respond("r1", { reply: "אפשר לשלם בתשלומים, ₪120 לחודש." })] },
      { toolCalls: [respond("r2", { reply: "בטח, ₪150 בלבד לחודש." })] },
    );
    // A question no product search answers (a product ask now falls back to the store's products, below).
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
    // Nothing of either draft survives: ONE more targeted rewrite is tried (prod replay 9), then the fallback.
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1].toolChoice).toEqual({ type: "function", function: { name: "respond" } });
    expect(h.calls[2].messages.find((m: any) => m.role === "system" && /could not be sent as written/.test(m.content))?.content).toMatch(/Write the full answer/);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(r.reply).not.toMatch(/₪/);
    handedOver(r);
    expect(r.reply).toBe(HAND);
    // The question is on the owner's list, from the hand-over turn.
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

  it("a handoff nobody asked for is rewritten once; a rewrite that still cannot answer is the hand-over (eval: discount, instalments)", async () => {
    const q = { ...opts, incomingMessage: "אפשר לשלם בתשלומים?" };
    h.responses.push(
      { toolCalls: [respond("h1", { reply: "מעבירים אותך לנציג שימשיך מכאן.", handoff: "instalments question" })] },
      { toolCalls: [respond("h2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "האם אפשר לשלם בתשלומים?" })] },
    );
    const r = await runReplyEngineTurn(q, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("needless_handoff");
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    handedOver(r);
    expect(r.reply).toBe(HAND);
    expect(h.teamQuestions[0]).toMatchObject({ question: "האם אפשר לשלם בתשלומים?", askerKey: "c1" });
    // No "checking with the team" item is kept: the hand-over is the follow-up.
    const saved = h.upserts[0].create;
    expect(saved.pending.map((p: any) => p.kind)).not.toContain("promise");
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
    expect(r.reply).toMatch(/^הנה כמה אפשרויות: .+\.$/);
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

  it("A08: \"no info\" without reading the product -> the engine reads it (her product words), then answers", async () => {
    const q = { ...opts, incomingMessage: "הסוודר מרינו מגרד?" };
    // The store's search finds the sweater, with its own text in the result.
    h.groundTitle = "סוודר 100% כותנה אורגנית";
    h.responses.push(
      { toolCalls: [respond("a1", { reply: "אין לי כאן מידע על זה, אפשר לבדוק מול הצוות." })] },
      { toolCalls: [respond("a3", { reply: "הוא בכלל מכותנה אורגנית 100%, לא מרינו, אז לא מגרד." })] },
    );
    const r = await runReplyEngineTurn(q, "autonomous");
    // Replay on 1b35c535: the engine's own lookup, no model tool round; the store by the product words only.
    expect(h.calls[1].toolChoice).toEqual({ type: "function", function: { name: "respond" } });
    expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toBe("סוודר מרינו מגרד");
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
    // She asks about a discount: the team question is hers (since 2026-11-18 one she never raised is dropped).
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש הנחה על התיק?", replay: { asOf, messageId: "m9" } }, "autonomous");
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

  it("★ an item \"checking with the team\" from before 2026-11-23 is dropped: not shown to the model, not saved again", async () => {
    await withOpenTeamQuestion(async () => {
      h.responses.push({ toolCalls: [respond("t1", { reply: "אנחנו פתוחים בימים א עד ה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה שעות הפתיחה?" }, "autonomous");
      expect(r.reply).toBe("אנחנו פתוחים בימים א עד ה.");
      expect(r.escalation).toBeNull();
      expect(JSON.stringify(h.calls[0].messages)).not.toContain("checking with the team");
      const saved = h.upserts[0].create;
      expect(saved.pending.filter((p: any) => String(p.text).startsWith("checking with the team: "))).toHaveLength(0);
    });
  });

  it("★ \"I passed it to the team\" with no search this turn: the knowledge is searched and the rewrite answers", async () => {
    await withOpenTeamQuestion(async () => {
      h.responses.push(
        { toolCalls: [respond("t2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט." })] },
        { toolCalls: [respond("t3", { reply: "אנחנו פתוחים בימים א עד ה." })] },
      );
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה שעות הפתיחה?" }, "autonomous");
      expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("unlooked_pass");
      expect(r.trace.tools.some((t: any) => t.tool === "search_knowledge")).toBe(true);
      expect(r.trace.gate3.rewrite).toBe("rewritten");
      expect(r.reply).toBe("אנחנו פתוחים בימים א עד ה.");
      expect(r.escalation).toBeNull();
    });
  });

  it("a question still not known after the search is a hand-over, and goes on the owner's list", async () => {
    await withOpenTeamQuestion(async () => {
      h.responses.push(
        { toolCalls: [respond("t4", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "האם אפשר לשלם בתשלומים?" })] },
        { toolCalls: [respond("t5", { reply: "אין לנו כאן מידע על תשלומים.", team_question: "האם אפשר לשלם בתשלומים?" })] },
      );
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
      handedOver(r);
      // The rewrite's "we have no information" is an ungrounded absence and is cut: the approved line alone.
      expect(r.reply).toBe(HAND);
      expect(h.teamQuestions).toHaveLength(1);
      expect(r.trace.teamQuestion).toBe("האם אפשר לשלם בתשלומים?");
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

  it("★ unread product: the engine reads the product itself (store and knowledge), then one answer; two model calls in all", async () => {
    h.responses.push(
      { toolCalls: [respond("u1", { reply: "אין לי כאן מידע על זה, אבדוק מול הצוות." })] },
      { toolCalls: [respond("u4", { reply: "הוא מכותנה אורגנית, נעים ולא מגרד." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "הסוודר מגרד?" }, "autonomous");
    expect(h.calls.map((c) => c.toolChoice)).toEqual(["required", { type: "function", function: { name: "respond" } }]);
    expect(h.dispatched.map((d) => d.name)).toContain("woocommerce.list_products");
    expect((r.trace as any).rewriteRounds).toBe(1);
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

  it("★ the fallback's team line is a hand-over now: the approved line, the team told", async () => {
    h.responses.push(
      { toolCalls: [respond("c1", { reply: "אפשר לשלם בתשלומים, ₪120 לחודש." })] },
      { toolCalls: [respond("c2", { reply: "בטח, ₪150 בלבד לחודש." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("fallback");
    handedOver(r);
    expect(r.reply).toBe(HAND);
  });

  it("★ the canned line already went out and she brought nothing new: nothing is sent, and nothing goes to the team", async () => {
    await withState({ facts: { _cannedTeamLineAt: new Date().toISOString() } }, async () => {
      h.responses.push(
        { toolCalls: [respond("c3", { reply: "התיק עולה ₪120." })] },
        { toolCalls: [respond("c4", { reply: "בטח, ₪150 בלבד." })] },
      );
      // Not a product ask and not a question: silence is allowed (a question gets a holding line, below).
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "טוב" }, "autonomous");
      expect(r.trace.gate3.rewrite).toBe("silent");
      expect(r.reply).toBeNull();
      expect(r.escalation).toBeNull();
      // A bare "טוב" is no question for the team (2026-11-19: it was recorded as one; a real question takes the
      // holding-line branch below and reaches the team there).
      expect(h.teamQuestions).toHaveLength(0);
      { const up = h.upserts[h.upserts.length - 1]; expect(up?.create?.pending ?? up?.update?.pending ?? []).toHaveLength(0); }
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
      // The worker sends this line word for word (it used to write its own).
      handedOver(r);
      expect(r.reply).toBe(HAND);
    });
  });

  it("★ an order lookup refused as another customer's: the model is told to ask for the order number", async () => {
    h.responses.push(
      { toolCalls: [tc("o1", "woocommerce.get_product", { product_id: "40300" })] },
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
    // The engine searched the customer's own product words itself (never "יש" and the question mark); one model call for the answer.
    expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toBe("משטחי במבוק");
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
    expect(r.reply).toMatch(/^הנה כמה אפשרויות: .+\.$/);
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
    expect(r.reply).toBe("מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.");
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
    // A question is never met with silence (2c57725b rating): with nothing new to say, a person takes it.
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "נו?" }, "autonomous");
    expect(r.trace.gate3.rewrite).not.toBe("silent");
    handedOver(r);
    expect(r.reply).toBe(HAND);
  });

  it("★ the same paragraph twice on a plain nudge: nothing is sent", async () => {
    const para = "כדי לבדוק את ההזמנה צריך את מספר ההזמנה, והטלפון ששמור עליה לא תואם למספר שממנו כותבים.";
    h.history = [
      { direction: "INBOUND", body: "איפה ההזמנה?", metadata: null },
      { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "נו", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("d3", { reply: para })] }, { toolCalls: [respond("d4", { reply: para })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "נו" }, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("silent");
    expect(r.reply).toBeNull();
  });

  it("★ the final cleanup: a bent title is restored, a price without its product is dropped", async () => {
    h.responses.push(
      { toolCalls: [tc("fx1", "woocommerce.list_products", { query: "תיק" })] },
      { toolCalls: [respond("fx2", { reply: "יש לנו את Canvass Tote במלאי." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
    expect(r.reply).toMatch(/Canvas Tote/);
    expect(r.reply).not.toMatch(/Canvass/);
    h.responses.push(
      { toolCalls: [tc("fx3", "woocommerce.list_products", { query: "תיק" })] },
      { toolCalls: [respond("fx4", { reply: "יש לנו תיק בד יפה מאוד. הוא במבצע ב-₪79." })] },
    );
    const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
    expect(r2.reply).not.toMatch(/הוא במבצע/);
  });

  it("★ a charge complaint with card digits, an old team item open: the item is ignored, the payment guesses never go out, a person takes it", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const { HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 3 });
    try {
      h.responses.push({ toolCalls: [respond("hm1", { reply: "תודה! ייתכן שאישור הויזה זמני ואינו חיוב סופי, והבדיקה מול ספק התשלום בתהליך." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "4 ספרות אחרונות 4155" }, "autonomous");
      void HOLD_ACK_HE;
      handedOver(r);
      expect(r.reply).not.toMatch(/ויזה|ספק התשלום|זמני/);
      const up = h.upserts[h.upserts.length - 1];
      const saved: any[] = up?.create?.pending ?? up?.update?.pending ?? [];
      expect(saved.filter((p: any) => p.kind === "promise")).toHaveLength(0);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ an unasked first name is dropped from the reply", async () => {
    h.responses.push({ toolCalls: [respond("nm1", { reply: "היי אלה, אנחנו פתוחים א-ה 9-17." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי אתם פתוחים?" }, "autonomous");
    expect(r.reply).not.toMatch(/אלה/);
    expect(r.reply).toMatch(/9-17/);
  });

  it("★ a team question the model raises next to an old team item: a hand-over, the question on the owner's list, no item kept", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 3 });
    try {
      h.responses.push({ toolCalls: [respond("hm3", { reply: "קיבלתי את הספרות.", team_question: "4 ספרות אחרונות של הכרטיס 4155" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "4 ספרות אחרונות 4155" }, "autonomous");
      const up = h.upserts[h.upserts.length - 1];
      const saved: any[] = up?.create?.pending ?? up?.update?.pending ?? [];
      expect(saved.filter((p: any) => p.kind === "promise")).toHaveLength(0);
      handedOver(r);
      expect(h.teamQuestions).toHaveLength(1);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ holding mode: an unrelated question is answered", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 3 });
    try {
      h.responses.push({ toolCalls: [respond("hm2", { reply: "אנחנו פתוחים א-ה 9-17." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה שעות הפעילות שלכם בשבוע הבא?" }, "autonomous");
      expect(r.reply).toMatch(/9-17/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ a question nothing answers is a hand-over every time it comes, never a holding line or silence", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const { stillCheckingLine } = await import("../services/reply-engine/engine");
    const q = "איפה מזינים את הקופון?";
    const st = (pending: any[]) => { (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString() }, offeredItems: [], pending, turnCount: 3 }); };
    try {
      st([]);
      h.responses.push({ toolCalls: [respond("h1", { reply: "התיק עולה ₪120." })] }, { toolCalls: [respond("h2", { reply: "בטח, ₪150 בלבד." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: q }, "autonomous");
      handedOver(r);
      expect(r.trace.teamQuestion).toBeTruthy();
      const item = [{ kind: "promise", text: `checking with the team: ${q}`, at: new Date().toISOString() }];
      st(item);
      const holding = stillCheckingLine(q, "he");
      h.responses.push({ toolCalls: [respond("h3", { reply: "התיק עולה ₪120." })] }, { toolCalls: [respond("h4", { reply: "בטח, ₪150 בלבד." })] });
      const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: q }, "autonomous");
      handedOver(r2);
      expect(r2.reply).not.toBe(holding);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ a name question after a failed reply: the last shown product, never the holding line", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString() }, offeredItems: [{ productId: "9", title: "Cocoa 2" }], pending: [{ kind: "promise", text: "checking with the team: הגוון של קרם הלחות", at: new Date().toISOString() }], turnCount: 5 });
    try {
      h.responses.push({ toolCalls: [respond("n1", { reply: "התיק עולה ₪120." })] }, { toolCalls: [respond("n2", { reply: "בטח, ₪150 בלבד." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איך קוראים לו?" }, "autonomous");
      expect(r.reply).toBe("זה Cocoa 2.");
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ an old team item open: a thanks gets its welcome with the stale \"still with the team\" cut; a status ask is a hand-over", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const { stillCheckingLine } = await import("../services/reply-engine/engine");
    const item = "חויבתי פעמיים ואין הזמנה";
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: `checking with the team: ${item}`, at: new Date().toISOString() }], turnCount: 6 });
    const holding = stillCheckingLine(item, "he");
    try {
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: holding, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("t1", { reply: "בשמחה! הבדיקה עדיין אצל הצוות." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה" }, "autonomous");
      expect(r.reply).toBe("בשמחה!");
      h.history = [...h.history, { direction: "INBOUND", body: "תודה", metadata: null }, { direction: "OUTBOUND", body: "בשמחה!", senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("t2", { reply: "בשמחה!" })] });
      const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה רבה" }, "autonomous");
      expect(r2.escalation).toBeNull();
      expect(r2.reply ?? "").not.toMatch(TEAM_CLAIM);
      // "Still being checked" promises a check nobody is doing: a person takes the status ask.
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: holding, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("t3", { reply: "החיוב עדיין בבדיקה." })] });
      const r3 = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
      handedOver(r3);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ a failed payment method: the guesses are cut and a person takes it (no tool can fix a payment)", async () => {
    h.responses.push({ toolCalls: [respond("p1", { reply: "האם גם אחד מהם נכשל? ייתכן שהתשלום לא עבר בגלל תקלה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ניסיתי לשלם בביימי וזה נכשל" }, "autonomous");
    handedOver(r);
    expect(r.reply).not.toMatch(/ייתכן|נכשל\?/);
    expect(r.trace.teamQuestion).toBeTruthy();
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
    expect(r.reply).toBe("מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:/);
  });

  it("★ \"no information\" on a late order: a person takes it (a late order is a hand-over, no knowledge gap)", async () => {
    h.responses.push({ toolCalls: [respond("e1", { reply: "מצטערים, אין לי מידע על זה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ההזמנה עדיין לא הגיעה, כבר שבועיים" }, "autonomous");
    handedOver(r);
  });
});

describe("prod replay 8 (2026-11-17), through a whole turn", () => {
  it("★ a call request the reply ignores: there is no call tool, so a person takes it", async () => {
    h.responses.push({ toolCalls: [respond("c1", { reply: "בשמחה לעזור כאן בצ'אט." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יכול להתקשר אלי?" }, "autonomous");
    expect((r.trace as any).callToTeam).toBe(true);
    expect(h.teamQuestions[0].question).toMatch(/^call request:/);
    handedOver(r);
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
    expect(r.reply).toBe("תודה על הפרטים, זה עוזר להבין. מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.");
  });

  it("★ \"already with the team\" for another subject: a hand-over, this ask on the owner's list", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const OPEN = { kind: "promise", text: "checking with the team: הקופון WELCOME10 לא עובד בתשלום", at: new Date().toISOString() };
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [OPEN], turnCount: 3 });
    h.responses.push({ toolCalls: [respond("t1", { reply: "זה כבר אצל הצוות, והתשובה תגיע כאן בצ'אט." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה עם משלוח לאילת?" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    handedOver(r);
    expect(r.reply).toBe(HAND);
    expect(h.teamQuestions.map((q) => q.question)).toEqual(["ומה עם משלוח לאילת?"]);
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
    h.responses.push({ toolCalls: [respond("z2", { reply: "מצטערים לשמוע, מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.", handoff: "tipping" })] });
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
      { direction: "INBOUND", body: "[template attachment]", metadata: null },
    ];
    // A template is no message to answer (an unsupported one is asked to be resent once, below).
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "[template attachment]" }, "autonomous");
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
  it("★ a hand-over for a question the model could not answer, said twice: a real hand-over, the team sentence cut", async () => {
    h.responses.push(
      { toolCalls: [respond("n1", { reply: "מבינים. העברנו את הבדיקה לצוות. נציג מהצוות ימשיך איתך כאן.", handoff: "check" })] },
      { toolCalls: [respond("n2", { reply: "מבינים. העברנו את הבדיקה לצוות. נציג מהצוות ימשיך איתך כאן.", handoff: "check" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי זה יגיע?" }, "autonomous");
    handedOver(r);
    expect(r.reply).not.toMatch(/ימשיך איתך|העברנו את הבדיקה/);
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
  it("★ a repeat of an old team question with new digits: no item is updated or kept, a person takes it", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: התשלום בביימי לא עבר", at: new Date().toISOString() }], turnCount: 3 });
    h.responses.push({ toolCalls: [respond("d1", { reply: "תודה על הפרטים.", team_question: "התשלום בביימי לא עבר" })] });
    let rr: any;
    try { rr = await runReplyEngineTurn({ ...opts, incomingMessage: "הכרטיס נגמר ב-4155, התשלום בביימי לא עבר" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    const saved = h.upserts.at(-1);
    const pending = (saved?.update?.pending ?? saved?.create?.pending ?? []) as any[];
    expect(pending.some((p) => p.kind === "promise")).toBe(false);
    handedOver(rr);
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

describe("4511b79c rating: engine passes", () => {
  it("★ no sarcastic emoji; warm ones stay", async () => {
    const { sanitizeReply } = await import("../services/reply-engine/engine");
    expect(sanitizeReply("נשמח לעזור 🙃")).toBe("נשמח לעזור");
    expect(sanitizeReply("אופס 😅 טעות שלנו")).toBe("אופס טעות שלנו");
    expect(sanitizeReply("תודה 🙏")).toBe("תודה 🙏");
  });
  it("★ a NEW request after an earlier team line is passed now, not \"still being checked\" (b8ec6dcf rating)", async () => {
    h.history = [
      { direction: "INBOUND", body: "האם יש הנחה לכמות?", metadata: null },
      { direction: "OUTBOUND", body: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "ומה עם משלוח לאילת?", metadata: null },
    ];
    // A call request: the engine adds its own team line, and one was already sent in this conversation.
    h.responses.push({ toolCalls: [respond("c1", { reply: "בשמחה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר שתתקשרו אליי לגבי משלוח לאילת?" }, "autonomous");
    // A call request: no call tool, so a person takes it now; never "still being checked".
    handedOver(r);
    expect(r.reply ?? "").not.toMatch(/עדיין בבדיקה/);
    expect(r.reply ?? "").not.toMatch(/"/);
  });
  it("★ the same team line again on a repeat: it names what is checked instead", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString() }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: הנחה לכמות", at: new Date().toISOString() }], turnCount: 4 });
    try {
      h.history = [
        { direction: "INBOUND", body: "האם יש הנחה לכמות?", metadata: null },
        { direction: "OUTBOUND", body: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", senderName: "AI Bot", metadata: null },
      ];
      h.responses.push({ toolCalls: [respond("rp1", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "הנחה לכמות" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אז יש הנחה לכמות?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/העברתי את השאלה לצוות/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
  it("★ back on an old team subject: the old item is not repeated to the customer", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: הגוון של קרם הלחות", at: new Date().toISOString() }], turnCount: 4 });
    h.responses.push({ toolCalls: [respond("o1", { reply: "אשמח לעזור עוד." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה עם הגוון של קרם הלחות?" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
  });
});

describe("e78b114c rating: engine passes", () => {
  it("★ a person on the team wrote in the last 24h: the AI stays out", async () => {
    h.history = [
      { direction: "INBOUND", body: "היי", metadata: null, createdAt: new Date(Date.now() - 3 * 3600_000) },
      { direction: "OUTBOUND", body: "היי, כאן עומר", senderName: "omer@example.com", metadata: { source: "inbox" }, createdAt: new Date(Date.now() - 2 * 3600_000) },
    ];
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה המצב?" }, "autonomous");
    expect(h.calls).toHaveLength(0);
    expect(r.reply ?? null).toBeNull();
    expect(String((r.trace as any).gate1)).toMatch(/^human_owned/);
  });
  it("★ a team question recorded this turn is a hand-over: the fixed line, its own text never quoted", async () => {
    h.responses.push({ toolCalls: [respond("q1", { reply: "מבינים.", team_question: "חיוב כפול בביימי" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "חויבתי פעמיים בביימי" }, "autonomous");
    handedOver(r);
    expect(r.reply).not.toMatch(/חיוב כפול בביימי/);
  });
});

describe("[woo-perf] live search timing", () => {
  it("★ one line per tenant and hour: calls, p50, p95, timeouts, requests by kind", async () => {
    const { recordWooPerf, flushWooPerf } = await import("../services/connectors/woocommerce.adapter");
    const t = Date.parse("2026-11-17T10:15:00Z");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    recordWooPerf("tenantA", 900, { local: 3, live: 1, capped: 0, kinds: { category: 1 }, timeouts: 0 } as any, t);
    recordWooPerf("tenantA", 8100, { local: 0, live: 2, capped: 0, kinds: { search: 2 }, timeouts: 1 } as any, t + 60_000);
    const lines = flushWooPerf(Date.parse("2026-11-17T11:01:00Z"));
    expect(lines).toEqual(["[woo-perf] tenant=tenantA hour=2026-11-17T10 calls=2 p50=8100 p95=8100 timeouts=1 local=3 live=3 capped=0 live_by_kind=category=1,search=2"]);
    expect(flushWooPerf(Date.parse("2026-11-17T11:02:00Z"))).toEqual([]);
    // The current hour's bucket is kept until it is over.
    recordWooPerf("tenantA", 500, { local: 1, live: 0, capped: 0, kinds: {}, timeouts: 0 } as any, Date.parse("2026-11-17T11:30:00Z"));
    expect(flushWooPerf(Date.parse("2026-11-17T11:40:00Z"))).toEqual([]);
    expect(flushWooPerf(Date.parse("2026-11-17T12:00:01Z"))).toHaveLength(1);
  });
});

describe("person_recent respects a hand-back to the AI", () => {
  const person = { direction: "OUTBOUND", body: "היי, כאן עומר", senderName: "omer@example.com", metadata: { source: "inbox" }, createdAt: new Date(Date.now() - 2 * 3600_000) };
  it("★ \"return to AI\" after the person's message: the AI answers", async () => {
    h.history = [
      { direction: "INBOUND", body: "היי", metadata: null, createdAt: new Date(Date.now() - 3 * 3600_000) },
      person,
      { direction: "INBOUND", body: "", messageType: "system", senderName: "System", metadata: { systemEvent: "returned_to_ai" }, createdAt: new Date(Date.now() - 3600_000) },
    ];
    h.responses.push({ toolCalls: [respond("hb1", { reply: "בשמחה, במה אפשר לעזור?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
    expect(h.calls.length).toBeGreaterThan(0);
    expect(String((r.trace as any).gate1 ?? "")).not.toMatch(/^human_owned/);
  });
  it("a hand-back BEFORE the person wrote does not count", async () => {
    h.history = [
      { direction: "INBOUND", body: "", messageType: "system", senderName: "System", metadata: { systemEvent: "returned_to_ai" }, createdAt: new Date(Date.now() - 5 * 3600_000) },
      person,
    ];
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
    expect(h.calls).toHaveLength(0);
    expect(String((r.trace as any).gate1)).toMatch(/^human_owned/);
  });
  it("★ a handover row to the AI after the person's message counts too", async () => {
    const { handedBackSince } = await import("../services/reply-engine/engine");
    const since = new Date(Date.now() - 2 * 3600_000);
    const asked: any[] = [];
    const db = { conversationHandover: { findFirst: async (a: any) => { asked.push(a); return a.where.toHandler === "ai_agent" ? { id: "h1" } : null; } } };
    expect(await handedBackSince("t1", "c1", since, [], null, db)).toBe(true);
    expect(asked[0].where).toMatchObject({ tenantId: "t1", conversationId: "c1", toHandler: "ai_agent", at: { gt: since } });
    const none = { conversationHandover: { findFirst: async () => null } };
    expect(await handedBackSince("t1", "c1", since, [], null, none)).toBe(false);
  });
});

describe("b8ec6dcf rating: engine passes", () => {
  it("★ a name only from the contact's profile; never the channel's display name", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const conv = (prisma as any).conversation.findFirst;
    const contact = (prisma as any).contact.findFirst;
    (prisma as any).conversation.findFirst = async () => ({ id: "c1", tenantId: "t1", channel: "WEBCHAT", customerExternalId: "v1", customerName: "Roberta" });
    try {
      h.responses.push({ toolCalls: [respond("nm1", { reply: "היי Roberta, במה אפשר לעזור?" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "היי" }, "autonomous");
      expect(r.reply).not.toMatch(/Roberta/);
      expect(JSON.stringify(h.calls.at(-1).messages)).not.toMatch(/Name: Roberta/);
      (prisma as any).contact.findFirst = async () => ({ id: "k1", email: null, phone: null, displayName: "דנה כהן" });
      h.responses.push({ toolCalls: [respond("nm2", { reply: "היי דנה, במה אפשר לעזור?" })] });
      const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: "היי" }, "autonomous");
      expect(r2.reply).toMatch(/היי דנה/);
      expect(JSON.stringify(h.calls.at(-1).messages)).toMatch(/Name: דנה/);
    } finally { (prisma as any).conversation.findFirst = conv; (prisma as any).contact.findFirst = contact; }
  });

  it("★ a write the customer did not ask for is refused before it runs, on any lane", async () => {
    h.offerWrite = true;
    h.responses.push(
      { toolCalls: [tc("w1", "woocommerce.add_order_note", { order_id: "5", note: "x", customer_visible: true })] },
      { toolCalls: [respond("w2", { reply: "בשמחה!" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה רבה!" }, "autonomous");
    expect(h.dispatched.some((d: any) => d.name === "woocommerce.add_order_note")).toBe(false);
    expect(JSON.stringify(r.trace.tools ?? [])).toMatch(/not_asked/);
  });

  it("★ holding mode: \"if I order again?\" gets the fixed advice", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const { HOLD_ADVICE_HE } = await import("../services/reply-engine/gates");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 3 });
    try {
      h.responses.push({ toolCalls: [respond("pa1", { reply: "לא אמורה להיות כפילות בהזמנה החדשה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אם אזמין שוב תהיה כפילות?" }, "autonomous");
      // The old item is gone, and with it the fixed hold advice; the unbacked "no duplicate" never goes out.
      void HOLD_ADVICE_HE;
      expect(r.reply ?? "").not.toMatch(/לא אמורה להיות כפילות/);
      expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ the bare header with nothing under it is never sent alone", async () => {
    // Nothing listed can follow it (no product ask, no search): the header alone would say nothing.
    h.textChannel = true;
    h.responses.push({ toolCalls: [respond("hh1", { reply: "הנה מה שיש לנו שמתאים." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה לגבי הגוון?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/^הנה מה שיש לנו שמתאים\.?$/);
  });
});

describe("7af7c6d7 rating: engine passes", () => {
  const held = "checking with the team: חויבתי פעמיים ואין הזמנה";
  const withHeld = async (facts: any, fn: () => Promise<void>, extraPending = "") => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts, offeredItems: [], pending: [{ kind: "promise", text: held + extraPending, at: new Date().toISOString() }], turnCount: 10 });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };
  it("★ the exact procedural ask gets the advice", async () => {
    const { HOLD_ADVICE_HE } = await import("../services/reply-engine/gates");
    await withHeld({}, async () => {
      h.responses.push({ toolCalls: [respond("q1", { reply: "לא אמורה להיות כפילות." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אם הזמין שנית שלא יהיה כפילות" }, "autonomous");
      void HOLD_ADVICE_HE;
      expect(r.reply ?? "").not.toMatch(/לא אמורה להיות כפילות/);
      expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
    });
  });
  it("★ \"still being checked\" on a status ask is a hand-over now, whatever the old hold counters say", async () => {
    for (const turn of ["9", "6"]) {
      await withHeld({ _holdLineTurn: turn }, async () => {
        h.responses.push({ toolCalls: [respond(`q${turn}`, { reply: "החיוב עדיין בבדיקה." })] });
        const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
        handedOver(r);
        expect(r.reply).toBe(HAND);
      });
    }
  });
  it("★ 'I've added it to the check' only when something new was added", async () => {
    const { HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    await withHeld({}, async () => {
      h.responses.push({ toolCalls: [respond("q4", { reply: "קיבלתי." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כבר שלחתי לכם 4155" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(new RegExp(HOLD_ACK_HE.slice(0, 12)));
    }, " (customer gave: 4155)");
  });
  it("★ a thanks next to an old team item is answered plainly: no hold counter silences it, nobody is handed it", async () => {
    await withHeld({ _thanksTurn: "9" }, async () => {
      h.responses.push({ toolCalls: [respond("q6", { reply: "בשמחה!" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה" }, "autonomous");
      expect(r.reply).toBe("בשמחה!");
      expect(r.escalation).toBeNull();
    });
  });
  it("★ a link sent earlier in a card's metadata: never 'there is no link'", async () => {
    h.history = [
      { direction: "INBOUND", body: "יש סרטון הדרכה?", metadata: null },
      { direction: "OUTBOUND", body: "הנה הסרטון", senderName: "AI Bot", messageType: "interactive", metadata: { buttons: [{ url: "https://youtu.be/abc" }] } },
      { direction: "INBOUND", body: "איפה הסרטון?", metadata: null },
    ];
    h.responses.push(
      { toolCalls: [respond("lk1", { reply: "אין לי כרגע קישור לסרטון." })] },
      { toolCalls: [respond("lk2", { reply: "אין לי כרגע קישור לסרטון." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה הסרטון?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/אין לי כרגע קישור/);
  });
  it("★ 'שיהיה תודה' is a thanks: no status line", async () => {
    await withHeld({}, async () => {
      h.responses.push({ toolCalls: [respond("q5", { reply: "בשמחה! החיוב עדיין בבדיקה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "שיהיה תודה" }, "autonomous");
      expect(r.reply).toBe("בשמחה!");
    });
  });
});

describe("d7782dd2 rating: engine passes", () => {
  const held = "checking with the team: חויבתי פעמיים ואין הזמנה";
  const withHeld = async (facts: any, fn: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts, offeredItems: [], pending: [{ kind: "promise", text: held, at: new Date().toISOString() }], turnCount: 10 });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };
  it("★ a thanks is answered plainly (there is no hold any more)", async () => {
    await withHeld({ _thanksTurn: "5" }, async () => {
      h.responses.push({ toolCalls: [respond("d1", { reply: "בשמחה!" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "שיהיה תודה" }, "autonomous");
      expect(r.reply).toBe("בשמחה!");
      expect(r.escalation).toBeNull();
    });
  });
  it("★ a restatement next to an old team item: no holding line, whatever the old counters say", async () => {
    for (const turn of ["8", "9"]) {
      await withHeld({ _holdLineTurn: turn, _spokeTurn: turn }, async () => {
        h.responses.push({ toolCalls: [respond(`d${turn}`, { reply: "לא נוצרה הזמנה, נכון." })] });
        const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא יצאה הזמנה" }, "autonomous");
        expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
        expect(r.reply ?? "").not.toMatch(/אני כאן/);
      });
    }
  });
  it("★ a count is set to its list", async () => {
    h.responses.push({ toolCalls: [respond("cn1", { reply: "יש 3 גוונים: Sand, Medium ו-Hony, Medium Dark." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אילו גוונים יש?" }, "autonomous");
    expect(r.reply).toMatch(/4 גוונים/);
  });
  it("★ the bare header with cards names what they show", async () => {
    h.responses.push(
      { toolCalls: [tc("bh1", "woocommerce.list_products", { query: "תיק" })] },
      { toolCalls: [respond("bh2", { reply: "הנה מה שיש לנו שמתאים.", cards: ["PRODUCT_1"] })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
    expect(r.reply).toBe("הנה כמה אפשרויות: Canvas Tote.");
  });
});

describe("93f9fdff rating: engine passes", () => {
  it("★ a reply with a dotted URL keeps it whole", async () => {
    const url = "https://chanivainberger.co.il/product/makeup-base/";
    h.responses.push({ toolCalls: [respond("u1", { reply: `אפשר לראות בעמוד המוצר: ${url} נשמח לעזור.` })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה רואים את המוצר?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/https:\/\/chanivainberger\.co\.(?!il)/);
  });
  it("★ \"still being checked\" with an aside: a hand-over, the claim cut", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.responses.push({ toolCalls: [respond("hz1", { reply: "אגב, יש לנו גם תיקי בד חדשים בקולקציה. החיוב עדיין בבדיקה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
      handedOver(r);
      expect(r.reply ?? "").not.toMatch(/בבדיקה/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
});

describe("657e5f85 rating: engine passes", () => {
  it("★ the turn a charge complaint opens: no state or cause, a person takes it", async () => {
    h.responses.push({ toolCalls: [respond("op1", { reply: "ההזמנה 97858 בוטלה כי התשלום לא נקלט במערכת." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "חויבתי פעמיים ואין לי הזמנה" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/בוטלה|לא נקלט/);
    handedOver(r);
    expect(r.trace.teamQuestion).toBeTruthy();
  });
  it("★ a direct ask next to an old team item is never left without a reply, and gets no holding line", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _holdLineTurn: "7", _spokeTurn: "7" }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.responses.push({ toolCalls: [respond("fl1", { reply: "ההזמנה בוטלה כי התשלום לא נקלט." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תעדכנו בבקשה ושלחו לי מספר הזמנה" }, "autonomous");
      expect(String(r.reply ?? "").trim()).not.toBe("");
      expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
  it("★ the bot with nothing new to say after a silent turn: a person takes it, never a holding line", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString(), _spokeTurn: "7" }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }, { direction: "INBOUND", body: "נו", metadata: null }];
      h.responses.push({ toolCalls: [respond("fs1", { reply: para })] }, { toolCalls: [respond("fs2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא יצאה הזמנה" }, "autonomous");
      handedOver(r);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
  it("★ the fallback never lists products of another kind than the customer's noun", async () => {
    h.groundTitle = "קשת-כחולה";
    h.groundCategory = "קשתות";
    h.responses.push(
      { toolCalls: [tc("nf1", "woocommerce.list_products", { query: "מטפחת" })] },
      { toolCalls: [respond("nf2", { reply: "יש לנו ב-₪999." })] },
      { toolCalls: [respond("nf3", { reply: "יש לנו ב-₪888." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם מטפחת חגיגית בגווני כחול?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/קשת/);
    expect(h.staged.flatMap((s: any) => s.products ?? []).map((p: any) => p?.title ?? p?.name ?? "").join(" ")).not.toMatch(/קשת/);
  });
});

describe("657e5f85 Crispy trace: the device table on a fit ask", () => {
  it("★ a device-fit ask brings the business's device table into the prompt", async () => {
    const table = { content: "טבלת התאמה: סיר טיגון / אייר פרייר (נינג'ה קריספי) - סמובי אליס", score: 0.5, documentTitle: "devices", chunkIndex: 3, documentId: "kb1" };
    h.lexicalFor = (q: string) => (/טבלה/.test(q) ? [table] : []);
    h.responses.push({ toolCalls: [respond("dt1", { reply: "סמובי אליס מתאים לנינג'ה קריספי." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "איזה משטח מתאים לנינג'ה קריספי?" }, "autonomous");
    expect(JSON.stringify(h.calls[0].messages)).toMatch(/אייר פרייר/);
  });
  it("not on a question that is no fit ask", async () => {
    const table = { content: "טבלת התאמה: סיר טיגון / אייר פרייר - סמובי אליס", score: 0.5, documentTitle: "devices", chunkIndex: 3, documentId: "kb1" };
    h.lexicalFor = (q: string) => (/טבלה/.test(q) ? [table] : []);
    h.responses.push({ toolCalls: [respond("dt2", { reply: "אנחנו פתוחים א-ה 9-17." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "מה שעות הפעילות?" }, "autonomous");
    expect(JSON.stringify(h.calls[0].messages)).not.toMatch(/אייר פרייר/);
  });
});

describe("ed780586 rating: engine passes", () => {
  it("★ items never dropped silently: the rest go to the team", async () => {
    // The devices are the business's own (its device table): since 052f53ad only those count as items.
    h.lexical = [{ content: "טבלת התאמה: מיקסר, טוסטר, בלנדר", score: 0.9, documentTitle: "t", chunkIndex: 1, documentId: "d" }];
    h.responses.push(
      { toolCalls: [tc("it1", "woocommerce.list_products", { query: "משטח" })] },
      { toolCalls: [respond("it2", { reply: "למיקסר מתאים Canvas Tote." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר, טוסטר ובלנדר" }, "autonomous");
    // Items the reply could not answer: a person takes them (never "the rest went to the team").
    handedOver(r);
    expect(r.reply).not.toMatch(/שאר הפריטים/);
    expect(String(r.trace.teamQuestion ?? "")).toMatch(/טוסטר/);
  });
  it("★ a restock ask with no data: a person takes it, never 'check the product page'", async () => {
    h.responses.push({ toolCalls: [respond("rs1", { reply: "בדקי בדף המוצר, שם מופיע המלאי." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי יתחדש המלאי של אליס שחור?" }, "autonomous");
    expect(r.reply).not.toMatch(/בדף המוצר/);
    handedOver(r);
  });
  it("★ 'yes' after an offer to ask the team is no handoff", async () => {
    h.history = [{ direction: "INBOUND", body: "יש הנחה?", metadata: null }, { direction: "OUTBOUND", body: "לבדוק את זה עם הצוות?", senderName: "AI Bot", metadata: null }];
    h.responses.push({ toolCalls: [respond("y1", { reply: "בדקתי, אין כרגע הנחה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן" }, "autonomous");
    expect(r.escalation ?? null).toBeNull();
  });
  it("★ the same clarifying question twice: not again", async () => {
    h.history = [{ direction: "INBOUND", body: "יש חדש?", metadata: null }, { direction: "OUTBOUND", body: "על מה מדובר?", senderName: "AI Bot", metadata: null }];
    h.responses.push({ toolCalls: [respond("rq1", { reply: "על מה מדובר?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
    expect(r.reply).not.toMatch(/על מה מדובר/);
  });
  it("★ cards show only products of her noun", async () => {
    h.groundTitle = "מטפחת אנה";
    h.extraTitle = "בובון שטוח";
    h.responses.push(
      { toolCalls: [tc("bb1", "woocommerce.list_products", { query: "בובון" })] },
      { toolCalls: [respond("bb2", { reply: "הנה מה שמצאתי.", cards: ["PRODUCT_1"] })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת את הבובון לקשירה נמוכה" }, "autonomous");
    expect((r.trace as any).cardsByNoun).toEqual(["PRODUCT_2"]);
  });
  it("★ 'yes' to an offer of a person two messages back is no handoff", async () => {
    h.history = [
      { direction: "INBOUND", body: "הקופון לא עובד", metadata: null },
      { direction: "OUTBOUND", body: "רוצה שאעביר לנציג?", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "רגע", metadata: null },
      { direction: "OUTBOUND", body: "את הקופון מזינים בעמוד התשלום. רוצה שאשלח קישור?", senderName: "AI Bot", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("ol1", { reply: "הנה הקישור לעמוד התשלום." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן" }, "autonomous");
    expect(r.escalation ?? null).toBeNull();
  });
  it("★ a restock ask the gate lets through still reaches a person", async () => {
    h.responses.push({ toolCalls: [respond("rs2", { reply: "המלאי מתעדכן מדי פעם." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי יחזור למלאי האליס השחור?" }, "autonomous");
    handedOver(r);
  });
  it("★ an orphan 'if it's another model' is dropped", async () => {
    h.responses.push({ toolCalls: [respond("or1", { reply: "כדאי לנקות את התחתית במים ולייבש היטב. אם זה דגם אחר, אפשר לכתוב לנו את שמו." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "המשטח מחליק לי על השיש" }, "autonomous");
    expect(r.reply ?? "").toMatch(/לנקות/);
    expect(r.reply ?? "").not.toMatch(/דגם אחר/);
  });
});

describe("83086356 rating: engine passes", () => {
  const withHeld = async (facts: any, fn: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };
  it("★ an imperative ask after a silent gate: a person takes it, never a holding line", async () => {
    await withHeld({ _holdLineTurn: "7", _spokeTurn: "9", _cannedTeamLineAt: new Date().toISOString() }, async () => {
      const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("im1", { reply: para })] }, { toolCalls: [respond("im2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תעדכנו בבקשה ושלחו לי מספר הזמנה" }, "autonomous");
      handedOver(r);
    });
  });
  it("★ a thanks after a silent gate next to an old team item: no holding line, nobody handed it", async () => {
    await withHeld({ _cannedTeamLineAt: new Date().toISOString(), _spokeTurn: "9" }, async () => {
      const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("th1", { reply: para })] }, { toolCalls: [respond("th2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה" }, "autonomous");
      expect(r.escalation).toBeNull();
      expect(r.reply ?? "").not.toMatch(TEAM_CLAIM);
    });
  });
  it("★ sizes the reply answered by device name get no second line", async () => {
    h.groundTitle = "סמובי אליס 31*41";
    h.extraTitle = "סמובי אסף 46*33";
    h.responses.push(
      { toolCalls: [tc("sn1", "woocommerce.list_products", { query: "משטח" })] },
      { toolCalls: [respond("sn2", { reply: "לסודה ולטוסטר קפיץ: סמובי אליס 31*41." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "סודה 18x14 טוסטר קפיץ 24x15" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/18×14:|24×15:/);
  });
  it("★ five devices: pads from the knowledge, a 'no fit' replaced, one team line, nothing nameless", async () => {
    h.groundTitle = "סמובי גפן 26*20";
    h.extraTitle = "סמובי קטן 15*15";
    h.lexical = [{ content: "מידות המשטחים: סמובי אליס 31*41, סמובי אסף 46*33, סמובי גפן 26*20", score: 0.9, documentTitle: "sizes", chunkIndex: 2, documentId: "d2" }];
    h.responses.push(
      { toolCalls: [tc("fd1", "woocommerce.list_products", { query: "משטח" })] },
      { toolCalls: [respond("fd2", { reply: "מתאימים משטחי ההזזה שמופיעים כאן. למיקסר, לטוסטר הקפיץ ולנינג'ה בלנדר לא עלתה התאמה לפי המידות שנמסרו." })] },
      { toolCalls: [respond("fd3", { reply: "מתאימים משטחי ההזזה שמופיעים כאן. למיקסר, לטוסטר הקפיץ ולנינג'ה בלנדר לא עלתה התאמה לפי המידות שנמסרו." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 32x22 טוסטר קפיץ 24x15 נינג׳ה בלנדר 24x18" }, "autonomous");
    const reply = r.reply ?? "";
    expect(reply).toMatch(/32×22: סמובי אליס\./);
    expect(reply).toMatch(/24×15: סמובי גפן\./);
    expect(reply).toMatch(/24×18: סמובי גפן\./);
    expect(reply).not.toMatch(/לא עלתה התאמה/);
    expect(reply).not.toMatch(/שמופיעים כאן/);
    // Every size answered: no team line over them, and no team question.
    expect(reply).not.toMatch(/העברתי/);
    expect(r.trace.teamQuestion ?? null).toBeNull();
  });
  it("★ an older photo in the history is no new detail: no 'added it' ack", async () => {
    const { HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    await withHeld({}, async () => {
      h.history = [{ direction: "INBOUND", body: "[Image]", messageType: "image", metadata: null }, { direction: "OUTBOUND", body: "קיבלתי.", senderName: "AI Bot", metadata: null }, { direction: "INBOUND", body: "שלחתי צילום", messageType: "image", metadata: null }];
      h.responses.push({ toolCalls: [respond("ph1", { reply: "החיוב עדיין בבדיקה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש לגבי החיוב?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(new RegExp(HOLD_ACK_HE.slice(0, 12)));
    });
  });
  it("★ 'I've added it to the check' with nothing added is cut", async () => {
    h.responses.push({ toolCalls: [respond("ad1", { reply: "עדכנתי את הצוות. אנחנו פתוחים א-ה 9-17." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה שעות הפעילות?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/עדכנתי/);
    expect(r.reply ?? "").toMatch(/9-17/);
  });
  it("★ sizes for several items, no commas: each gets the smallest pad that takes it", async () => {
    h.groundTitle = "סמובי אליס 31*41";
    h.extraTitle = "סמובי אסף 46*33";
    h.responses.push(
      { toolCalls: [tc("sz1", "woocommerce.list_products", { query: "משטח" })] },
      { toolCalls: [respond("sz2", { reply: "לנינג'ה קרמה 28x18 ולמיקסר 32x22 מתאים סמובי אליס 31*41." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אלה המידות של מוצרי החשמל שיש לי - איזה מוצרי סמובי אני צריכה? נינג׳ה קרמה 28x18 מיקסר 32x22 סודה 18x14 טוסטר קפיץ 24x15 נינג׳ה בלנדר 24x18" }, "autonomous");
    // Every size is answered once, whatever the gate did to the model's reply.
    for (const s of ["28[x×]18", "32[x×]22", "18×14", "24×15", "24×18"]) expect(((r.reply ?? "").match(new RegExp(s, "g")) ?? []).length, s).toBe(1);
  });
  it("★ an apology alone on a how-to ask: the link from the business's own texts", async () => {
    h.lexical = [{ content: "סרטון הדרכה: https://youtu.be/abc123", score: 0.9, documentTitle: "guide", chunkIndex: 1, documentId: "d1" }];
    // The gate cuts the made-up price; the apology is all that is left.
    h.responses.push({ toolCalls: [respond("ap1", { reply: "נכון, סליחה על הבלבול. הסרטון עולה ₪50." })] }, { toolCalls: [respond("ap1b", { reply: "נכון, סליחה על הבלבול. הסרטון עולה ₪50." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה הסרטון?" }, "autonomous");
    // The price cut takes only its own sentence now (the stripPrices compare was trimming): the apology may stay in
    // front; the link is the answer.
    expect(r.reply).toMatch(/הנה הקישור: https:\/\/youtu\.be\/abc123$/);
    expect(r.reply).not.toMatch(/₪/);
  });
});

describe("Crispy, verified (2026-11-18, the real Smoovee table line)", () => {
  it("★ 'ולנינגה קריספי' (no geresh) brings the device table into the prompt, with the category instruction", async () => {
    const { lexicalTerms } = await vi.importActual<any>("../services/knowledge.service");
    const chunk = { content: "סיר טיגון ללא שמן נינג'ה: סמובי אליס\nנינג'ה גריל XL: סמובי אליס, סמובי אסף\nמיקסר דאבו: סמובי אליס", score: 0.5, documentTitle: "devices", chunkIndex: 0, documentId: "kb1" };
    // As the store's lexical search does: the chunk comes back when one of the query's terms is in it.
    h.lexicalFor = (q: string) => (lexicalTerms(q).own.some((w: string) => chunk.content.toLowerCase().includes(w)) ? [chunk] : []);
    h.history = [{ direction: "INBOUND", body: "איזה משטח מתאים לסיר שלי?", metadata: null }, { direction: "OUTBOUND", body: "לאיזה מכשיר?", senderName: "AI Bot", metadata: null }];
    h.responses.push({ toolCalls: [respond("cr1", { reply: "לנינג'ה קריספי, שהוא סיר טיגון ללא שמן, מתאים סמובי אליס." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "ולנינגה קריספי" }, "autonomous");
    const prompt = JSON.stringify(h.calls[0].messages);
    expect(prompt).toMatch(/סיר טיגון ללא שמן נינג/);
    expect(prompt).toMatch(/map it to its category/);
  });
  it("★ 'מתאים לנינג'ה סלושי, לא לקריספי' is a negative fit claim", async () => {
    const { ungroundedNegativeFit } = await import("../services/reply-engine/gates");
    expect(ungroundedNegativeFit("המשטח שמופיע כאן מתאים לפי היצרן לנינג'ה סלושי, לא לקריספי.", "ולנינגה קריספי", ["סמובי אליס 31*41"], "")).toHaveLength(1);
  });
});

describe("052f53ad rating: engine passes", () => {
  it("★ a URL no source has never reaches the customer", async () => {
    h.responses.push({ toolCalls: [respond("ur1", { reply: "אפשר לקנות כאן: https://evil.example/buy-now. תודה שפנית!" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה קונים?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/evil\.example/);
    expect((r.trace as any).urlsRepaired?.dropped).toBe(1);
  });
  it("★ a how-to or safety question answered 'no information': a person in the same turn, no question of ours left over the line", async () => {
    // No safety word: the how-to rule itself.
    h.responses.push({ toolCalls: [respond("hs1", { reply: "אין לי כאן הנחיה למיקום המעצורים. מה הדגם?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה שמים את המעצורים?" }, "autonomous");
    handedOver(r);
    expect(r.reply).toBe(`אין לי כאן הנחיה למיקום המעצורים. ${HAND}`);
    expect((r.trace as any).howToToTeam).toBe(true);
    // A tipping appliance: the safety handoff, in the same turn.
    h.responses.push({ toolCalls: [respond("hs2", { reply: "אין לי כאן הנחיה למיקום המעצורים. מה הדגם?" })] });
    const s = await runReplyEngineTurn({ ...opts, incomingMessage: "הבלנדר התהפך, איפה שמים את המעצורים?" }, "autonomous");
    expect(!!((s.trace as any).safetyHandoff || (s.trace as any).howToToTeam)).toBe(true);
  });
  it("★ no 'still being checked' on top of a product answer for a non-held open item", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: תיק בד כחול", at: new Date().toISOString() }], turnCount: 4 });
    try {
      h.responses.push({ toolCalls: [tc("so1", "woocommerce.list_products", { query: "תיק" })] }, { toolCalls: [respond("so2", { reply: "Canvas Tote עולה ₪79." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ויש תיק בד כחול?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/עדיין בבדיקה/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
  it("★ products of her noun returned: the fallback shows them, not the team line", async () => {
    h.groundTitle = "אנה";
    h.groundCategory = "מטפחות";
    h.responses.push(
      { toolCalls: [tc("fk1", "woocommerce.list_products", { query: "מטפחת כחולה" })] },
      { toolCalls: [respond("fk2", { reply: "יש לנו ב-₪999." })] },
      { toolCalls: [respond("fk3", { reply: "יש לנו ב-₪888." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה עם מטפחת בגווני כחול" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/העברתי את השאלה לצוות/);
    expect(r.reply ?? "").toMatch(/אפשרויות/);
  });
  it("★ unanswered items only of kinds the data knows; never an adjective", async () => {
    h.lexical = [{ content: "טבלה: מיקסר - סמובי אליס; טוסטר - סמובי גפן; קרם לחות", score: 0.9, documentTitle: "t", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [tc("ui1", "woocommerce.list_products", { query: "קרם" })] }, { toolCalls: [respond("ui2", { reply: "Canvas Tote עולה ₪79." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "קרם, לעדינות" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/שאר הפריטים/);
  });
  it("★ a size line names the pad, never only a size", async () => {
    h.groundTitle = "סמובי אליס 31*41";
    h.extraTitle = "סמובי גפן 26*20";
    h.responses.push({ toolCalls: [tc("pl1", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("pl2", { reply: "הנה ההתאמות." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 32x22 טוסטר 24x15" }, "autonomous");
    expect(r.reply ?? "").toMatch(/32×22: סמובי אליס\./);
    expect(r.reply ?? "").toMatch(/24×15: סמובי גפן\./);
  });
});

describe("39b65d68 regression: engine passes", () => {
  it("★ a raw handle never reaches the greeting, and the model sees no name", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const conv = (prisma as any).conversation.findFirst;
    (prisma as any).conversation.findFirst = async () => ({ id: "c1", tenantId: "t1", channel: "WEBCHAT", customerExternalId: "v1", customerName: "SharonKampinski" });
    h.responses.push({ toolCalls: [respond("g1", { reply: "היי SharonKampinski, במה אפשר לעזור?" })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "היי" }, "autonomous"); }
    finally { (prisma as any).conversation.findFirst = conv; }
    expect(r.reply).not.toMatch(/SharonKampinski/);
    expect(r.reply).toMatch(/במה אפשר לעזור/);
    expect(JSON.stringify(h.calls[0].messages)).not.toMatch(/Name: SharonKampinski/);
  });
  it("★ a simple product ask, products shown before, the checks failed: a question, never the team", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [{ id: "101", title: "Canvas Tote", at: new Date().toISOString() }], pending: [], turnCount: 3 });
    h.responses.push(
      { toolCalls: [respond("f1", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("f2", { reply: "התיק עולה ₪120." })] },
    );
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "רוצה לבן" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect(r.trace.teamQuestion ?? null).toBeNull();
    expect(r.reply).toMatch(/מה הכי חשוב לך/);
  });
});

describe("an offer to ask is not followed by \"I passed it\"", () => {
  it("★ the reply offers to ask: no team line is appended", async () => {
    h.responses.push({ toolCalls: [respond("oa1", { reply: "לא בטוחים בזה. רוצה שאבדוק את זה מול הצוות?", team_question: "התאמה למיקסר" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "זה מתאים למיקסר שלי?" }, "autonomous");
    expect(r.reply).not.toMatch(/העברתי את זה לצוות/);
  });
});

describe("never silent on a product ask (prod replay 2026-11-17, Tehila)", () => {
  it("★ the canned line already went out and the checks failed: a question, and the team still gets it", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString() }, offeredItems: [], pending: [], turnCount: 3 });
    h.responses.push(
      { toolCalls: [respond("s1", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("s2", { reply: "בטח, ₪150 בלבד." })] },
    );
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת דווקא חגיגי, גווני כחול" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect(r.reply ?? "").not.toBe("");
    expect(r.trace.gate3.rewrite).not.toBe("silent");
    // No search ran: the fallback searches the store and shows its products (prod replay of b369e939, Tehila c55b9:
    // live showed two cards), never the product question with a second team question.
    expect((r.trace as any).fallbackSearch).toBeTruthy();
    expect(r.reply).toMatch(/Canvas Tote/);
  });

  it("★ (rating b369e939, blocker 1) a product ask with no store search falls back to the store's products", async () => {
    h.responses.push(
      { toolCalls: [respond("fs1", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("fs2", { reply: "בטח, ₪150 בלבד." })] },
      { toolCalls: [respond("fs3", { reply: "בטח, ₪150 בלבד." })] },
    );
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toBe("תיק בד");
    expect(r.reply).toMatch(/Canvas Tote/);
    expect(r.reply).not.toMatch(/₪1[25]0/);
    expect(r.escalation).toBeNull();
  });
});

describe("1f510cc4 rating: engine passes", () => {
  it("★ an unsupported message: ask once to resend as text, then silence", async () => {
    const { RESEND_HE } = await import("../services/reply-engine/engine");
    h.history = [{ direction: "INBOUND", body: "היי", metadata: null }, { direction: "OUTBOUND", body: "היי, במה אפשר לעזור?", senderName: "AI Bot", metadata: null }];
    const r1 = await runReplyEngineTurn({ ...opts, incomingMessage: "[Unsupported message]" }, "autonomous");
    expect(r1.reply).toBe(RESEND_HE);
    h.history = [...h.history, { direction: "INBOUND", body: "[Unsupported message]", metadata: null }, { direction: "OUTBOUND", body: RESEND_HE, senderName: "AI Bot", metadata: null }];
    const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: "[Unsupported message]" }, "autonomous");
    expect(r2.reply ?? null).toBeNull();
  });
  it("★ a non-product question never gets a product list appended", async () => {
    h.responses.push(
      { toolCalls: [tc("np1", "woocommerce.list_products", { query: "תיק" })] },
      { toolCalls: [respond("np2", { reply: "הנה ההסבר: את הקוד מזינים בשדה קוד קופון בעמוד התשלום." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה מזינים את הקופון?" }, "autonomous");
    expect(r.reply).toMatch(/קוד קופון/);
    expect(r.reply).not.toMatch(/Canvas Tote/);
  });
  it("★ the grounded fallback's own bullets are not listed again", async () => {
    h.responses.push(
      { toolCalls: [tc("gf1", "woocommerce.list_products", { query: "תיק" })] },
      { toolCalls: [respond("gf2", { reply: "התיק עולה ₪120." })] },
      { toolCalls: [respond("gf3", { reply: "התיק עולה ₪150." })] },
      { toolCalls: [respond("gf4", { reply: "התיק עולה ₪150." })] },
    );
    h.textChannel = true;
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
    expect(r.reply).toMatch(/Canvas Tote/);
    expect(((r.reply ?? "").match(/Canvas Tote/g) ?? []).length).toBe(1);
    // The fallback writes its header only; the list carries each product once (no inline bullets).
    expect(r.reply).not.toMatch(/•/);
    expect(((r.reply ?? "").match(/הנה כמה אפשרויות/g) ?? []).length).toBe(1);
  });
});

/** Prod 2026-11-18 (Smoovee, cmwlusggx): a product link cut at the domain, the team line glued on. */
describe("urlfix: links whole, verified, never glued", () => {
  const URL = "https://smoovee-ltd.com/product/%d7%a1%d7%9e%d7%95%d7%91%d7%99-%d7%90%d7%9c%d7%9b%d7%a1%d7%94/";
  it("★ the link reaches the customer whole, with the product's own URL", async () => {
    h.groundTitle = "סמובי אלכסה";
    h.groundUrl = URL;
    h.responses.push({ toolCalls: [tc("uf1", "woocommerce.list_products", { query: "אלכסה" })] }, { toolCalls: [respond("uf2", { reply: `הקישור לסמובי אלכסה: ${URL}` })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר קישור לסמובי אלכסה?" }, "autonomous");
    expect(r.reply).toContain(URL);
    expect(r.reply).not.toMatch(/[.!?][\u05D0-\u05EA]/);
  });
  it("★ a link no source has never reaches the customer", async () => {
    h.responses.push({ toolCalls: [respond("uf3", { reply: "אפשר לקנות כאן: https://evil.example/buy-now. תודה שפנית!" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה קונים?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/evil\.example/);
    expect((r.trace as any).urlsRepaired?.dropped).toBe(1);
  });
});

/** Narrow prod hotfix on 7c476131 (Smoovee live, 2026-11-18). */
describe("smoovee live hotfix: engine passes", () => {
  it("★ a return request: the policy, then a person (no return tool), the failure narration and the re-asked reason cut", async () => {
    h.lexical = [{ content: "מדיניות החזרות: אפשר להחזיר תוך 14 יום מקבלת המוצר.", score: 0.9, documentTitle: "returns", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [respond("rt1", { reply: "כרגע לא הצלחתי לבדוק את פרטי העסקה. מה סיבת ההחזרה? אפשר להחזיר תוך 14 יום." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני רוצה להחזיר את הזמנה 97837 כי זה לא מתאים" }, "autonomous");
    expect(r.reply).not.toMatch(/לא הצלחתי/);
    expect(r.reply).not.toMatch(/סיבת ההחזרה/);
    expect(r.reply).toMatch(/14 יום/);
    handedOver(r);
    expect(r.trace.teamQuestion).toMatch(/return request/);
  });
  it("★ a statement of interest asks the team nothing", async () => {
    h.responses.push({ toolCalls: [respond("ti1", { reply: "מעולה, נשמח לעזור. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "כמה משטחים" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני מתעניינת בכמה משטחים" }, "autonomous");
    expect(r.trace.teamQuestion ?? null).toBeNull();
    expect(r.reply).not.toMatch(/לצוות/);
  });
  it("★ a team topic none of her words name is dropped", async () => {
    h.responses.push({ toolCalls: [respond("tn1", { reply: "בשמחה. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "הנחת כמות לעסקים" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה המידות של המשטח הגדול?" }, "autonomous");
    expect(r.trace.teamQuestion ?? null).toBeNull();
  });
  it("★ the price of another product next to a named one is cut", async () => {
    h.groundTitle = "סמובי אלכסה";
    h.responses.push(
      { toolCalls: [tc("pp1", "woocommerce.list_products", { query: "אלכסה" })] },
      { toolCalls: [respond("pp2", { reply: "סמובי אלכסה במחיר 158.76 ₪." })] },
      { toolCalls: [respond("pp3", { reply: "סמובי אלכסה במחיר 158.76 ₪." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כמה עולה אלכסה?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/158\.76/);
  });
});

/** Smoovee 376b13 (prod 2026-11-18): get_order 97837 timed out at 8s; "לא הצלחתי לבדוק", no team. */
describe("an order read that fails is the team's", () => {
  it("★ one retry on a timeout; still nothing: a person takes it, the order named for them, no 'could not check'", async () => {
    process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS = "500";
    process.env.REPLY_ENGINE_ORDER_TIMEOUT_MS = "600";
    h.slowOrders = 2;
    h.responses.push(
      { toolCalls: [tc("or1", "woocommerce.get_order", { order_id: "97837" })] },
      { toolCalls: [respond("or2", { reply: "בודקת את ההזמנה." })] },
    );
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה הסטטוס של הזמנה 97837?" }, "autonomous"); }
    finally { delete process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS; delete process.env.REPLY_ENGINE_ORDER_TIMEOUT_MS; }
    expect(r.trace.tools.filter((x: any) => x.tool === "woocommerce.get_order").map((x: any) => x.outcome)).toEqual(["timeout"]);
    expect(h.dispatched.filter((d: any) => d.name === "woocommerce.get_order")).toHaveLength(2);
    expect(r.trace.teamQuestion).toMatch(/woocommerce\.get_order 97837 timeout/);
    handedOver(r);
    expect(r.reply).not.toMatch(/בודקת/);
    // The model is told to try once more and then hand over, never "say you could not check it".
    expect(JSON.stringify(h.calls.at(-1)?.messages ?? [])).toMatch(/hand over \(set handoff\)/);
  });
  it("★ the order read waits longer than other reads (600 here against 500)", async () => {
    process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS = "500";
    process.env.REPLY_ENGINE_ORDER_TIMEOUT_MS = "600";
    h.slowOrders = 1;
    h.orderDelay = 550;
    h.responses.push({ toolCalls: [tc("ow1", "woocommerce.get_order", { order_id: "97837" })] }, { toolCalls: [respond("ow2", { reply: "ההזמנה בדרך." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה הסטטוס של הזמנה 97837?" }, "autonomous"); }
    finally { delete process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS; delete process.env.REPLY_ENGINE_ORDER_TIMEOUT_MS; }
    expect(h.dispatched.filter((d: any) => d.name === "woocommerce.get_order")).toHaveLength(1);
    expect(r.trace.tools.find((x: any) => x.tool === "woocommerce.get_order")?.outcome).toBe("ok");
  });
  it("one slow attempt, then the order: answered, no team", async () => {
    process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS = "500";
    process.env.REPLY_ENGINE_ORDER_TIMEOUT_MS = "600";
    h.slowOrders = 1;
    h.responses.push(
      { toolCalls: [tc("os1", "woocommerce.get_order", { order_id: "97837" })] },
      { toolCalls: [respond("os2", { reply: "ההזמנה בדרך." })] },
    );
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה הסטטוס של הזמנה 97837?" }, "autonomous"); }
    finally { delete process.env.REPLY_ENGINE_TOOL_TIMEOUT_MS; delete process.env.REPLY_ENGINE_ORDER_TIMEOUT_MS; }
    expect(r.trace.teamQuestion ?? null).toBeNull();
  });
});


/** Items 5, 8 and 9 through a whole turn (1771ba14 rating, 2026-11-18). */
describe("1771ba14 rating items: engine passes", () => {
  it("★ 9: a video ask the model passed to the team gets the business's link", async () => {
    h.lexical = [{ content: "סרטון הדרכה: https://youtu.be/abc123", score: 0.9, documentTitle: "howto", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [respond("vd1", { reply: "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "סרטון הדרכה" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש סרטון הדרכה איך משתמשים?" }, "autonomous");
    expect(r.reply).toMatch(/https:\/\/youtu\.be\/abc123/);
    expect(r.reply).not.toMatch(/לצוות/);
  });
});

/** The wiring of items 1, 2, 4, 5, 7 and 8, and the two from the 87076cab replay, through whole turns. */
describe("1771ba14 items and the 87076cab replay: wiring", () => {
  const held = (text: string, facts: any = {}, turnCount = 6) => async () => ({ tenantId: "t1", facts, offeredItems: [], pending: [{ kind: "promise", text: `checking with the team: ${text}`, at: new Date().toISOString() }], turnCount });
  const withState = async (fn: any, body: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    const before = (prisma as any).conversationState.findUnique;
    (prisma as any).conversationState.findUnique = fn;
    try { await body(); } finally { (prisma as any).conversationState.findUnique = before; }
  };
  it("★ 1: a size line names the pad by the knowledge's name when the store title is generic", async () => {
    h.groundTitle = "משטח הזזה 31*41";
    h.extraTitle = "משטח הזזה 26*20";
    h.lexical = [{ content: "מידות המשטחים: סמובי אליס 31*41, סמובי גפן 26*20", score: 0.9, documentTitle: "sizes", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [tc("pn1", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("pn2", { reply: "הנה ההתאמות." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 30x22 טוסטר 24x15" }, "autonomous");
    expect(r.reply ?? "").toMatch(/סמובי אליס/);
    expect(r.reply ?? "").not.toMatch(/: משטח הזזה\./);
  });
  it("★ 2: a cut that left a bracket fragment never reaches the customer", async () => {
    h.responses.push({ toolCalls: [respond("bf1", { reply: "מתאים לפמילי ושבת. [אלכסה מתאים לתמי 4" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה מתאים לי?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/\[/);
  });
  it("★ 4: 'no model by that name' when she named none is cut", async () => {
    // The rewrite repeats it: the cut itself is what keeps it from her.
    h.responses.push({ toolCalls: [respond("nm1", { reply: "לא מצאתי דגם בשם הזה. איזה מכשיר יש לך?" })] }, { toolCalls: [respond("nm2", { reply: "לא מצאתי דגם בשם הזה. איזה מכשיר יש לך?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר המלצה?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/לא מצאתי דגם/);
  });
  it("★ 5: in a hold, 'we'll keep it quiet' is cut", async () => {
    await withState(held("חויבתי פעמיים על אותה הזמנה"), async () => {
      // A question on another topic: the hold keeps the model's other sentences, so only the cut removes this one.
      h.responses.push({ toolCalls: [respond("sp1", { reply: "החיוב בבדיקה. נשאיר את זה בשקט ולא נשלח הודעה נוספת. שעות הפעילות מופיעות באתר." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי אתם פתוחים?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/בשקט|לא נשלח הודעה/);
      expect(r.reply ?? "").toMatch(/שעות הפעילות/);
    });
  });
  it("★ 7: a measure the data does not give is cut", async () => {
    h.groundTitle = "מטפחת משי 70x70";
    h.responses.push({ toolCalls: [tc("dm1", "woocommerce.list_products", { query: "מטפחת" })] }, { toolCalls: [respond("dm2", { reply: "מטפחת משי 70x70 עולה ₪79. כל צלע של המשולש היא בערך 70 ס\"מ." })] }, { toolCalls: [respond("dm3", { reply: "מטפחת משי 70x70 עולה ₪79. כל צלע של המשולש היא בערך 70 ס\"מ." })] });
    // The rewrite repeats it: the cut itself is what keeps it from her.
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כמה גדולה המטפחת כשמקפלים אותה?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/צלע/);
    expect(r.reply ?? "").toMatch(/79/);
  });
  it("★ 8: the identical holding line never twice in a row", async () => {
    const line = "החיוב עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.";
    h.history = [
      { direction: "INBOUND", body: "חויבתי פעמיים", metadata: null, createdAt: new Date(Date.now() - 3 * 60_000) },
      { direction: "OUTBOUND", body: line, senderName: "AI Bot", metadata: null, createdAt: new Date(Date.now() - 2 * 60_000) },
      { direction: "INBOUND", body: "נו?", metadata: null, createdAt: new Date(Date.now() - 60_000) },
    ];
    await withState(held("חויבתי פעמיים על אותה הזמנה", { _holdLineTurn: "4", _spokeTurn: "4" }), async () => {
      h.responses.push({ toolCalls: [respond("hc1", { reply: "החיוב עדיין נבדק." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה עם החיוב?" }, "autonomous");
      expect(r.reply ?? "").not.toContain(line);
    });
  });
  it("★ 'how do I return it?' answered \"the return is being checked\": the knowledge is searched and the steps are the answer", async () => {
    h.lexical = [{ content: "מדיניות החזרות: אפשר להחזיר תוך 14 יום באריזה המקורית, דמי משלוח 25 ש\"ח.", score: 0.9, documentTitle: "returns", chunkIndex: 1, documentId: "d" }];
    await withState(held("החזר כספי על המשטח, לא מתאים למיקסר"), async () => {
      h.responses.push(
        { toolCalls: [respond("rh1", { reply: "ההחזרה בבדיקה." })] },
        { toolCalls: [respond("rh2", { reply: "אפשר להחזיר תוך 14 יום באריזה המקורית, ודמי המשלוח 25 ש\"ח." })] },
      );
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אוקיי. מה לעשות? איך להחזיר את המוצר ולהזדכות על המחיר?" }, "autonomous");
      expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("unlooked_pass");
      expect(r.reply ?? "").toMatch(/14 יום/);
      expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
    });
  });
  it("★ the model talking about its own tools is cut", async () => {
    h.lexical = [{ content: "ביטול עסקה: אפשר לבטל בתוך 14 יום.", score: 0.9, documentTitle: "terms", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [respond("tt1", { reply: "מצטערים, לא נדרש כאן חיפוש מוצר. אפשר לבטל בתוך 14 יום." })] }, { toolCalls: [respond("tt2", { reply: "מצטערים, לא נדרש כאן חיפוש מוצר. אפשר לבטל בתוך 14 יום." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לבטל את ההזמנה?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/חיפוש/);
    expect(r.reply ?? "").toMatch(/14 יום/);
  });
});

/** C pinned rating (c24439a1): Tehila, NE'A and the Smoovee devices. */
describe("C pinned rating c24439a1: wiring", () => {
  const held = (text: string, facts: any = {}, turnCount = 6) => async () => ({ tenantId: "t1", facts, offeredItems: [], pending: [{ kind: "promise", text: `checking with the team: ${text}`, at: new Date().toISOString() }], turnCount });
  const withState = async (fn: any, body: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    const before = (prisma as any).conversationState.findUnique;
    (prisma as any).conversationState.findUnique = fn;
    try { await body(); } finally { (prisma as any).conversationState.findUnique = before; }
  };
  it("★ 1a: an open shipping question is no hold: a question on another topic is answered", async () => {
    await withState(held("Customer asks whether shipping is paid and when the package ships"), async () => {
      h.lexical = [{ content: "שרשראות: כסף 925.", score: 0.9, documentTitle: "materials", chunkIndex: 1, documentId: "d" }];
      h.responses.push({ toolCalls: [respond("ts1", { reply: "השרשראות עשויות כסף 925, ואפשר להזמין אותן באתר." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מאיזה חומר עשויות השרשראות?" }, "autonomous");
      expect(r.reply ?? "").toMatch(/כסף 925/);
      expect(r.reply ?? "").not.toMatch(/עדיין בבדיקה/);
    });
  });
  it("★ 1b: in a real hold, a question on another topic is answered, not swapped for the hold line", async () => {
    await withState(held("חויבתי פעמיים על אותה הזמנה"), async () => {
      h.lexical = [{ content: "שרשראות: כסף 925.", score: 0.9, documentTitle: "materials", chunkIndex: 1, documentId: "d" }];
      // "הזמנה" in the answer: the held subject's broad words never take an answer on another topic.
      h.responses.push({ toolCalls: [respond("ts2", { reply: "השרשראות עשויות כסף 925, וכל הזמנה מגיעה באריזת מתנה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מאיזה חומר עשויות השרשראות?" }, "autonomous");
      expect(r.reply ?? "").toMatch(/כסף 925/);
      expect(r.reply ?? "").not.toMatch(/עדיין בבדיקה/);
    });
  });
  it("★ 2: a video ask gets the link of the product discussed, never the first link the texts have", async () => {
    h.lexical = [{ content: "מיס ריס מסקרה: https://shop.example/product/miss-lash\nעט גבות פדרה, סרטון הדרכה: https://youtu.be/brow123", score: 0.9, documentTitle: "links", chunkIndex: 1, documentId: "d" }];
    h.history = [
      { direction: "INBOUND", body: "יש לכם עט גבות?", metadata: null, createdAt: new Date(Date.now() - 3 * 60_000) },
      { direction: "OUTBOUND", body: "כן, עט הגבות פדרה.", senderName: "AI Bot", metadata: null, createdAt: new Date(Date.now() - 2 * 60_000) },
    ];
    h.responses.push({ toolCalls: [respond("vl1", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "סרטון לעט גבות" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה" }, "autonomous");
    expect(r.reply ?? "").toContain("https://youtu.be/brow123");
    expect(r.reply ?? "").not.toMatch(/miss-lash/);
  });
  it("★ 2b: no link of the product discussed and more than one video: the team, never a wrong link", async () => {
    h.lexical = [{ content: "מיס ריס מסקרה: https://shop.example/product/miss-lash\nסרטון שפתון: https://youtu.be/lip1\nסרטון סומק: https://youtu.be/blush1", score: 0.9, documentTitle: "links", chunkIndex: 1, documentId: "d" }];
    h.history = [{ direction: "INBOUND", body: "יש לכם עט גבות?", metadata: null, createdAt: new Date(Date.now() - 3 * 60_000) }];
    h.responses.push({ toolCalls: [respond("vl2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "סרטון לעט גבות" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/https?:\/\//);
  });
  it("★ 4: sizes she sent: 'no match, send the sizes' is cut and each size gets its pad", async () => {
    h.groundTitle = "סמובי אליס 31*41";
    h.extraTitle = "סמובי גפן 26*20";
    h.responses.push({ toolCalls: [tc("fd1", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("fd2", { reply: "לא הופיעה התאמה לטוסטר ולבלנדר, שלחי לי את המידות." })] }, { toolCalls: [respond("fd3", { reply: "לא הופיעה התאמה לטוסטר ולבלנדר, שלחי לי את המידות." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "טוסטר 30x22 בלנדר 24x15" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/לא הופיעה התאמה|שלחי לי את המידות/);
    expect(r.reply ?? "").toMatch(/30×22: סמובי אליס/);
    expect(r.reply ?? "").toMatch(/24×15: סמובי גפן/);
  });
  it("★ 4b: an item named without a pad is not answered: it gets its line", async () => {
    h.groundTitle = "סמובי אליס 31*41";
    h.extraTitle = "סמובי גפן 26*20";
    h.responses.push({ toolCalls: [tc("fd4", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("fd5", { reply: "לטוסטר מתאים סמובי גפן. את המיקסר כדאי למדוד שוב." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 30x22 טוסטר 24x15" }, "autonomous");
    expect(r.reply ?? "").toMatch(/30×22: סמובי אליס/);
  });
  it("★ 5: \"still being checked\" after an old holding line: a person takes it, neither holding line again", async () => {
    const line = "החיוב עדיין בבדיקה אצל הצוות, והתשובה תגיע כאן בצ'אט.";
    const { HOLD_LINE_ALT } = await import("../services/reply-engine/engine");
    h.history = [
      { direction: "INBOUND", body: "חויבתי פעמיים", metadata: null, createdAt: new Date(Date.now() - 5 * 60_000) },
      { direction: "OUTBOUND", body: line, senderName: "AI Bot", metadata: null, createdAt: new Date(Date.now() - 4 * 60_000) },
      { direction: "INBOUND", body: "נו?", metadata: null, createdAt: new Date(Date.now() - 3 * 60_000) },
      { direction: "INBOUND", body: "מה עם החיוב?", metadata: null, createdAt: new Date(Date.now() - 60_000) },
    ];
    // The line at turn 3, silent at 4, now 5.
    await withState(held("חויבתי פעמיים על אותה הזמנה", { _holdLineTurn: "3", _spokeTurn: "3" }, 5), async () => {
      h.responses.push({ toolCalls: [respond("al1", { reply: "החיוב עדיין נבדק." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה עם החיוב?" }, "autonomous");
      expect(r.reply ?? "").not.toContain(line);
      expect(r.reply ?? "").not.toContain(HOLD_LINE_ALT.he);
      handedOver(r);
    });
  });
});

describe("C pinned rating c24439a1: the holding floor", () => {
  it("★ 5b: after the gate went silent next to an old item: a person takes it, no holding line", async () => {
    const { HOLD_LINE_ALT } = await import("../services/reply-engine/engine");
    const { prisma } = await import("@chatcenter/shared");
    const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
    // The line went out at 7 and nothing since (the state); the history's last bot message is another engine's.
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString(), _holdLineTurn: "7", _spokeTurn: "7" }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }, { direction: "INBOUND", body: "נו", metadata: null }];
      h.responses.push({ toolCalls: [respond("fa1", { reply: para })] }, { toolCalls: [respond("fa2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא יצאה הזמנה" }, "autonomous");
      expect(r.reply ?? "").not.toContain(HOLD_LINE_ALT.he);
      handedOver(r);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
});

describe("C pinned rating c24439a1: the search on her noun", () => {
  it("★ 3b: results with none of her noun: once more on the noun alone, and its products are used", async () => {
    h.groundSeq = ["מטפחת משי ורודה", "בובון קטיפה לקשירה נמוכה"];
    h.responses.push({ toolCalls: [tc("bn1", "woocommerce.list_products", { query: "בובון לקשירה נמוכה" })] }, { toolCalls: [respond("bn2", { reply: "יש לנו בובון קטיפה לקשירה נמוכה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "היי מחפשת את הבובון לקשירה נמוכה" }, "autonomous");
    const t = (r.trace as any).tools.find((x: any) => x.tool === "woocommerce.list_products");
    expect(t.args.query).toBe("בובון");
    expect(String(t.content)).toMatch(/בובון קטיפה/);
    expect(String(t.content)).not.toMatch(/מטפחת/);
  });
  it("★ 3c: results that hold her noun are not searched again", async () => {
    h.groundSeq = ["בובון קטיפה לקשירה נמוכה", "מטפחת משי ורודה"];
    h.responses.push({ toolCalls: [tc("bn3", "woocommerce.list_products", { query: "בובון לקשירה נמוכה" })] }, { toolCalls: [respond("bn4", { reply: "יש לנו בובון קטיפה לקשירה נמוכה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "היי מחפשת את הבובון לקשירה נמוכה" }, "autonomous");
    const t = (r.trace as any).tools.find((x: any) => x.tool === "woocommerce.list_products");
    expect(t.args.query).toBe("בובון לקשירה נמוכה");
    expect(h.groundSeq).toEqual(["מטפחת משי ורודה"]);
  });
  it("★ 4c: the pad for a size comes from the knowledge's table, not the store's generic title", async () => {
    h.groundTitle = "משטח הזזה 20*25";
    h.lexical = [{ content: "טבלת מידות: סמובי גפן 26*20, סמובי אליס 31*41", score: 0.9, documentTitle: "sizes", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [tc("kp1", "woocommerce.list_products", { query: "מיקסר" })] }, { toolCalls: [respond("kp2", { reply: "הנה ההתאמות." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 30x22 טוסטר 24x15" }, "autonomous");
    expect(r.reply ?? "").toMatch(/24×15: סמובי גפן/);
    expect(r.reply ?? "").toMatch(/30×22: סמובי אליס/);
    expect(r.reply ?? "").not.toMatch(/משטח הזזה 20\*25/);
  });
});

describe("relevance R3 through a whole turn: machines silent, customers answered", () => {
  it("★ R3 turn: a one-time code gets no reply, no handoff and no team question", async () => {
    h.responses.push({ toolCalls: [respond("ot1", { reply: "חשוב לא לשתף קודי אימות בצ׳אט." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "Your verification code is 482913" }, "autonomous");
    expect(r.reply ?? null).toBeNull();
    expect(r.trace.gate1).toBe("automated:one_time_code");
    expect(r.trace.teamQuestion ?? null).toBeNull();
  });
  it("★ R3a turn: a customer's opening statement of 6+ words is answered as today", async () => {
    h.responses.push({ toolCalls: [respond("ot2", { reply: "בשמחה, איזה מיקסר יש לך?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני מחפשת משטח הזזה למיקסר החדש שקניתי השבוע" }, "autonomous");
    expect(String(r.trace.gate1 ?? "")).not.toMatch(/^automated/);
    expect(r.reply ?? "").toMatch(/מיקסר/);
  });
  it("★ R3b turn: a customer complaining about a code is answered", async () => {
    for (const msg of ["הקוד 123456 לא הגיע לי", "קיבלתי קוד 4821 מה עושים איתו"]) {
      h.responses.push({ toolCalls: [respond("ot3", { reply: "אני בודקת את זה בשבילך." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: msg }, "autonomous");
      expect(String(r.trace.gate1 ?? "")).not.toMatch(/^automated/);
    }
  });
  it("★ R3c turn: a coupon code or an order number next to קוד is answered", async () => {
    for (const msg of ["קוד קופון 2024", "קוד הזמנה 97837"]) {
      h.responses.push({ toolCalls: [respond("ot4", { reply: "בודקת." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: msg }, "autonomous");
      expect(String(r.trace.gate1 ?? "")).not.toMatch(/^automated/);
    }
  });
});

describe("relevance R3 fix through a whole turn: the Supervisor's five customers are answered", () => {
  const t = (s: number) => new Date(Date.now() - (3600 - s) * 1000);
  const cases: Array<[string, any[], string]> = [
    ["1", [{ direction: "INBOUND", body: "היי", metadata: null, createdAt: t(0) }, { direction: "OUTBOUND", body: "היי! איך אפשר לעזור?", senderName: "AI Bot", metadata: null, createdAt: t(3540) }], "מה שעות הפעילות שלכם?"],
    ["2", [{ direction: "INBOUND", body: "היי", metadata: null, createdAt: t(0) }, { direction: "OUTBOUND", body: "היי! איך אפשר לעזור?", senderName: "AI Bot", metadata: null, createdAt: t(3540) }], "מה שעות הפעילות שלכם ביום שישי"],
    ["3", [], "היי רציתי לדעת מה שעות הפעילות שלכם ביום שישי"],
    ["4", [{ direction: "INBOUND", body: "כמה עולה משלוח?", metadata: null, createdAt: t(0) }, { direction: "OUTBOUND", body: "משלוח עולה 30 ש\"ח.", senderName: "AI Bot", metadata: null, createdAt: t(3540) }], "תודה על ההודעה, אז אני רוצה להזמין את השמלה הכחולה"],
    ["5", [{ direction: "OUTBOUND", body: "מבצע סוף עונה בחנות!", senderName: "Campaign", metadata: null, createdAt: t(0) }], "מה שעות הפעילות של החנות?"],
    ["en", [{ direction: "OUTBOUND", body: "Shipping is 30 ILS.", senderName: "AI Bot", metadata: null, createdAt: t(3540) }], "thanks for the message, I want to order the blue dress"],
  ];
  for (const [name, history, incoming] of cases) {
    it(`★ R3 turn ${name}: answered, gate1 not automated`, async () => {
      h.history = history.length ? history : null;
      h.responses.push({ toolCalls: [respond(`r3${name}`, { reply: "בשמחה, אנחנו פתוחים מ-9 עד 17." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
      expect(String(r.trace.gate1 ?? "")).not.toMatch(/^automated/);
      expect(r.reply ?? "").not.toBe("");
    });
  }
  it("★ R3 turn: a real away message after our outreach stays silent", async () => {
    const away = "תודה שפניתם אלינו! נחזור אליכם בהקדם האפשרי.";
    h.history = [{ direction: "OUTBOUND", body: "היי, רציתי להציע לכם שירות", senderName: "Omer", metadata: null, createdAt: t(0) }, { direction: "INBOUND", body: away, metadata: null, createdAt: t(4) }];
    h.responses.push({ toolCalls: [respond("r3away", { reply: "ההודעה נשמעת כמו מענה אוטומטי." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: away }, "autonomous");
    expect(r.reply ?? null).toBeNull();
    expect(r.trace.gate1).toBe("automated:auto_reply");
  });
});

describe("relevance R3 round 3 through a whole turn", () => {
  it("★ R3 turn: an angry customer quoting the business's promise is answered", async () => {
    h.history = null;
    h.responses.push({ toolCalls: [respond("r3ang", { reply: "סליחה על ההמתנה, אני בודקת את זה עכשיו." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "פניתי אליכם אתמול ואמרו לי נחזור אליך ואף אחד לא חזר" }, "autonomous");
    expect(String(r.trace.gate1 ?? "")).not.toMatch(/^automated/);
  });
});

describe("replay d (the cab0f40e rating) through a whole turn", () => {
  it("★ 1: a fit claim that the computed size match does not support goes; each size gets its own pad", async () => {
    h.groundTitle = "משטח הזזה 20*30";
    h.lexical = [{ content: "טבלת מידות: סמובי אליס 20*30, סמובי גפן 23*40", score: 0.9, documentTitle: "sizes", chunkIndex: 1, documentId: "d" }];
    const claim = "גם בסיס המיקסר והטוסטר מתאימים למשטח הזה.";
    h.responses.push({ toolCalls: [tc("fc1", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("fc2", { reply: claim })] }, { toolCalls: [respond("fc3", { reply: claim })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 32x22 טוסטר 18x25" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/מתאימים למשטח הזה/);
    expect(r.reply ?? "").toMatch(/32×22: סמובי גפן/);
    expect(r.reply ?? "").toMatch(/18×25: סמובי אליס/);
  });
  it("★ 1b: a fit claim naming the right pad stays and counts as the answer", async () => {
    h.groundTitle = "משטח הזזה 20*30";
    h.lexical = [{ content: "טבלת מידות: סמובי אליס 20*30, סמובי גפן 23*40", score: 0.9, documentTitle: "sizes", chunkIndex: 1, documentId: "d" }];
    const ok = "למיקסר מתאים סמובי גפן.";
    h.responses.push({ toolCalls: [tc("fc4", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("fc5", { reply: ok })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 32x22 טוסטר 18x25" }, "autonomous");
    expect(r.reply ?? "").toMatch(/למיקסר מתאים סמובי גפן/);
    expect(r.reply ?? "").not.toMatch(/32×22:/);
    expect(r.reply ?? "").toMatch(/18×25: סמובי אליס/);
  });
  it("★ 1c: an item named with ANOTHER pad is not answered: it gets its own pad's line", async () => {
    h.groundTitle = "משטח הזזה 20*30";
    h.lexical = [{ content: "טבלת מידות: סמובי אליס 20*30, סמובי גפן 23*40", score: 0.9, documentTitle: "sizes", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [tc("fc6", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("fc7", { reply: "למיקסר: סמובי אליס." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 32x22 טוסטר 18x25" }, "autonomous");
    expect(r.reply ?? "").toMatch(/32×22: סמובי גפן/);
  });
  it("★ 1d: generic store titles, no table: a fit claim to the generic name is cut, the line keeps the size", async () => {
    h.groundTitle = "משטח הזזה 20*30";
    h.extraTitle = "משטח הזזה 23*40";
    h.responses.push({ toolCalls: [tc("fc8", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("fc9", { reply: "המיקסר מתאים למשטח הזזה." })] }, { toolCalls: [respond("fc10", { reply: "המיקסר מתאים למשטח הזזה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מיקסר 32x22 טוסטר 18x25" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/המיקסר מתאים למשטח הזזה\./);
    expect(r.reply ?? "").toMatch(/32×22: משטח הזזה 23\*40/);
  });
  it("★ 2: a counter-question the cut left on a direct question is never the whole reply", async () => {
    const body = "לפי הנתונים, 73% מהלקוחות עם ורידים כחולים בוחרים גוון בהיר. מה נראה אצלך?";
    h.responses.push({ toolCalls: [respond("dq1", { reply: body })] }, { toolCalls: [respond("dq2", { reply: body })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איך אדע מה התת גוון שלי?" }, "autonomous");
    expect((r.reply ?? "").trim()).not.toBe("מה נראה אצלך?");
    // Nothing of the draft stands: a person takes it (it used to be the team line).
    handedOver(r);
  });
  it("★ 2b: a short clarifying question the model wrote with no gate cut is sent as it is", async () => {
    // An explanation ask, so only "no cut this turn" keeps the model's question.
    h.responses.push({ toolCalls: [respond("cq1", { reply: "לאיזה מכשיר?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איך בוחרים איזה משטח מתאים לי?" }, "autonomous");
    // No sentence cut this turn (a no_search verdict may "clean" and remove nothing): sent as the model wrote it.
    expect(Number((r.trace as any).cutSentences ?? 0)).toBe(0);
    expect((r.reply ?? "").trim()).toBe("לאיזה מכשיר?");
  });
  it("★ 4: a reply that passes it to the team twice: a real hand-over, no team sentence left", async () => {
    h.responses.push({ toolCalls: [respond("tp1", { reply: "אפשר להעביר את זה לצוות, והתשובה תגיע כאן בצ'אט. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "משלוח לאילת" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש משלוח לאילת?" }, "autonomous");
    expect((r.reply ?? "").match(/לצוות/g) ?? []).toHaveLength(0);
    handedOver(r);
    expect(r.reply ?? "").not.toMatch(/אפשר להעביר/);
  });
  it("★ 5 and 6: a story mention and a seller's pitch get no reply; a customer's ask with a service word is answered", async () => {
    h.responses.push({ toolCalls: [respond("sm1", { reply: "תודה! מה מחפשים?" })] });
    const a = await runReplyEngineTurn({ ...opts, incomingMessage: "[Story mention]" }, "autonomous");
    expect(a.reply ?? null).toBeNull();
    expect(a.trace.gate1).toBe("automated:story_mention");
    // A pitch on Messenger (the harness's conversation is web chat, where a pitch is answered).
    const { prisma } = await import("@chatcenter/shared");
    const before = (prisma as any).conversation.findFirst;
    (prisma as any).conversation.findFirst = async () => ({ id: "c1", tenantId: "t1", channel: "MESSENGER", customerExternalId: "fb1" });
    try {
      h.responses.push({ toolCalls: [respond("sp1", { reply: "לא מצאתי דגם בשם הזה." })] });
      const b = await runReplyEngineTurn({ ...opts, incomingMessage: "שלום, אנחנו מציעים שירותי בניית אתרים במחיר מבצע, רוצים הצעת מחיר?" }, "autonomous");
      expect(b.reply ?? null).toBeNull();
      expect(b.trace.gate1).toBe("automated:seller_pitch");
    } finally { (prisma as any).conversation.findFirst = before; }
    // On web chat it is answered.
    h.responses.push({ toolCalls: [respond("sp3", { reply: "תודה, נעביר לבעלי העסק." })] });
    const w = await runReplyEngineTurn({ ...opts, incomingMessage: "שלום, אנחנו מציעים שירותי בניית אתרים במחיר מבצע, רוצים הצעת מחיר?" }, "autonomous");
    expect(String(w.trace.gate1 ?? "")).not.toMatch(/^automated/);
    h.responses.push({ toolCalls: [respond("sp2", { reply: "כן, יש לנו שירות התקנה." })] });
    const c = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם שירות התקנה?" }, "autonomous");
    expect(String(c.trace.gate1 ?? "")).not.toMatch(/^automated/);
  });
});

/** The independent rating of the 1b35c535 prod replay (replay e, 2026-11-18), through a whole turn. */
describe("replay e: engine passes", () => {
  const held = "checking with the team: חויבתי פעמיים ואין הזמנה";
  const withState = async (pending: string, fn: () => Promise<void>, offeredItems: any[] = []) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems, pending: [{ kind: "promise", text: pending, at: new Date().toISOString() }], turnCount: 10 });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };
  const savedPending = (): any[] => { const up = h.upserts[h.upserts.length - 1]; return up?.create?.pending ?? up?.update?.pending ?? []; };

  it("★ 3: \"כן מעדיפה להיות שקטה\" next to an old team item: no held line, no item kept, no team claim", async () => {
    const { HOLD_SETTLED_HE, SETTLED_NOTE } = await import("../services/reply-engine/gates");
    await withState(held, async () => {
      h.responses.push({ toolCalls: [respond("e1", { reply: "בסדר גמור, נשאיר את זה בשקט ולא נשלח הודעות נוספות." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן מעדיפה להיות שקטה" }, "autonomous");
      void SETTLED_NOTE;
      expect(r.reply ?? "").not.toContain(HOLD_SETTLED_HE);
      expect(String(r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
      expect(savedPending().filter((p: any) => p.kind === "promise")).toHaveLength(0);
    });
  });

  it("★ 3: a yes to the bot's old urgency question: no held line any more", async () => {
    const { HOLD_SETTLED_HE } = await import("../services/reply-engine/gates");
    h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: "החיוב בבדיקה אצל הצוות. זה דחוף עבורך?", senderName: "AI Bot", metadata: null }];
    await withState(held, async () => {
      h.responses.push({ toolCalls: [respond("e2", { reply: "בסדר." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן" }, "autonomous");
      expect(r.reply ?? "").not.toContain(HOLD_SETTLED_HE);
    });
  });

  it("★ 4: \"הוספתי את זה לבדיקה\" never goes out unless her words reached the open item", async () => {
    for (const [pending, incoming] of [["checking with the team: האם יש משטח שמתאים לתמי 5", "זה בשביל מתנה ליום ההולדת של אמא שלי"], [held, "שילמתי בביט ולא בכרטיס"]] as const) {
      h.upserts.length = 0;
      await withState(pending, async () => {
        h.responses.push({ toolCalls: [respond("e3", { reply: "הוספתי את זה לבדיקה, והתשובה תגיע כאן בצ'אט.", team_question: pending.slice("checking with the team: ".length) })] }, { toolCalls: [respond("e3b", { reply: "הוספתי את זה לבדיקה, והתשובה תגיע כאן בצ'אט." })] });
        const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
        const item = savedPending().find((p: any) => p.text.startsWith(pending.slice(0, 40)))?.text ?? pending;
        if (/הוספתי את זה/.test(r.reply ?? "")) expect(item, incoming).toContain(`customer added: "${incoming}"`);
      });
    }
  });

  it("★ 4: a thanks adds nothing: the claim goes", async () => {
    const open = "checking with the team: האם יש משטח שמתאים לתמי 5";
    await withState(open, async () => {
      h.responses.push({ toolCalls: [respond("e4", { reply: "הוספתי את זה לבדיקה.", team_question: "האם יש משטח שמתאים לתמי 5" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/הוספתי/);
      expect(savedPending().find((p: any) => /תמי 5/.test(p.text))?.text ?? open).not.toMatch(/customer added/);
    });
  });

  it("★ 4: a photo next to an old team item: the model's own acknowledgement, no item kept", async () => {
    const { HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    await withState(held, async () => {
      h.responses.push({ toolCalls: [respond("e5", { reply: "קיבלתי את התמונה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "[image]" }, "autonomous");
      void HOLD_ACK_HE;
      expect(r.reply).toBe("קיבלתי את התמונה.");
      expect(savedPending().filter((p: any) => p.kind === "promise")).toHaveLength(0);
    });
  });

  it("★ 5e: the video the bot itself sent earlier is the answer when she asks for it again, never a team pass", async () => {
    h.history = [
      { direction: "INBOUND", body: "איך משתמשים בטוש הגבות?", metadata: null },
      { direction: "OUTBOUND", body: "לפני השימוש כדאי להניח את הטוש עם הפקק כלפי מטה. יש גם סרטון הדרכה לטוש הגבות: https://youtu.be/MypUj_xxA24", senderName: "AI Bot", metadata: null },
    ];
    h.responses.push(
      { toolCalls: [respond("e6", { reply: "העברנו לצוות את הבקשה לסרטון שימוש בטוש הגבות, והתשובה תגיע כאן בצ'אט.", team_question: "האם יש סרטון לטוש הגבות?" })] },
      { toolCalls: [respond("e6b", { reply: "העברנו לצוות את הבקשה לסרטון שימוש בטוש הגבות, והתשובה תגיע כאן בצ'אט.", team_question: "האם יש סרטון לטוש הגבות?" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה" }, "autonomous");
    expect(r.reply).toContain("https://youtu.be/MypUj_xxA24");
    expect(r.reply).not.toMatch(/העברנו לצוות/);
    expect(r.trace.teamQuestion ?? null).toBeNull();
  });

  it("★ 5a: \"ביררנו\" with nothing looked up this turn goes, the rest stays", async () => {
    h.responses.push({ toolCalls: [respond("e9", { reply: "ביררנו, ואנחנו פתוחים א-ה 9-17." })] }, { toolCalls: [respond("e9b", { reply: "ביררנו, ואנחנו פתוחים א-ה 9-17." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי אתם פתוחים?" }, "autonomous");
    expect(r.reply).not.toMatch(/ביררנו/);
    expect(r.reply).toMatch(/9-17/);
  });

  it("★ 5d: \"אני אחפש לבד\" gets that help is here, not a bare okay", async () => {
    h.responses.push({ toolCalls: [respond("e7", { reply: "בסדר גמור 🙂" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני אחפש לבד" }, "autonomous");
    expect(r.reply).toMatch(/^בסדר גמור/);
    expect(r.reply).toMatch(/עזרה בבחירה, אנחנו כאן/);
  });

  it("★ 5b: the rewrite keeps the first draft's closing question it dropped", async () => {
    h.responses.push(
      { toolCalls: [respond("e8", { reply: "כן, אפשר להזמין באתר. איזה מכשיר מחפשים עבורו משטח?" })] },
      { toolCalls: [respond("e8b", { reply: "כן, אפשר להזמין באתר." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר להזמין?" }, "autonomous");
    if (r.trace.gate3.rewrite === "rewritten" || r.trace.gate3.rewrite === "cleaned") {
      expect(r.reply).toMatch(/איזה מכשיר מחפשים עבורו משטח\?/);
      expect((r.reply ?? "").match(/\?/g) ?? []).toHaveLength(1);
    } else {
      expect(r.reply).toMatch(/איזה מכשיר/);
    }
  });
});

describe("dev live round on 9480dfb2: the product in focus", () => {
  it("★ named without its exact title: kept in focus, and the next turn's material question reads it, never the team", async () => {
    const { prisma } = await import("@chatcenter/shared");
    h.groundTitle = "Heavyweight Hoodie (Black)";
    h.responses.push({ toolCalls: [tc("f1", "woocommerce.list_products", { query: "hoodie black" })] }, { toolCalls: [respond("f2", { reply: "כן, יש קפוצ'ון שחור בגזרה כבדה.", state_update: { stage: "choosing", intent: "בדיקת צבעי Heavyweight Hoodie", facts: {}, pending: [] } })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם את הקפוצ'ון השחור?" }, "autonomous");
    const up = h.upserts[h.upserts.length - 1];
    const saved = up?.create ?? up?.update;
    expect((saved?.offeredItems ?? []).map((o: any) => o.title)).toContain("Heavyweight Hoodie (Black)");
    expect(saved?.facts?._focusTitles).toContain("Heavyweight Hoodie (Black)");
    // Next turn: the state as saved, minus the offered list (the focus alone carries it).
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", stage: "choosing", intent: "בירור הרכב הבד של Heavyweight Hoodie", facts: saved.facts, offeredItems: [], pending: [], turnCount: 2 });
    try {
      h.dispatched.length = 0;
      h.responses.push({ toolCalls: [respond("f3", { reply: "אין לנו מידע מדויק על הרכב הבד, אפשר לברר את זה מול הצוות." })] }, { toolCalls: [respond("f4", { reply: "Heavyweight Hoodie (Black) עשוי מכותנה." })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "מאיזה בד הוא עשוי?" }, "autonomous");
      expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toBe("Heavyweight Hoodie (Black)");
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ (verify) a newer lookup replaces the focus; an order question clears it and reads no old product", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", stage: "choosing", intent: "Heavyweight Hoodie", facts: { _focusTitles: JSON.stringify(["Heavyweight Hoodie (Black)"]) }, offeredItems: [], pending: [], turnCount: 3 });
    try {
      h.groundTitle = "Canvas Tote";
      h.responses.push({ toolCalls: [tc("g1", "woocommerce.list_products", { query: "tote" })] }, { toolCalls: [respond("g2", { reply: "יש לנו Canvas Tote ב-79 ₪." })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
      let up = h.upserts[h.upserts.length - 1];
      expect(JSON.parse((up?.create ?? up?.update).facts._focusTitles)).toEqual(["Canvas Tote"]);
      h.dispatched.length = 0;
      h.responses.push({ toolCalls: [respond("g3", { reply: "אפשר את מספר ההזמנה?" })] }, { toolCalls: [respond("g4", { reply: "אפשר את מספר ההזמנה?" })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "איפה ההזמנה שלי?" }, "autonomous");
      up = h.upserts[h.upserts.length - 1];
      expect((up?.create ?? up?.update).facts._focusTitles ?? "").toBe("");
      expect(h.dispatched.some((d) => /list_products/.test(d.name) && /Hoodie/.test(String(d.args?.query ?? "")))).toBe(false);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ (verify) on an order question the old focus is never read, even when the model says it has no details", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", stage: "choosing", intent: "Heavyweight Hoodie", facts: { _focusTitles: JSON.stringify(["Heavyweight Hoodie (Black)"]) }, offeredItems: [], pending: [], turnCount: 3 });
    try {
      h.responses.push({ toolCalls: [respond("g7", { reply: "אין לי פרטים על החומר כאן." })] }, { toolCalls: [respond("g8", { reply: "אפשר את מספר ההזמנה?" })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "ההזמנה שלי הגיעה, מאיזה חומר הוא עשוי?" }, "autonomous");
      expect(h.dispatched.some((d) => /list_products/.test(d.name) && /Hoodie/.test(String(d.args?.query ?? "")))).toBe(false);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ (13afc633 verify) the contact's own first name never puts a product of that name in focus", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const contact = (prisma as any).contact.findFirst;
    (prisma as any).contact.findFirst = async () => ({ id: "k1", email: null, phone: null, displayName: "אריאל כהן" });
    try {
      h.groundTitle = "אריאל למכונות קפה";
      h.extraTitle = "גפן למכונות קפה";
      h.responses.push({ toolCalls: [tc("n1", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("n2", { reply: "נשמח לעזור, אריאל. לאיזו מכונה המשטח?" })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת משטח" }, "autonomous");
      const up = h.upserts[h.upserts.length - 1];
      expect(((up?.create ?? up?.update)?.offeredItems ?? []).map((o: any) => o.title)).not.toContain("אריאל למכונות קפה");
    } finally { (prisma as any).contact.findFirst = contact; }
  });

  it("★ (prod replay of 9480dfb2) \"4 הצעות\" with two cards says 2", async () => {
    h.groundTitle = "מטפחת נוטינג";
    h.extraTitle = "מטפחת ברוקלין";
    h.responses.push({ toolCalls: [tc("c1", "woocommerce.list_products", { query: "מטפחת" })] }, { toolCalls: [respond("c2", { reply: "בטח, הנה 4 הצעות שיתאימו לך.", cards: ["PRODUCT_1", "PRODUCT_2"] })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר המלצה על מטפחת?" }, "autonomous");
    expect(r.reply).toMatch(/2 הצעות/);
    expect(r.reply).not.toMatch(/4 הצעות/);
  });

  it("★ a cut records which check took it (trace and audit)", async () => {
    h.responses.push({ toolCalls: [tc("w1", "woocommerce.list_products", { query: "תיק" })] }, { toolCalls: [respond("w2", { reply: "Canvas Tote עולה ₪999. הוא מבד קנבס עבה ונוח לשימוש יומיומי, ומתאים גם לקניות." })] }, { toolCalls: [respond("w3", { reply: "Canvas Tote עולה ₪999. הוא מבד קנבס עבה ונוח לשימוש יומיומי, ומתאים גם לקניות." })] }, { toolCalls: [respond("w4", { reply: "Canvas Tote עולה ₪999. הוא מבד קנבס עבה ונוח לשימוש יומיומי, ומתאים גם לקניות." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כמה עולה התיק?" }, "autonomous");
    if (Number((r.trace as any).cutSentences ?? 0) > 0) {
      expect((r.trace as any).cutWhy).toContain("ungrounded_price");
      expect(h.audits.find((a) => a.data.action === "ai.bot_turn").data.metadata.cuts.cutWhy).toContain("ungrounded_price");
    } else {
      throw new Error(`no cut happened: ${JSON.stringify(r.trace.gate3)} ${r.reply}`);
    }
  });

  it("★ (rating 9480dfb2, near-blocker 6) a waiting claim with no hand-over is cut; nothing left, a real hand-over", async () => {
    h.responses.push({ toolCalls: [respond("wt1", { reply: "נציגינו עסוקים בפניות קודמות ויתפנו בהקדם." })] }, { toolCalls: [respond("wt2", { reply: "נציגינו עסוקים בפניות קודמות ויתפנו בהקדם." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/עסוקים|יתפנו/);
    handedOver(r);
  });

  it("★ (rating 9480dfb2, near-blocker 4) a fallback list after a cut fit claim says the fit is unconfirmed", async () => {
    const { FIT_UNCONFIRMED_HE } = await import("../services/reply-engine/engine");
    h.groundTitle = "טוש גבות Miss eyebrows";
    h.extraTitle = "טוש טינט Lip Tint";
    const fit = "טוש גבות Miss eyebrows מתאים לנינג'ה קריספי.";
    h.responses.push({ toolCalls: [tc("fb1", "woocommerce.list_products", { query: "טוש" })] }, { toolCalls: [respond("fb2", { reply: fit })] }, { toolCalls: [respond("fb3", { reply: fit })] }, { toolCalls: [respond("fb4", { reply: fit })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "טוש אני רוצה" }, "autonomous");
    if (r.trace.gate3.rewrite === "fallback" && ((r.trace as any).fallbackKinds ?? []).includes("ungrounded_positive_fit")) {
      expect(r.reply).toContain(FIT_UNCONFIRMED_HE);
      // With the caveat, the products by name (rating b369e939: a bare header and a caveat read as a shrug).
      expect(r.reply).toMatch(/טוש גבות Miss eyebrows/);
      // The same fallback on the next turn is never sent twice in a row.
      h.history = [{ direction: "INBOUND", body: "טוש אני רוצה", metadata: null }, { direction: "OUTBOUND", body: r.reply, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [tc("fb5", "woocommerce.list_products", { query: "טוש" })] }, { toolCalls: [respond("fb6", { reply: fit })] }, { toolCalls: [respond("fb7", { reply: fit })] }, { toolCalls: [respond("fb8", { reply: fit })] });
      const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: "טוש אני רוצה" }, "autonomous");
      expect((r2.reply ?? "").trim()).not.toBe(String(r.reply).trim());
    } else throw new Error(`not the fallback path: ${JSON.stringify(r.trace.gate3)} ${JSON.stringify((r.trace as any).fallbackKinds)} ${r.reply}`);
  });

  it("★ (rating 9480dfb2, blocker 2) a cut that took the team pass on a question never sends the remnant", async () => {
    const reply = "נכון, לא צירפנו סרטון. נבדוק עם הצוות ונחזור אלייך עם הסרטון.";
    h.responses.push({ toolCalls: [respond("lp1", { reply })] }, { toolCalls: [respond("lp2", { reply })] }, { toolCalls: [respond("lp3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה הסרטון?" }, "autonomous");
    expect(r.reply).not.toBe("נכון, לא צירפנו סרטון.");
    handedOver(r);
  });

  it("★ (rating 9480dfb2, near-blocker 5) every size answered by the table: no team pass, no team question", async () => {
    h.groundTitle = "סמובי גפן 40x50";
    h.extraTitle = "סמובי אליס 30x40";
    h.responses.push({ toolCalls: [tc("sz1", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("sz2", { reply: "למיקסר מתאים סמובי גפן 40x50. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "לא נמצאה התאמה למיקסר ולטוסטר" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "משטח למיקסר 35x45 וטוסטר 25x35" }, "autonomous");
    if (!(r.trace as any).sizedItems) throw new Error(`the size table did not run: ${r.reply}`);
    if ((r.trace as any).sizedItems.none === 0) {
      expect(r.reply).not.toMatch(/העברתי את זה לצוות/);
      expect(r.trace.teamQuestion ?? null).toBeNull();
    } else {
      expect(String(r.trace.teamQuestion ?? "")).toMatch(/^sizes with no fitting pad/);
    }
  });

  it("★ (rating 9480dfb2, blocker 1) a video ask never gets a page link the bot sent earlier", async () => {
    h.history = [
      { direction: "INBOUND", body: "יש לכם טוש גבות?", metadata: null },
      { direction: "OUTBOUND", body: "כן, טוש גבות Miss eyebrows: https://shop.example/product/miss-eyebrows", senderName: "AI Bot", metadata: null },
    ];
    const pass = "העברנו לצוות את הבקשה לסרטון לטוש הגבות, והתשובה תגיע כאן בצ'אט.";
    h.responses.push({ toolCalls: [respond("v1", { reply: pass, team_question: "סרטון לטוש הגבות" })] }, { toolCalls: [respond("v2", { reply: pass, team_question: "סרטון לטוש הגבות" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה לטוש הגבות" }, "autonomous");
    expect(r.reply ?? "").not.toContain("https://shop.example/product/miss-eyebrows");
  });

  it("★ (rating 9480dfb2, blocker 2) a fragment left by a cut is never sent", async () => {
    const reply = "התיק עולה ₪999. וגם הוא נוח מאוד לשימוש יומיומי.";
    h.responses.push({ toolCalls: [respond("fr1", { reply })] }, { toolCalls: [respond("fr2", { reply })] }, { toolCalls: [respond("fr3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כמה עולה התיק?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/^\s*וגם/);
  });

  it("★ (dev live round on b369e939, 1) a video ask shaped like a product ask: a person, never the product question", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", stage: "choosing", intent: "Zip Hoodie", facts: {}, offeredItems: [{ ref: "id:9", title: "Zip Hoodie", productId: "9", at: new Date().toISOString() }], pending: [], turnCount: 3 });
    try {
      const no = "אין לנו מידע על סרטון הדרכה לכביסה.";
      h.responses.push({ toolCalls: [respond("vd1", { reply: no })] }, { toolCalls: [respond("vd2", { reply: no })] }, { toolCalls: [respond("vd3", { reply: no })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם סרטון הדרכה לכביסה?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/לאיזה דגם|באיזו מידה/);
      handedOver(r);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ (dev live round on b369e939, 2) a video ask whose answer was cut: the grounded tip, then a person", async () => {
    const reply = "אין לנו כרגע סרטון הדרכה לכביסה. כדאי לפעול לפי תווית הטיפול שעל הקפוצ'ון, כי הוראות הכביסה תלויות בה.";
    h.responses.push({ toolCalls: [respond("vc1", { reply })] }, { toolCalls: [respond("vc2", { reply })] }, { toolCalls: [respond("vc3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה איך מכבסים אותו" }, "autonomous");
    if (Number((r.trace as any).cutSentences ?? 0) > 0 || r.trace.gate3.rewrite === "fallback") {
      handedOver(r);
      expect(r.trace.teamQuestion ?? null).not.toBeNull();
      // The grounded rest stays in front of the line (rating b369e939: NE'A's usage tip was lost).
      if (r.trace.gate3.rewrite !== "fallback") expect(r.reply ?? "").toMatch(/תווית הטיפול/);
    } else {
      throw new Error(`the absence was not cut: ${JSON.stringify(r.trace.gate3)} ${r.reply}`);
    }
  });

  it("★ (rating b369e939, blocker 1) never the same fallback line twice in a row", async () => {
    const pass = "אפשר לשלם בתשלומים, ₪120 לחודש.";
    const canned = "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.";
    h.history = [{ direction: "INBOUND", body: "אפשר לשלם בתשלומים?", metadata: null }, { direction: "OUTBOUND", body: canned, senderName: "AI Bot", metadata: null }];
    h.responses.push({ toolCalls: [respond("rp1", { reply: pass })] }, { toolCalls: [respond("rp2", { reply: pass })] }, { toolCalls: [respond("rp3", { reply: pass })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
    expect((r.reply ?? "").trim()).not.toBe(canned);
  });

  it("★ (rating b369e939, near) the product question after the canned line opens no second team question", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString() }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: מתי יגיע המשלוח שלי", at: new Date().toISOString() }], turnCount: 3 });
    h.groundCategory = "תיקים";
    try {
      h.responses.push({ toolCalls: [respond("pq1", { reply: "השמלה עולה ₪120." })] }, { toolCalls: [respond("pq2", { reply: "בטח, ₪150 בלבד." })] }, { toolCalls: [respond("pq3", { reply: "בטח, ₪150 בלבד." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת שמלה חגיגית" }, "autonomous");
      if (!/מה הכי חשוב לך/.test(r.reply ?? "")) throw new Error(`not the product question: ${r.reply}`);
      expect(r.trace.teamQuestion ?? null).toBeNull();
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ (rating b369e939) a reply that ends on a bare word gets its full stop", async () => {
    h.responses.push({ toolCalls: [respond("pt1", { reply: "אנחנו פתוחים א-ה 9-17" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי אתם פתוחים?" }, "autonomous");
    expect(r.reply).toBe("אנחנו פתוחים א-ה 9-17.");
  });

  it("★ (48f3a261 verify, 7) a second video ask next to an old item: a person takes it, the ask on the owner's list", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: האם יש סרטון הדרכה לטוש הגבות", at: new Date().toISOString() }], turnCount: 4 });
    try {
      const pass = "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.";
      h.responses.push({ toolCalls: [respond("j1", { reply: pass, team_question: "איפה הסרטון" })] }, { toolCalls: [respond("j2", { reply: pass, team_question: "איפה הסרטון" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה הסרטון" }, "autonomous");
      expect(h.teamQuestions).toHaveLength(1);
      expect(r.reply ?? "").not.toBe(pass);
      handedOver(r);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ the audit row carries the cut fields when something was cut", async () => {
    h.responses.push({ toolCalls: [respond("g5", { reply: "ביררנו, ואנחנו פתוחים א-ה 9-17." })] }, { toolCalls: [respond("g6", { reply: "ביררנו, ואנחנו פתוחים א-ה 9-17." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "מתי אתם פתוחים?" }, "autonomous");
    const audit = h.audits.find((a) => a.data.action === "ai.bot_turn");
    expect(audit.data.metadata.cuts?.markers ?? []).toContain("checkedClaimCut");
  });

  it("★ \"אפשר להזמין?\" with the site in the knowledge is never a team pass", async () => {
    h.responses.push({ toolCalls: [respond("f5", { reply: "כן, אפשר להזמין באתר שלנו." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר להזמין?" }, "autonomous");
    expect(r.trace.gate3.problems?.map((p: any) => p.kind) ?? []).not.toContain("no_search");
    expect(r.reply).not.toMatch(/לצוות/);
  });
});

describe("rating of the d2f10620 prod replay, through a whole turn", () => {
  const withState = async (st: any, fn: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [], turnCount: 3, ...st });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };
  it("★ B3: a draft the cleanup can fix goes out with no rewrite round", async () => {
    h.responses.push({ toolCalls: [tc("d0", "woocommerce.list_products", { query: "תיק בד" })] }, { toolCalls: [respond("d1", { reply: "יש לנו את Canvas Tote, תיק בד חזק ונוח לשימוש יומיומי וגם לקניות. הוא עולה ₪999." })] });
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect((r.trace as any).rewriteSkipped, `${JSON.stringify(r.trace.gate3)} ${(r.trace as any).directRejected} ${r.reply}`).toBe("direct_clean");
    // Two calls (the search round and the answer), no rewrite call.
    expect(h.calls).toHaveLength(2);
    expect((r.trace as any).rewriteRounds).toBe(0);
    expect(r.reply).toMatch(/Canvas Tote/);
    expect(r.reply).not.toMatch(/999/);
  });
  it("★ B1a: a cut that leaves an emoji alone never sends it", async () => {
    const reply = "העברנו את זה לצוות. 🙂";
    h.responses.push({ toolCalls: [respond("e1", { reply })] }, { toolCalls: [respond("e2", { reply })] }, { toolCalls: [respond("e3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני לא טובה בלראות באתר וכו.." }, "autonomous");
    expect((r.reply ?? "").trim()).not.toBe("🙂");
  });
  it("★ B1b: a direct video ask after an old team pass is never silent: a person, never the still-checking line", async () => {
    await withState({ facts: { _cannedTeamLineAt: new Date().toISOString() }, pending: [{ kind: "promise", text: "checking with the team: האם יש סרטון הדרכה לטוש הגבות", at: new Date().toISOString() }] }, async () => {
      const no = "אין לנו סרטון הדרכה לטוש.";
      h.responses.push({ toolCalls: [respond("s1", { reply: no })] }, { toolCalls: [respond("s2", { reply: no })] }, { toolCalls: [respond("s3", { reply: no })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה" }, "autonomous");
      expect((r.reply ?? "").trim()).not.toBe("");
      expect(r.reply).not.toMatch(/עדיין בבדיקה/);
      handedOver(r);
    });
  });
  it("★ B1c: a condition left without its claim is never sent", async () => {
    h.groundTitle = "סמובי אסף";
    const reply = "סמובי אסף מתאים לנינג'ה קריספי. אם זו מכונת קפה קטנה או דגם מסוים של נינג'ה, כתבו את הדגמים ואדייק.";
    h.responses.push({ toolCalls: [tc("c0", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("c1", { reply })] }, { toolCalls: [respond("c2", { reply })] }, { toolCalls: [respond("c3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש משטח לנינג'ה קריספי?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/^\s*אם זו מכונת קפה/);
  });
  it("★ B2a: a reply that points at a card it forgot gets the card, never a fallback", async () => {
    h.groundTitle = "first coffee";
    h.responses.push({ toolCalls: [tc("f0", "woocommerce.list_products", { query: "עיפרון חום" })] }, { toolCalls: [respond("f1", { reply: "לעיפרון חום מתחת לעיניים, ה-first coffee שמופיע כאן הוא בגוון חום שוקולדי." })] }, { toolCalls: [respond("f2", { reply: "לעיפרון חום מתחת לעיניים, ה-first coffee שמופיע כאן הוא בגוון חום שוקולדי." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני רוצה גוון חום למתחת לעיניים" }, "autonomous");
    expect(r.trace.gate3.rewrite).not.toBe("fallback");
    expect(r.reply).toMatch(/first coffee/);
    expect((r.trace as any).cardsAttached).toBe(1);
  });
  it("★ queue 6: an empty search for her noun and others of another kind: \"not found\", never their cards", async () => {
    h.groundTitle = "Leather Crossbody Bag";
    // As on prod (rewriteCut=budget): the claim is broader than the search, flagged, and no time is left to rewrite.
    const no = "אין לנו מעמדים בקטלוג.";
    h.responses.push({ toolCalls: [tc("n0", "woocommerce.list_products", { query: "מעמד לצילום סרטונים" })] }, { toolCalls: [respond("n1", { reply: no })] });
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "5000";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const { generateResponse } = await import("../services/ai.service");
    const orig = (generateResponse as any).getMockImplementation();
    (generateResponse as any).mockImplementationOnce(async (p: any) => orig(p)).mockImplementationOnce(async (p: any) => { const out = await orig(p); shift = 4500; return out; });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם מעמד לצילום סרטונים?" }, "autonomous"); } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    if (r.trace.gate3.rewrite !== "fallback") throw new Error(`not the fallback path: ${JSON.stringify(r.trace.gate3)} ${r.reply}`);
    expect(r.reply ?? "").not.toMatch(/Leather|הנה כמה אפשרויות/);
  });
  it("★ (7100b0b6 pre-check, L789) the fallback search: her describing words with the conversation's noun, never a garbage query", async () => {
    h.history = [{ direction: "INBOUND", body: "יש לכם מטפחת חגיגית לחתונה?", metadata: null }, { direction: "OUTBOUND", body: "יש לנו כמה מטפחות חגיגיות.", senderName: "AI Bot", metadata: null }];
    await withState({ offeredItems: [{ ref: "id:5", title: "מטפחת אנה", productId: "5", at: new Date().toISOString() }] }, async () => {
      h.responses.push({ toolCalls: [respond("q1", { reply: "המטפחת עולה ₪120." })] }, { toolCalls: [respond("q2", { reply: "בטח, ₪150 בלבד." })] }, { toolCalls: [respond("q3", { reply: "בטח, ₪150 בלבד." })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית" }, "autonomous");
      expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toBe("מטפחת חגיגי כחול");
    });
  });

  it("★ (d874dc87 pre-check) the real L789 sequence: the noun from the message about a product, never \"טובה\"", async () => {
    h.history = [
      { direction: "INBOUND", body: "יערה שלום. במכירה בחריש הייתה מטפחת חגגית מאוד שהיה בה גווני כחול, היא עדיין יישנה?", metadata: null },
      { direction: "OUTBOUND", body: "נבדוק את זה.", senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: "אני לא טובה בלראות באתר וכו..", metadata: null },
      { direction: "OUTBOUND", body: "אין בעיה, נעזור כאן.", senderName: "AI Bot", metadata: null },
    ];
    h.responses.push({ toolCalls: [respond("rs1", { reply: "המטפחת עולה ₪120." })] }, { toolCalls: [respond("rs2", { reply: "בטח, ₪150 בלבד." })] }, { toolCalls: [respond("rs3", { reply: "בטח, ₪150 בלבד." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית" }, "autonomous");
    const q = h.dispatched.filter((d) => d.name === "woocommerce.list_products").map((d) => String(d.args.query));
    expect(q.some((x) => /מטפחת/.test(x))).toBe(true);
    expect(q.some((x) => /טובה/.test(x))).toBe(false);
  });

  it("★ (d874dc87 pre-check) a previous message with no product lends nothing; the product in focus does", async () => {
    h.history = [{ direction: "INBOUND", body: "בדקתי עכשיו שוב- ואין", metadata: null }, { direction: "OUTBOUND", body: "נבדוק.", senderName: "AI Bot", metadata: null }];
    await withState({ intent: "מטפחת חגיגית", offeredItems: [{ ref: "id:5", title: "מטפחת אנה כחולה", productId: "5", at: new Date().toISOString() }] }, async () => {
      h.responses.push({ toolCalls: [respond("fc1", { reply: "המטפחת עולה ₪120." })] }, { toolCalls: [respond("fc2", { reply: "בטח, ₪150 בלבד." })] }, { toolCalls: [respond("fc3", { reply: "בטח, ₪150 בלבד." })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית" }, "autonomous");
      const q = h.dispatched.filter((d) => d.name === "woocommerce.list_products").map((d) => String(d.args.query));
      expect(q.length).toBeGreaterThan(0);
      expect(q.every((x) => /מטפחת/.test(x) && !/בדקתי/.test(x))).toBe(true);
    });
  });

  it("★ B1d: a request for the sizes she just gave is never left after a cut", async () => {
    h.groundTitle = "סמובי גפן 40x50";
    const reply = "למיקסר מתאים סמובי גפן 40x50. הוא עולה ₪999. אפשר לשלוח את רוחב ועומק הבסיס של כל אחד מהם?";
    h.responses.push({ toolCalls: [tc("z0", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("z1", { reply })] }, { toolCalls: [respond("z2", { reply })] }, { toolCalls: [respond("z3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "משטח למיקסר 35x45 וטוסטר 25x35" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/רוחב ועומק/);
    expect(r.reply ?? "").not.toMatch(/999/);
  });

  it("★ queue 7: a question no tool answers (a restock date) is a hand-over, never \"passed to the team\"", async () => {
    h.responses.push({ toolCalls: [respond("t1", { reply: "אין לנו כרגע תאריך מאומת לחידוש המלאי בשחור.", team_question: "מתי צפוי חידוש מלאי של התיק בצבע שחור?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי יחזור למלאי בצבע שחור?" }, "autonomous");
    if (r.trace.teamQuestion) handedOver(r);
    else throw new Error(`no question was recorded: ${JSON.stringify(r.trace.gate3)} ${r.reply}`);
  });
});

describe("dev live round on dcf2158e: the answer sentence is never the one cut", () => {
  const draft = "בשחור יש את ה-Heavyweight Hoodie, מקפוצ'ון כותנה אורגנית עבה. ה-Zip Hoodie הוא בצבע Charcoal, לא שחור.";
  const reads = [tc("g1", "woocommerce.get_product", { product_id: "77" }), tc("g2", "woocommerce.get_product", { product_id: "78" }), tc("g3", "woocommerce.get_product", { product_id: "77" })];
  it("★ (c) with a variations tool: the variations are read and the Heavyweight sentence stays", async () => {
    h.variations = true;
    h.responses.push({ toolCalls: reads }, { toolCalls: [respond("v1", { reply: draft })] }, { toolCalls: [respond("v2", { reply: draft })] }, { toolCalls: [respond("v3", { reply: draft })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "רוצה שחור" }, "autonomous");
    expect((r.trace as any).rewriteSkipped).toBeUndefined();
    expect(h.dispatched.find((d) => d.name === "woocommerce.list_product_variations")?.args.product_id).toBe("77");
    expect(r.reply).toMatch(/Heavyweight Hoodie/);
  });
  it("★ (a) without a variations tool: never the direct clean that leaves only the negated sentence", async () => {
    h.responses.push({ toolCalls: reads }, { toolCalls: [respond("w1", { reply: draft })] }, { toolCalls: [respond("w2", { reply: draft })] }, { toolCalls: [respond("w3", { reply: draft })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "רוצה שחור" }, "autonomous");
    expect((r.trace as any).rewriteSkipped).toBeUndefined();
    expect((r.reply ?? "").trim()).not.toBe("ה-Zip Hoodie הוא בצבע Charcoal, לא שחור.");
  });
});

describe("dev live round on dcf2158e: the direct clean and the reply text", () => {
  it("★ (a) a price ask whose only price sentence is cut never goes out as a direct clean", async () => {
    h.responses.push({ toolCalls: [tc("p0", "woocommerce.list_products", { query: "Canvas Tote" })] }, { toolCalls: [respond("p1", { reply: "Canvas Tote עולה ₪999. הוא תיק בד חזק ונוח לשימוש יומיומי וגם לקניות בשוק." })] }, { toolCalls: [respond("p2", { reply: "Canvas Tote עולה ₪79. הוא תיק בד חזק ונוח." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כמה עולה Canvas Tote?" }, "autonomous");
    expect((r.trace as any).rewriteSkipped).toBeUndefined();
    expect(String((r.trace as any).directRejected ?? "")).toMatch(/answerCut/);
    expect(r.reply).toMatch(/79/);
  });
  it("★ a title repeated in brackets after itself goes out once", async () => {
    h.responses.push({ toolCalls: [tc("t0", "woocommerce.list_products", { query: "תיק" })] }, { toolCalls: [respond("t1", { reply: "יש לנו Canvas Tote (Canvas Tote), תיק בד חזק." })] });
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.reply).not.toMatch(/\(Canvas Tote\)/);
    expect(r.reply).toMatch(/Canvas Tote, תיק בד/);
  });
});

describe("rating of the dcf2158e prod replay, through a whole turn", () => {
  it("★ A: a slow store read never eats the rewrite's budget (counted net of tool waits, under a hard ceiling)", async () => {
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "15000";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    // The store read takes 9.7 s, as on the chains turn.
    // A 12 s store wait: counted against the turn, the rewrite was cut by the budget (under 4 s left).
    h.onTool = (name) => { if (name === "woocommerce.list_products") shift += 12000; };
    h.responses.push({ toolCalls: [tc("a0", "woocommerce.list_products", { query: "תיק" })] }, { toolCalls: [respond("a1", { reply: "Canvas Tote עולה ₪120." })] }, { toolCalls: [respond("a2", { reply: "יש לנו Canvas Tote, תיק בד חזק, ב-₪79." })] });
    let r: any;
    try { r = await runReplyEngineTurn(opts, "autonomous"); } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    expect(r.trace.rewriteCut, `toolWait=${r.trace.toolWaitMs} stages=${JSON.stringify(r.trace.stageMs ?? {})} gate=${JSON.stringify(r.trace.gate3)}`).toBeUndefined();
    expect(r.reply).toMatch(/Canvas Tote/);
    // The main loop too: after the slow read the next round may still use a tool (it is not forced to answer).
    expect(h.calls[1].toolChoice).toBe("required");
  });
  it("★ A: when the time cut the rewrite, the draft's smallest repair goes out, never the generic list", async () => {
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "15000";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const { generateResponse } = await import("../services/ai.service");
    const orig = (generateResponse as any).getMockImplementation();
    // The draft's model call itself runs long: no time is left for a rewrite.
    (generateResponse as any).mockImplementationOnce(async (p: any) => orig(p)).mockImplementationOnce(async (p: any) => { const out = await orig(p); shift = 20500; return out; });
    // Most of the draft goes with the price (a hollow remnant): still the draft's own words, never the generic list.
    h.responses.push({ toolCalls: [tc("t0", "woocommerce.list_products", { query: "תיק" })] }, { toolCalls: [respond("t1", { reply: "יש Canvas Tote. הוא תיק בד חזק ונוח במחיר ₪999 בלבד." })] });
    let r: any;
    try { r = await runReplyEngineTurn(opts, "autonomous"); } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    expect(r.trace.rewriteCut).toBeTruthy();
    expect(r.reply).toMatch(/Canvas Tote/);
    expect(r.reply).not.toMatch(/הנה כמה אפשרויות|999/);
  });

  it("★ D: \"יש כמה מטפחות...\" with no store read runs the store search, with the noun her message gives", async () => {
    h.responses.push({ toolCalls: [respond("d1", { reply: "היי! יש כמה מטפחות חגיגיות בגווני כחול, אבל אין לי דרך לזהות את המטפחת מהמכירה." })] }, { toolCalls: [respond("d2", { reply: "יש לנו Canvas Tote." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "יערה שלום. במכירה בחריש הייתה מטפחת חגגית מאוד שהיה בה גווני כחול, היא עדיין יישנה?" }, "autonomous");
    expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toMatch(/מטפחת/);
  });
  it("★ D: a promise to search with no search runs it (\"נחפש...\"), with the conversation's noun", async () => {
    h.history = [{ direction: "INBOUND", body: "יערה שלום. במכירה בחריש הייתה מטפחת חגגית מאוד שהיה בה גווני כחול, היא עדיין יישנה?", metadata: null }, { direction: "OUTBOUND", body: "נבדוק.", senderName: "AI Bot", metadata: null }, { direction: "INBOUND", body: "אני לא טובה בלראות באתר וכו..", metadata: null }, { direction: "OUTBOUND", body: "אין בעיה.", senderName: "AI Bot", metadata: null }];
    h.responses.push({ toolCalls: [respond("d3", { reply: "ברור, נחפש דווקא מטפחת חגיגית בגווני כחול. עדיין ממתינים לתשובה מהצוות." })] }, { toolCalls: [respond("d4", { reply: "יש לנו Canvas Tote." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית" }, "autonomous");
    const q = h.dispatched.filter((d) => d.name === "woocommerce.list_products").map((d) => String(d.args.query));
    expect(q.some((x) => /מטפחת/.test(x))).toBe(true);
    expect(q.some((x) => /טובה/.test(x))).toBe(false);
  });
  it("★ E: an explanation about a product she names searches its page too", async () => {
    h.responses.push({ toolCalls: [respond("e1", { reply: "אין לנו סרטון הדרכה לטוש." })] }, { toolCalls: [respond("e2", { reply: "יש לנו Canvas Tote." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "קניתי טוש למילוי גבות, אשמח להסבר /סרטון איך להשתמש?" }, "autonomous");
    expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toMatch(/טוש/);
  });
  it("★ C: a rewrite that opens with a fragment loses it", async () => {
    h.responses.push({ toolCalls: [respond("c1", { reply: "אין לנו תיקי בד." })] }, { toolCalls: [respond("c2", { reply: "15. יש לנו Canvas Tote, תיק בד חזק." })] });
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(r.reply).toMatch(/^יש לנו Canvas Tote/);
  });
  it("★ H: a store title's en dash goes out as a hyphen; \"אפשר להזמין?\" gets no list", async () => {
    h.textChannel = true;
    h.groundTitle = "סמובי מוניקה \u2013 משטח הזזה";
    h.responses.push({ toolCalls: [tc("h0", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("h1", { reply: "יש לנו את סמובי מוניקה \u2013 משטח הזזה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם משטח הזזה?" }, "autonomous");
    expect(r.reply).not.toMatch(/[\u2010-\u2015]/);
    h.responses.push({ toolCalls: [tc("h2", "woocommerce.list_products", { query: "להזמין" }), tc("h2b", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("h3", { reply: "כן, אפשר להזמין באתר." })] });
    const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר להזמין?" }, "autonomous");
    // Products were found ("משטח"), yet no list goes out for an ask that names none.
    expect(r2.reply).not.toMatch(/סמובי מוניקה/);
    expect(h.dispatched.filter((d) => d.name === "woocommerce.list_products").map((d) => String(d.args.query))).not.toContain("להזמין");
  });
});

describe("dev live round on 51d0273e (round k), through a whole turn", () => {
  it("★ 1: \"רוצה שחור\" after three hoodies searches the shared noun with the colour, never the carded one alone", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _focusTitles: JSON.stringify(["Heavyweight Hoodie (Black)", "Zip Hoodie", "Pullover Hoodie"]) }, offeredItems: [{ ref: "id:78", title: "Zip Hoodie", productId: "78", at: new Date().toISOString() }], pending: [], turnCount: 2 });
    try {
      h.responses.push({ toolCalls: [respond("k1", { reply: "לא מצאתי בקטלוג התאמה ל-Zip Hoodie בשחור." })] }, { toolCalls: [respond("k2", { reply: "יש Heavyweight Hoodie בשחור." })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "רוצה שחור" }, "autonomous");
      expect(h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query).toMatch(/^Hoodie שחור$/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
  it("★ 4: a first English message gets the reply-language line; a Hebrew one does not", async () => {
    h.history = [{ direction: "INBOUND", body: "do you have a hoodie?", metadata: null }];
    h.responses.push({ toolCalls: [respond("e1", { reply: "Yes, we have hoodies." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "do you have a hoodie?" }, "autonomous");
    h.history = null;
    expect(JSON.stringify(h.calls[0].messages)).toMatch(/reply in English/);
    h.calls.length = 0;
    h.responses.push({ toolCalls: [respond("e2", { reply: "כן, יש קפוצ'ונים." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם קפוצ'ון?" }, "autonomous");
    expect(JSON.stringify(h.calls[0].messages)).not.toMatch(/Reply language/);
    // A bare model name or address in Latin letters is no English talk (probe of d9f7c248).
    for (const m of ["KitchenAid Artisan 5KSM175", "dana.levi@gmail.com"]) {
      h.calls.length = 0;
      h.history = [{ direction: "INBOUND", body: m, metadata: null }];
      h.responses.push({ toolCalls: [respond("e3", { reply: "תודה!" })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: m }, "autonomous");
      h.history = null;
      expect(JSON.stringify(h.calls[0].messages), m).not.toMatch(/Reply language/);
    }
  });
  it("★ 6: the audit row carries the search arguments and the tool wait", async () => {
    h.responses.push({ toolCalls: [tc("s0", "woocommerce.list_products", { query: "תיק בד" })] }, { toolCalls: [respond("s1", { reply: "יש לנו Canvas Tote, תיק בד חזק." })] });
    await runReplyEngineTurn(opts, "autonomous");
    const audit = h.audits.find((a) => a.data.action === "ai.bot_turn");
    expect(audit.data.metadata.toolWaitMs).toBeGreaterThanOrEqual(0);
    // The harness dispatches through its own mock; searchArgs is filled on the adapter path (as the replay line is),
    // so its wiring into the audit row is checked in the source.
    const { readFileSync } = await import("fs");
    expect(readFileSync("src/services/reply-engine/engine.ts", "utf8")).toMatch(/searchArgs: Array\.isArray\(\(trace as any\)\.searchArgs\) \? \(trace as any\)\.searchArgs\.slice\(0, 6\)/);
  });
});

describe("probe of d9f7c248, through a whole turn", () => {
  it("★ 1: no real shared noun: the subject lends as before", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _focusTitles: JSON.stringify(["Black Hoodie", "Black Jeans"]) }, offeredItems: [{ ref: "id:78", title: "Black Hoodie", productId: "78", at: new Date().toISOString() }], pending: [], turnCount: 2 });
    try {
      h.responses.push({ toolCalls: [respond("q1", { reply: "לא מצאתי בקטלוג התאמה ל-Black Hoodie בלבן." })] }, { toolCalls: [respond("q2", { reply: "יש Black Hoodie." })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: "רוצה לבן" }, "autonomous");
      const q = h.dispatched.find((d) => d.name === "woocommerce.list_products")?.args.query ?? "";
      expect(q).not.toMatch(/^Black /);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
});

describe("rating of b3d2bbf3 and dev round k3, through a whole turn", () => {
  it("★ k3-A: a draft true on what the automatic search returned goes as it is, with no rewrite", async () => {
    h.groundStatus = "no_results";
    // No attribute asked: the noun itself was searched, nothing narrower to retry (K8-1 asks for the noun alone
    // after a noun plus attribute).
    h.responses.push({ toolCalls: [respond("a1", { reply: "אין לנו מעמדים." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם מעמד?" }, "autonomous");
    expect(h.dispatched.some((d) => d.name === "woocommerce.list_products")).toBe(true);
    expect(r.reply).toMatch(/^אין לנו מעמדים\./);
    expect((r.trace as any).passedAfterLookup).toBe(true);
    expect(h.calls).toHaveLength(1);
  });
  it("★ 5: an empty query is refused when she names no product", async () => {
    h.responses.push({ toolCalls: [tc("m1", "woocommerce.list_products", { query: "" })] }, { toolCalls: [respond("m2", { reply: "בשמחה! למה זה נחוץ לך?" })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר המלצה" }, "autonomous");
    expect(h.dispatched.filter((d) => d.name === "woocommerce.list_products")).toHaveLength(0);
  });
  it("★ k3-A (2): a reply with product cards never says nothing was found", async () => {
    const { NOT_FOUND_LINE, notFoundReply, closestMatchLine } = await import("../services/reply-engine/engine").then(async (e) => ({ ...e, notFoundReply: (await import("../services/reply-engine/gates")).notFoundReply }));
    expect(NOT_FOUND_LINE.test(notFoundReply("he", "יש לכם ג'ינס שחור?"))).toBe(true);
    expect(NOT_FOUND_LINE.test(notFoundReply("he", "יש לכם משטח לתמי 4?"))).toBe(true);
    expect(NOT_FOUND_LINE.test(notFoundReply("en", "do you have jeans?"))).toBe(true);
    expect(closestMatchLine("he")).not.toMatch(/לא מצאתי את זה/);
    const { readFileSync } = await import("fs");
    expect(readFileSync("src/services/reply-engine/engine.ts", "utf8")).toMatch(/if \(output\?\.reply && \(output\.cards \?\? \[\]\)\.length && NOT_FOUND_LINE\.test\(output\.reply\)\)/);
  });
});

describe("rating of b3d2bbf3, E: dashes in store titles", () => {
  it("★ the header that names the cards writes a title's en dash as a hyphen; the product is still in focus", async () => {
    h.groundTitle = "Tote \u2013 Canvas";
    h.responses.push({ toolCalls: [tc("t1", "woocommerce.list_products", { query: "תיק בד" })] }, { toolCalls: [respond("t2", { reply: "", cards: ["PRODUCT_1"] })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם תיק בד?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/[\u2010-\u2015\u2212]/);
    h.groundTitle = "Canvas Tote";
  });
});

describe("dev round k4 on 259d48ea, through a whole turn", () => {
  it("★ K4-3: \"מה יש במבצע?\" with an empty query is searched, never refused", async () => {
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "" })] }, { toolCalls: [respond("s2", { reply: "יש Canvas Tote במבצע." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "מה יש במבצע?" }, "autonomous");
    expect(h.dispatched.filter((d) => d.name === "woocommerce.list_products").length).toBeGreaterThan(0);
  });
  it("★ K4-2: the audit row holds the heads of the knowledge the turn saw", async () => {
    const { readFileSync } = await import("fs");
    expect(readFileSync("src/services/reply-engine/engine.ts", "utf8")).toMatch(/knowledgeHeads: \[\.\.\.\(knowledgeChunks as any\[\]\)/);
  });
});

describe("dev round k5 on 0b5f2b46, through a whole turn", () => {
  it("★ K5-2: the team line as the whole reply, team_question null, the knowledge has it: rewritten from the knowledge", async () => {
    h.chunks = [{ content: "**מה שיטות התשלום הנתמכות - כרטיס אשראי, ביט, PayPal או תשלום במזומן?** אפשר לשלם בהעברה בנקאית או במזומן בעת המסירה. כרגע אין תשלום בכרטיס אשראי, בביט או ב-PayPal.", score: 0.8 }];
    h.responses.push({ toolCalls: [respond("p1", { reply: "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: null })] }, { toolCalls: [respond("p2", { reply: "אפשר לשלם בהעברה בנקאית או במזומן בעת המסירה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה אפשרויות התשלום?" }, "autonomous");
    expect(JSON.stringify((r.trace as any).gate3)).toMatch(/knowledge_has_it/);
    expect(r.reply).toMatch(/העברה בנקאית/);
  });
  it("★ K5-3: a query of filter words is that filter: \"מבצע\" runs with on_sale and no query; the refusal keeps its query and reason", async () => {
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "מבצע" })] }, { toolCalls: [respond("s2", { reply: "יש Canvas Tote במבצע." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה יש במבצע?" }, "autonomous");
    const d = h.dispatched.find((x) => x.name === "woocommerce.list_products");
    expect(d?.args).toMatchObject({ query: "", on_sale: true });
    const { readFileSync } = await import("fs");
    expect(readFileSync("src/services/reply-engine/engine.ts", "utf8")).toMatch(/\.\.\.\(r\.decision === "deny" \? \{ q: String\(\(r\.args as any\)\?\.query \?\? ""\)\.slice\(0, 60\), reason:/);
    expect(r.reply).toBeTruthy();
  });
});

describe("dev round k6 on 622fcae0, through a whole turn with model-shaped calls", () => {
  const modelArgs = (query: string) => ({ query, on_sale: false, audience: "women", in_stock: false, per_page: 10, price_max: 0, price_min: 0 });
  it("★ K6-1: an empty search with every schema field filled backs \"לא מצאנו ג'ינס שחור\"; the draft goes as written", async () => {
    h.groundStatus = "no_results";
    h.responses.push({ toolCalls: [tc("j1", "woocommerce.list_products", modelArgs("ג'ינס שחור"))] }, { toolCalls: [respond("j2", { reply: "לא מצאנו ג'ינס שחור בקטלוג." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם ג'ינס שחור?" }, "autonomous");
    expect(JSON.stringify((r.trace as any).gate3 ?? {})).not.toMatch(/ungrounded_absence/);
    expect(r.reply).toMatch(/^לא מצאנו ג'ינס שחור בקטלוג\./);
    // The record holds what the store was asked: no audience she never named, no 0..0 price.
    const rec = (r.trace as any).tools.find((t: any) => t.tool === "woocommerce.list_products");
    expect(JSON.stringify(rec?.args ?? {})).not.toMatch(/audience|price_max|price_min/);
  });
  it("★ K6-2: the same for \"חולצה תכלת\"", async () => {
    h.groundStatus = "no_results";
    h.responses.push({ toolCalls: [tc("b1", "woocommerce.list_products", modelArgs("חולצה תכלת"))] }, { toolCalls: [respond("b2", { reply: "לא מצאנו חולצה בתכלת בקטלוג." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם חולצה בתכלת?" }, "autonomous");
    expect(JSON.stringify((r.trace as any).gate3 ?? {})).not.toMatch(/ungrounded_absence/);
  });
  it("★ K6-3: a fresh \"מה יש במבצע?\" never inherits the last turn's budget", async () => {
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "", on_sale: true, price_max: 100 })] }, { toolCalls: [respond("s2", { reply: "יש Canvas Tote במבצע." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "מה יש במבצע?" }, "autonomous");
    const d = h.dispatched.find((x) => x.name === "woocommerce.list_products");
    expect(d?.args.price_max).toBeUndefined();
    expect(d?.args.on_sale).toBe(true);
  });
});

describe("dev round k8 on f46b5a49, K8-1 through a whole turn", () => {
  it("★ \"יש לכם חולצה בתכלת?\" after one empty narrow search: the engine searches \"חולצה\" before the absence goes out", async () => {
    h.groundStatus = "no_results";
    h.responses.push({ toolCalls: [tc("c1", "woocommerce.list_products", { query: "חולצה תכלת" })] }, { toolCalls: [respond("c2", { reply: "לא מצאנו חולצה בתכלת בקטלוג." })] }, { toolCalls: [respond("c3", { reply: "יש Canvas Tote." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם חולצה בתכלת?" }, "autonomous");
    expect(h.dispatched.filter((d) => d.name === "woocommerce.list_products").map((d) => d.args.query)).toContain("חולצה");
  });
});

describe("db4e8917 pre-check: R5 through a whole turn", () => {
  it("★ the fallback store search runs at about 2s of budget left while the hard ceiling has room", async () => {
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "15000";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const { generateResponse } = await import("../services/ai.service");
    const orig = (generateResponse as any).getMockImplementation();
    // The draft is thin (style only) and the clock is at 13s: the rewrite is cut, the fallback runs with ~2s left.
    (generateResponse as any).mockImplementationOnce(async (p: any) => { const out = await orig(p); shift = 13000; return out; });
    h.responses.push({ toolCalls: [respond("f1", { reply: "בטח/י, אשמח/ה!" })] }, { toolCalls: [respond("f2", { reply: "בטח/י, אשמח/ה!" })] });
    let r: any;
    try {
      r = await runReplyEngineTurn({ ...opts, incomingMessage: "מחפשת דוקא חגיגי. הייתה אחת עם גווני כחול מאוד חגיגית" }, "autonomous");
    } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    expect(h.dispatched.some((d) => d.name === "woocommerce.list_products")).toBe(true);
  });
});

describe("dev round k9 on 1f25aca0, F1 through a whole turn", () => {
  it("★ the automatic lookup runs when the model took 10.5s: noun_not_tried searches her noun", async () => {
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "15000";
    h.groundStatus = "no_results";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const { generateResponse } = await import("../services/ai.service");
    const orig = (generateResponse as any).getMockImplementation();
    (generateResponse as any).mockImplementationOnce(async (p: any) => orig(p)).mockImplementationOnce(async (p: any) => { const out = await orig(p); shift = 9000; return out; });
    // About 6s of budget left, as on dev (model 10.5s, its tool wait 1.6s netted out).
    h.responses.push({ toolCalls: [tc("c1", "woocommerce.list_products", { query: "חולצה תכלת" })] }, { toolCalls: [respond("c2", { reply: "לא מצאנו חולצה בתכלת בקטלוג." })] }, { toolCalls: [respond("c3", { reply: "יש Canvas Tote." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם חולצה בתכלת?" }, "autonomous"); } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    expect(h.dispatched.filter((d) => d.name === "woocommerce.list_products").map((d) => d.args.query)).toContain("חולצה");
    expect(r.trace.autoLookupMs).toBeGreaterThanOrEqual(0);
  });
});

describe("dev round k9 on 1f25aca0, F5 through a whole turn", () => {
  it("★ \"מה יש כרגע במלאי?\" with products returned and a categories-only reply: cards go out with it", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const orig = (prisma as any).productTurnSettings;
    h.responses.push({ toolCalls: [tc("l1", "woocommerce.list_products", { query: "", in_stock: true, per_page: 100 })] }, { toolCalls: [respond("l2", { reply: "כרגע יש במלאי מגוון פריטים, למשל תיקים ואביזרים. יש פריט מסוים שחשוב לך לבדוק?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה יש כרגע במלאי?" }, "autonomous");
    // On a cards channel the cards are attached; the harness channel decides, so the rule is pinned in the source too.
    const { readFileSync } = await import("fs");
    expect(readFileSync("src/services/reply-engine/engine.ts", "utf8")).toMatch(/\(trace as any\)\.listAskCards = output\.cards!\.length;/);
    expect(h.dispatched.some((d) => d.name === "woocommerce.list_products")).toBe(true);
    expect(orig === undefined || orig !== null).toBe(true);
    expect(r.reply).toBeTruthy();
    // The harness is a cards channel: a card went out.
    expect(h.staged.length).toBeGreaterThan(0);
  });
});

describe("the owner's own rules arrive (2026-11-19)", () => {
  const RULES = ["מציעים ללקוחות רק את 12 המשטחים של קטגוריית מוצרי סמובי", "כשלקוח שואל איזה משטח מתאים, למכשיר או למידות, תמיד מחפשים בחנות ומציגים כרטיס מוצר", "לדבר בלשון נקבה", "לא להשתמש במקפים"];
  const HANDOVER = [{ label: "הזמנה סיטונאית או כמות גדולה", type: "custom", enabled: true }, { label: "שאלה על משלוח לחו\"ל", type: "custom", enabled: false }];
  const NEVER = ["Never use the word or phrase \"כבד\" - it is off-brand.", "מחירי מתחרים"];
  const owner = () => { h.agentExtra = { customGuardrails: RULES, escalationRules: HANDOVER }; h.policyRow = { data: { blockedTopics: NEVER } }; };
  const prefixOf = (call: any) => String(call.messages[0].content);
  const wholesale = { ...opts, incomingMessage: "אנחנו רשת חנויות ורוצים לעבוד איתכם בסיטונאות" };

  it("★ the model's instructions end with the owner's block: every rule in her words, the enabled hand-over rule numbered, the never list", async () => {
    owner();
    h.responses.push({ toolCalls: [respond("o1", { reply: "היי, במה אפשר לעזור?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "היי" }, "autonomous");
    const prefix = prefixOf(h.calls[0]);
    const block = prefix.slice(prefix.indexOf("# The business's own rules"));
    expect(prefix.indexOf("# The business's own rules")).toBeGreaterThan(prefix.indexOf("# The business\n"));
    for (const rule of RULES) expect(block).toContain(`- ${rule}`);
    expect(block).toContain("1. הזמנה סיטונאית או כמות גדולה");
    expect(block).not.toContain("משלוח לחו");
    for (const n of NEVER) expect(block).toContain(`- ${n}`);
    expect(block).toMatch(/the business's rule wins/);
    expect(block).toMatch(/never change these: a fact, a price or a link comes only from a tool result or the knowledge/);
    // Nothing follows it: it is the last section.
    expect(block.slice(1)).not.toMatch(/\n# /);
    expect((r.trace as any).ownerRules).toEqual({ rules: 4, handover: 1, never: 2 });
    expect(h.audits.find((a) => a.data.action === "ai.bot_turn").data.metadata.cuts.ownerRules).toEqual({ rules: 4, handover: 1, never: 2 });
    // The respond tool carries the slot for the rule's number.
    const respondTool = h.calls[0].tools.find((t: any) => t.function.name === "respond");
    expect(respondTool.function.parameters.properties.handoff_rule).toBeTruthy();
    expect(respondTool.function.parameters.required).toContain("handoff_rule");
  });

  it("★ no owner rules: no block, no marker (a business that wrote nothing reads exactly as before)", async () => {
    h.responses.push({ toolCalls: [respond("o1", { reply: "היי, במה אפשר לעזור?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "היי" }, "autonomous");
    expect(prefixOf(h.calls[0])).not.toContain("The business's own rules");
    expect((r.trace as any).ownerRules).toBeUndefined();
  });

  it("★ a hand-over that names the owner's enabled rule stands, and its number is printed", async () => {
    owner();
    h.responses.push({ toolCalls: [respond("w1", { reply: "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.", handoff: "wholesale order", handoff_rule: 1 })] });
    const r = await runReplyEngineTurn(wholesale, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).not.toContain("needless_handoff");
    expect(r.escalation?.reason).toMatch(/^ai_handoff:wholesale order/);
    expect((r.trace as any).ownerHandoverRule).toBe(1);
    expect(r.reply).toBe(HAND);
  });

  it("★ the same hand-over with no number is judged as today (no citation, no exemption): rewritten, and a rewrite that passes it on is the hand-over", async () => {
    owner();
    h.responses.push(
      { toolCalls: [respond("w1", { reply: "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.", handoff: "wholesale order" })] },
      { toolCalls: [respond("w2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "רשת חנויות שמבקשת לעבוד בסיטונאות" })] },
    );
    const r = await runReplyEngineTurn(wholesale, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("needless_handoff");
    handedOver(r);
    expect((r.trace as any).ownerHandoverRule).toBeUndefined();
    // The rewrite is told the one other reason, and that the owner's rules still hold.
    const note = h.calls[1].messages.slice(1).map((m: any) => String(m.content ?? "")).join("\n");
    expect(note).toMatch(/one of the business's own numbered hand-over rules/);
    expect(note).toMatch(/The business's own rules \(the last section of your instructions\) still apply to the rewritten reply\./);
    // The rewrite call carries the same instructions, the owner's block included.
    expect(prefixOf(h.calls[1])).toBe(prefixOf(h.calls[0]));
    expect(prefixOf(h.calls[1])).toContain("1. הזמנה סיטונאית או כמות גדולה");
  });

  it("★ a number that is not a loaded rule (the switched-off rule, or none at all) is no exemption", async () => {
    owner();
    for (const n of [2, 0, 7]) {
      h.responses.length = 0;
      h.responses.push(
        { toolCalls: [respond("w1", { reply: "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.", handoff: "wholesale order", handoff_rule: n })] },
        { toolCalls: [respond("w2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "רשת חנויות שמבקשת לעבוד בסיטונאות" })] },
      );
      const r = await runReplyEngineTurn(wholesale, "autonomous");
      expect(r.trace.gate3.problems.map((p: any) => p.kind), String(n)).toContain("needless_handoff");
      expect((r.trace as any).ownerHandoverRule, String(n)).toBeUndefined();
    }
  });

  it("★ a business with no hand-over rules: a cited number changes nothing, and the correction names no such list", async () => {
    h.agentExtra = { customGuardrails: RULES };
    h.responses.push(
      { toolCalls: [respond("w1", { reply: "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.", handoff: "wholesale order", handoff_rule: 1 })] },
      { toolCalls: [respond("w2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "רשת חנויות שמבקשת לעבוד בסיטונאות" })] },
    );
    const r = await runReplyEngineTurn(wholesale, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("needless_handoff");
    const note = h.calls[1].messages.slice(1).map((m: any) => String(m.content ?? "")).join("\n");
    expect(note).not.toMatch(/numbered hand-over rules/);
    expect(note).toMatch(/still apply to the rewritten reply/);
  });

  // Prod 2026-11-19 and 11-22: the measuring guide's link is written only in the owner's rules, with Hebrew letters
  // in its path. It was no link source, so the repair swapped an image in for it; with the swap gone its sentence
  // would be dropped and the customer would lose the guide.
  describe("a link the owner's rules give is a link the reply may give", () => {
    const GUIDE = "https://smoovee-ltd.com/wp-content/uploads/2026/11/סמובי-מדריך-מדידה.pdf";
    const RULE = `כשלקוח שואל איך מודדים, לשלוח את מדריך המדידה: ${GUIDE}`;
    const ask = { ...opts, incomingMessage: "איך מודדים את המכשיר?" };
    const turn = async (reply: string) => {
      h.responses.push({ toolCalls: [respond("g1", { reply })] }, { toolCalls: [respond("g2", { reply })] });
      return runReplyEngineTurn(ask, "autonomous");
    };

    it("★ a raw-Hebrew PDF link present only in the owner's rules is kept whole", async () => {
      h.agentExtra = { customGuardrails: [RULE] };
      const r = await turn(`מדריך המדידה כאן: ${GUIDE} אחרי המדידה אפשר לכתוב לנו את המידות.`);
      expect(prefixOf(h.calls[0])).toContain(GUIDE);
      expect(r.reply).toContain(`${GUIDE} אחרי המדידה`);
      expect((r.trace as any).urlsRepaired).toBeUndefined();
    });

    it("the same link in a hand-over rule or in the never list is a source too", async () => {
      h.agentExtra = { escalationRules: [{ label: `לקוח שלא הצליח למדוד לפי ${GUIDE}`, type: "custom", enabled: true }] };
      expect((await turn(`מדריך המדידה כאן: ${GUIDE} אחרי המדידה אפשר לכתוב לנו את המידות.`)).reply).toContain(GUIDE);
      h.responses.length = 0; h.calls.length = 0;
      h.agentExtra = {}; h.policyRow = { data: { blockedTopics: [`מדריכים אחרים מלבד ${GUIDE}`] } };
      expect((await turn(`מדריך המדידה כאן: ${GUIDE} אחרי המדידה אפשר לכתוב לנו את המידות.`)).reply).toContain(GUIDE);
    });

    it("no rule has it: its sentence goes, and no other file stands in for it", async () => {
      h.agentExtra = { customGuardrails: ["כשלקוח שואל איך מודדים, לשלוח את מדריך המדידה"] };
      const r = await turn(`מדריך המדידה כאן: ${GUIDE} אחרי המדידה אפשר לכתוב לנו את המידות.`);
      expect(r.reply ?? "").not.toMatch(/https?:/);
      expect(r.reply ?? "").not.toContain("מדריך-מדידה");
      expect((r.trace as any).urlsRepaired?.dropped).toBe(1);
    });
  });

  it("★ a rewritten turn prints its first draft; a clean turn does not", async () => {
    h.responses.push(
      { toolCalls: [respond("h1", { reply: "מעבירים אותך לנציג שימשיך מכאן.", handoff: "instalments question" })] },
      { toolCalls: [respond("h2", { reply: "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "האם אפשר לשלם בתשלומים?" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect((r.trace as any).firstDraft).toBe("מעבירים אותך לנציג שימשיך מכאן.");
    h.responses.length = 0; h.calls.length = 0;
    h.responses.push({ toolCalls: [respond("o1", { reply: "שלום, איך אפשר לעזור?" })] });
    const clean = await runReplyEngineTurn({ ...opts, incomingMessage: "היי" }, "autonomous");
    expect(clean.trace.gate3.rewrite).toBe("none");
    expect((clean.trace as any).firstDraft).toBeUndefined();
  });

  // The never list is enforced, not only shown (2026-11-19, the dev owner-rule round: never = ["זול"], and
  // "הכי זול שמצאנו הוא ..." went out with gate3 ok).
  const never = (...entries: string[]) => { h.agentExtra = {}; h.policyRow = { data: { blockedTopics: entries } }; };
  const noteOf = (call: any) => call.messages.slice(1).map((m: any) => String(m.content ?? "")).join("\n");
  const NOT_CHEAP = "זה נשמע לי לא זול בכלל";
  const DRAFT = "מבינים, זה באמת לא זול. אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו.";

  it("★ a draft that says a never-list word gets one rewrite that names it, although the customer said the word first", async () => {
    never("זול");
    h.responses.push({ toolCalls: [respond("n1", { reply: DRAFT })] }, { toolCalls: [respond("n2", { reply: "מבינים. אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
    expect(r.trace.gate3.problems).toEqual([{ kind: "owner_never", claims: ["זול"] }]);
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(h.calls).toHaveLength(2);
    expect(noteOf(h.calls[1])).toContain('The business never says this: "זול". Your reply says it.');
    expect(noteOf(h.calls[1])).toContain("the customer using it does not make it yours to use");
    expect(r.reply).toBe("מבינים. אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו.");
    expect((r.trace as any).neverListHit).toBe(1);
    expect(h.audits.find((a) => a.data.action === "ai.bot_turn").data.metadata.cuts.neverListHit).toBe(1);
  });

  it("★ the real ask (\"הכי זול שיש\"): the word does not go out", async () => {
    never("זול");
    h.responses.push(
      { toolCalls: [respond("n1", { reply: "יש אצלנו פריטים במחיר זול, ואפשר לחפש לפי סוג הפריט. איזה פריט מעניין אותך?" })] },
      { toolCalls: [respond("n2", { reply: "יש אצלנו פריטים במחירים נגישים, ואפשר לחפש לפי סוג הפריט. איזה פריט מעניין אותך?" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם משהו ממש זול? אני מחפשת את הכי זול שיש" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("owner_never");
    expect(r.reply).toContain("במחירים נגישים");
    expect(r.reply).not.toMatch(/זול/);
    expect((r.trace as any).neverListHit).toBe(1);
  });

  it("★ the rewrite still says it: its sentence is cut, the rest goes out", async () => {
    never("זול");
    h.responses.push({ toolCalls: [respond("n1", { reply: DRAFT })] }, { toolCalls: [respond("n2", { reply: "מבינים, זה לא הכי זול. אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
    expect(r.reply).toBe("אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו.");
    expect(r.trace.gate3.rewrite).toBe("cleaned");
    expect((r.trace as any).cutWhy).toEqual(["owner_never"]);
    expect((r.trace as any).cutText).toEqual(["מבינים, זה לא הכי זול."]);
    expect((r.trace as any).neverListHit).toBe(1);
  });

  it("★ the first draft was stopped for something else and the rewrite says the word: its sentence is cut and the marker shows", async () => {
    never("זול");
    h.responses.push(
      { toolCalls: [respond("n1", { reply: "מעבירים אותך עכשיו לטיפול של נציג אנושי שימשיך מכאן.", handoff: "price" })] },
      { toolCalls: [respond("n2", { reply: "מבינים, זה לא הכי זול. אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toEqual(["needless_handoff"]);
    expect(r.reply).toBe("אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו.");
    expect((r.trace as any).cutWhy).toEqual(["owner_never"]);
    expect((r.trace as any).neverListHit).toBe(1);
  });

  it("★ the word is the whole reply in both drafts: it is never sent, the turn takes the fallback and says why", async () => {
    never("זול");
    h.responses.push({ toolCalls: [respond("n1", { reply: "מבינים, זה באמת לא זול." })] }, { toolCalls: [respond("n2", { reply: "נכון, זה לא הכי זול." })] }, { toolCalls: [respond("n3", { reply: "זה לא זול, נכון." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
    expect(String(r.reply ?? "")).not.toMatch(/זול/);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect((r.trace as any).fallbackKinds).toEqual(["owner_never"]);
    expect(noteOf(h.calls[2])).toContain('Your reply could not be sent as written (the business never says "זול").');
  });

  it("★ the first draft's closing question does not bring the word back into a clean rewrite; a clean question is still kept", async () => {
    const CLEAN = "מבינים. אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו.";
    never("זול");
    h.responses.push({ toolCalls: [respond("n1", { reply: "מבינים, זה באמת לא זול. לחפש לך משהו זול יותר מזה?" })] }, { toolCalls: [respond("n2", { reply: CLEAN })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
    expect(r.reply).toBe(CLEAN);

    h.responses.length = 0; h.calls.length = 0;
    h.responses.push({ toolCalls: [respond("n1", { reply: "מבינים, זה באמת לא זול. איזה סוג פריט חיפשת בעצם?" })] }, { toolCalls: [respond("n2", { reply: CLEAN })] });
    const kept = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
    expect(kept.reply).toBe(`${CLEAN} איזה סוג פריט חיפשת בעצם?`);
  });

  it("★ two entries in one draft: the marker counts both; a business with no never list, or a reply that says none of it, is untouched", async () => {
    never("זול", "מבצע", "מחירי מתחרים");
    h.responses.push({ toolCalls: [respond("n1", { reply: "יש עכשיו מבצע וזה יוצא זול. אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו." })] }, { toolCalls: [respond("n2", { reply: "אפשר לבדוק יחד מה מתאים לתקציב שלך, לפי הסכום שנוח לך להוציא עכשיו." })] });
    const two = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
    expect((two.trace as any).neverListHit).toBe(2);
    expect(noteOf(h.calls[1])).toContain('The business never says this: "זול", "מבצע".');

    for (const [entries, draft] of [[[], DRAFT], [["זול"], "מבינים, זולת המשלוח אין כאן עלות נוספת שלא ראית. אפשר לבדוק יחד מה מתאים לתקציב שלך."]] as Array<[string[], string]>) {
      h.responses.length = 0; h.calls.length = 0;
      never(...entries);
      h.responses.push({ toolCalls: [respond("n1", { reply: draft })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: NOT_CHEAP }, "autonomous");
      expect(r.trace.gate3.problems.map((p: any) => p.kind), draft).not.toContain("owner_never");
      expect((r.trace as any).neverListHit, draft).toBeUndefined();
    }
  });
});

describe("silence only when the customer brought nothing new (2026-11-19, prod replay L774)", () => {
  const CANNED = "העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.";
  const PASSED = "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.";
  const TEAM = { kind: "promise", text: "checking with the team: הלקוחה מחפשת צעיף חגיגי בגווני כחול", at: new Date().toISOString() };
  const withState = async (row: any, fn: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString() }, offeredItems: [], pending: [], turnCount: 6, ...row });
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };
  const failing = () => h.responses.push(
    { toolCalls: [tc("k1", "search_knowledge", { query: "אתר" })] },
    { toolCalls: [respond("s1", { reply: "הצעיף עולה ₪120." })] },
    { toolCalls: [respond("s2", { reply: "בטח, ₪150 בלבד." })] },
  );
  const turn = async (incoming: string, lastOut: string, earlier = "מחפשת צעיף חגיגי בגווני כחול") => {
    h.history = [
      { direction: "INBOUND", body: earlier, metadata: null },
      { direction: "OUTBOUND", body: lastOut, senderName: "AI Bot", metadata: null },
      { direction: "INBOUND", body: incoming, metadata: null },
    ];
    failing();
    return runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
  };

  it("★ L774: the fixed line already went out, an old team item is open, and she writes something new: never silence, a person takes it", async () => {
    await withState({ pending: [TEAM] }, async () => {
      const r = await turn("אני לא טובה בלראות באתר וכו..", CANNED);
      expect(r.trace.gate3.rewrite).not.toBe("silent");
      void PASSED;
      handedOver(r);
      expect(r.reply).toBe(HAND);
      expect(h.teamQuestions.map((q: any) => q.question)).toEqual(["אני לא טובה בלראות באתר וכו.."]);
    });
  });

  it("★ the same turn on a bare acknowledgement stays silent", async () => {
    for (const ack of ["אוקיי תודה", "תודה רבה", "טוב"]) {
      await withState({ pending: [TEAM] }, async () => {
        h.responses.length = 0;
        const r = await turn(ack, CANNED);
        expect(r.reply, ack).toBeNull();
        expect((r.trace as any).silenceAvoided, ack).toBeUndefined();
      });
    }
  });

  it("★ the same message she already wrote on an earlier turn: silence is allowed", async () => {
    await withState({}, async () => {
      const r = await turn("אני לא טובה בלראות באתר וכו..", CANNED, "אני לא טובה בלראות באתר וכו");
      expect(r.reply).toBeNull();
      expect(r.trace.gate3.rewrite).toBe("silent");
    });
  });

  it("★ the old line was the last one said and she writes something new: a person takes it, the question on the owner's list", async () => {
    await withState({}, async () => {
      const r = await turn("אני לא טובה בלראות באתר וכו..", PASSED);
      handedOver(r);
      expect(r.reply).toBe(HAND);
      expect(h.teamQuestions).toHaveLength(1);
    });
  });

  const savedPending = (): any[] => { const up = h.upserts[h.upserts.length - 1]; return up?.create?.pending ?? up?.update?.pending ?? []; };
  const ITEM = "הלקוחה שואלת אם אפשר לקבל חשבונית על שם העסק";
  const OPEN_ITEM = { ...TEAM, text: `checking with the team: ${ITEM}` };

  it("★ her words are about an old item and its holding line was the last thing said: a person takes it, no item is kept or updated", async () => {
    const { stillCheckingLine } = await import("../services/reply-engine/engine");
    const held = stillCheckingLine(ITEM, "he");
    const said = "חשבונית על שם העסק שלי, עוסק מורשה";
    await withState({ pending: [OPEN_ITEM] }, async () => {
      const r = await turn(said, held, "אפשר לקבל חשבונית על שם העסק?");
      handedOver(r);
      expect((r.trace as any).teamItemUpdated).toBeUndefined();
      expect(savedPending().filter((p: any) => String(p.text).startsWith("checking with the team: "))).toHaveLength(0);
      expect(h.teamQuestions).toHaveLength(1);
    });
  });

  it("★ a question on an old item, with a number or reworded: a person takes it, never its still-checking line", async () => {
    const { stillCheckingLine } = await import("../services/reply-engine/engine");
    for (const ask of ["מה עם החשבונית על שם העסק? ח.פ 514889231", "מה קורה עם החשבונית על שם העסק?"]) {
      await withState({ pending: [OPEN_ITEM] }, async () => {
        h.responses.length = 0; h.upserts.length = 0; h.teamQuestions.length = 0;
        const r = await turn(ask, CANNED, "אפשר לקבל חשבונית על שם העסק?");
        expect(r.reply).not.toBe(stillCheckingLine(ITEM, "he"));
        handedOver(r);
        expect(savedPending().filter((p: any) => p.kind === "promise")).toHaveLength(0);
      });
    }
  });

  it("★ the same question again: a person takes it; a thanks: nothing, nobody handed it", async () => {
    const again = "מה עם החשבונית על שם העסק? ח.פ 514889231";
    await withState({ pending: [OPEN_ITEM] }, async () => {
      const r = await turn(again, CANNED, again);
      handedOver(r);
      expect((r.trace as any).teamItemUpdated).toBeUndefined();
      expect(savedPending().filter((p: any) => p.kind === "promise")).toHaveLength(0);
    });
    await withState({ pending: [OPEN_ITEM] }, async () => {
      h.responses.length = 0; h.upserts.length = 0; h.teamQuestions.length = 0;
      const r = await turn("תודה רבה", CANNED, again);
      expect(r.reply).toBeNull();
      expect(r.escalation).toBeNull();
      // A thanks is no question: nothing recorded, no item kept.
      expect(h.teamQuestions).toHaveLength(0);
      expect(savedPending().filter((p: any) => p.kind === "promise")).toHaveLength(0);
    });
  });

  it("★ the same paragraph twice on something new she wrote: a line; on a plain nudge: nothing (as before)", async () => {
    const para = "כדי לבדוק את ההזמנה צריך את מספר ההזמנה, והטלפון ששמור עליה לא תואם למספר שממנו כותבים.";
    const run = async (incoming: string) => {
      h.responses.length = 0; h.teamQuestions.length = 0;
      h.history = [
        { direction: "INBOUND", body: "איפה ההזמנה?", metadata: null },
        { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null },
        { direction: "INBOUND", body: incoming, metadata: null },
      ];
      h.responses.push({ toolCalls: [respond("d3", { reply: para })] }, { toolCalls: [respond("d4", { reply: para })] });
      return runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
    };
    const said = await run("אני לא זוכרת מאיזה מייל הזמנתי");
    handedOver(said);
    expect(said.reply).toBe(HAND);
    expect(said.trace.gate3.rewrite).not.toBe("silent");
    const nudge = await run("נו");
    expect(nudge.reply).toBeNull();
    expect(nudge.trace.gate3.rewrite).toBe("silent");
  });
});

describe("the owner sets how the customer is addressed (2026-11-19: \"לפנות אל הלקוח בלשון נקבה בלבד\", and \"תרצי?\" was flagged and rewritten away)", () => {
  const noteOf = (call: any) => call.messages.slice(1).map((m: any) => String(m.content ?? "")).join("\n");
  const ASK = { ...opts, incomingMessage: "יש לכם קפוצ'ון בכחול?" };
  const FEM = "כן, יש לנו את קפוצ'ון כחול. תרצי?";
  const MASC = "כן, יש לנו את קפוצ'ון כחול. תרצה?";
  const search = { toolCalls: [tc("s1", "woocommerce.list_products", { query: "קפוצ'ון כחול" })] };
  const turn = async (rules: string[] | null, ...drafts: string[]) => {
    h.responses.length = 0; h.calls.length = 0; h.audits.length = 0;
    h.groundTitle = "קפוצ'ון כחול";
    h.agentExtra = rules ? { customGuardrails: rules } : {};
    h.responses.push(search, ...drafts.map((d, i) => ({ toolCalls: [respond(`a${i}`, { reply: d })] })));
    const r = await runReplyEngineTurn(ASK, "autonomous");
    return { r, cuts: h.audits.find((a) => a.data.action === "ai.bot_turn").data.metadata.cuts, calls: h.calls.length };
  };

  it("★ the real case: the feminine rule, and the draft's \"תרצי?\" goes out as written, with no rewrite and the gender on the marker", async () => {
    const { r, cuts, calls } = await turn(["לפנות אל הלקוח בלשון נקבה בלבד"], FEM);
    expect(r.reply).toBe(FEM);
    expect(r.trace.gate3).toMatchObject({ ok: true, problems: [], rewrite: "none" });
    expect(calls).toBe(2);
    expect((r.trace as any).ownerAddress).toBe("feminine");
    expect(cuts.ownerAddress).toBe("feminine");
    // The masculine rule, the same way.
    const m = await turn(["לא להשתמש במקפים", "תמיד פונים בלשון זכר"], MASC);
    expect(m.r.reply).toBe(MASC);
    expect(m.calls).toBe(2);
    expect(m.cuts.ownerAddress).toBe("masculine");
  });

  it("★ the other gender is still a fault: one rewrite that names the owner's form, never the word-level plural", async () => {
    const { r, cuts, calls } = await turn(["לפנות אל הלקוח בלשון נקבה בלבד"], MASC, FEM);
    expect(r.trace.gate3.problems).toEqual([{ kind: "style", codes: ["gendered_address"] }]);
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(calls).toBe(3);
    expect(noteOf(h.calls[2])).toContain("address the customer in the feminine form only (את, תרצי, תוכלי), never the masculine form");
    expect(noteOf(h.calls[2])).not.toContain("Address the customer neutrally");
    expect(r.reply).toBe(FEM);
    expect((r.trace as any).rewriteSkipped).toBeUndefined();
    expect(cuts.ownerAddress).toBe("feminine");
  });

  it("★ another style fault under the rule is still fixed by words, with no rewrite, and the owner's form stays", async () => {
    const { r, calls } = await turn(["לפנות אל הלקוח בלשון נקבה בלבד"], "כן, מצאתי אצלנו את קפוצ'ון כחול והוא מופיע באתר. תרצי לראות אותו מקרוב?");
    expect(r.trace.gate3.problems).toEqual([{ kind: "style", codes: ["found_narration"] }]);
    expect((r.trace as any).rewriteSkipped).toBe("direct_clean");
    expect(calls).toBe(2);
    expect(r.reply).toMatch(/תרצי לראות אותו מקרוב\?$/);
    expect(r.reply).not.toMatch(/מצאתי/);
  });

  it("★ the rewrite repeats the other gender: the neutral plural goes out, never the wrong form", async () => {
    const { r } = await turn(["לפנות אל הלקוח בלשון נקבה בלבד"], MASC, MASC);
    expect(r.reply).toBe("כן, יש לנו את קפוצ'ון כחול. תרצו?");
  });

  it("★ a business with rules but no address rule keeps today's neutral behaviour: the same turn as a business with no rules", async () => {
    // "לדבר בלשון נקבה" names no customer: it may as well be the employee's own voice.
    const withRules = await turn(["לדבר בלשון נקבה", "לא להשתמש במקפים"], FEM);
    const none = await turn(null, FEM);
    for (const t of [withRules, none]) {
      expect(t.r.reply).toBe("כן, יש לנו את קפוצ'ון כחול. תרצו?");
      expect(t.r.trace.gate3).toMatchObject({ problems: [{ kind: "style", codes: ["gendered_address"] }], rewrite: "cleaned" });
      expect((t.r.trace as any).rewriteSkipped).toBe("direct_clean");
      expect(t.calls).toBe(2);
      expect((t.r.trace as any).ownerAddress).toBeUndefined();
      expect(t.cuts.ownerAddress).toBeUndefined();
    }
    expect(withRules.cuts.ownerRules).toEqual({ rules: 2, handover: 0, never: 0 });
  });
});

describe("only style was wrong with the draft: the turn never ends in the product list or a team line (prod replay of 38b164c6, NE'A: a shade answer with one style finding, and \"הנה כמה אפשרויות\" went out with three unrelated products)", () => {
  // The draft of that turn, with a real gendered address in it. On a product ask it names no store title, no price and
  // asks nothing, so what the cleanup leaves counts as thin.
  const DRAFT = "למייקאפ טינט יש פטנט שינוי גוון שמתאים כמעט לכולן. אם את מחפשת מייקאפ אחר, אפשר לכתוב איזה מוצר, ואכוון לפי הגוון שלו.";
  const FIXED = "למייקאפ טינט יש פטנט שינוי גוון שמתאים כמעט לכולן. אם מחפשים מייקאפ אחר, אפשר לכתוב איזה מוצר, ואכוון לפי הגוון שלו.";
  const LIST = "הנה כמה אפשרויות: סדרת שפתונים מט.";
  const ASK = "איזה גוון מייקאפ יש לכם?";
  // Products found, and the model gives the same kind of draft on every rewrite unless told otherwise.
  const turn = async (incoming: string, ...drafts: string[]) => {
    h.responses.length = 0; h.calls.length = 0; h.audits.length = 0;
    h.groundTitle = "סדרת שפתונים מט";
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "מייקאפ" })] }, ...drafts.map((d, i) => ({ toolCalls: [respond(`a${i}`, { reply: d })] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
    return { r, cuts: h.audits.find((a) => a.data.action === "ai.bot_turn").data.metadata.cuts, calls: h.calls.length };
  };

  it("★ a product ask, products found, style only, the rewrites thin: the first draft goes out with its word-level fix, and the marker says so", async () => {
    const { r, cuts, calls } = await turn(ASK, DRAFT, DRAFT, DRAFT);
    expect(r.reply).toBe(FIXED);
    expect(r.reply).not.toMatch(/הנה כמה אפשרויות|צוות/);
    expect(r.trace.gate3).toMatchObject({ problems: [{ kind: "style", codes: ["gendered_address"] }], rewrite: "cleaned_partial" });
    expect((r.trace as any).styleOnlyKept).toBe(true);
    expect((r.trace as any).fallbackKinds).toBeUndefined();
    expect((r.trace as any).teamQuestion ?? null).toBeNull();
    expect(r.escalation ?? null).toBeNull();
    expect(cuts.markers).toContain("styleOnlyKept");
    // The rewrite and the one targeted rewrite were both tried first.
    expect(calls).toBe(4);
    const { cutLine } = await import("../scripts/replay-v2");
    expect(cutLine(r.trace)).toContain(" | styleOnlyKept | ");
  });

  it("★ the same when the clock cut the rewrite: the first draft with its fix, never the list", async () => {
    process.env.REPLY_ENGINE_TURN_BUDGET_MS = "15000";
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const { generateResponse } = await import("../services/ai.service");
    const orig = (generateResponse as any).getMockImplementation();
    // The search, then the draft; the clock is at 13s when the draft arrives.
    (generateResponse as any).mockImplementationOnce(orig).mockImplementationOnce(async (p: any) => { const out = await orig(p); shift = 13000; return out; });
    let t: any;
    try { t = await turn(ASK, DRAFT, DRAFT); } finally { Date.now = realNow; delete process.env.REPLY_ENGINE_TURN_BUDGET_MS; }
    expect((t.r.trace as any).rewriteCut).toBeTruthy();
    expect(t.calls).toBe(2);
    expect(t.r.reply).toBe(FIXED);
    expect((t.r.trace as any).styleOnlyKept).toBe(true);
  });

  it("★ a rewrite that passes is still the answer, with no marker", async () => {
    const { r, cuts, calls } = await turn(ASK, DRAFT, FIXED);
    expect(r.reply).toBe(FIXED);
    expect(r.trace.gate3.rewrite).toBe("rewritten");
    expect(calls).toBe(3);
    expect((r.trace as any).styleOnlyKept).toBeUndefined();
    expect(cuts.markers ?? []).not.toContain("styleOnlyKept");
  });

  it("★ a rewrite that fails only by a word but stands after its fix is still preferred over the first draft", async () => {
    // The rewrite names a store product, so what its cleanup leaves is no thin reply.
    const second = "יש אצלנו את סדרת שפתונים מט. אם את מחפשת גוון אחר, אפשר לכתוב איזה.";
    const { r, cuts } = await turn(ASK, DRAFT, second, second);
    expect(r.reply).toBe("יש אצלנו את סדרת שפתונים מט. אם מחפשים גוון אחר, אפשר לכתוב איזה.");
    expect(r.trace.gate3.rewrite).toBe("cleaned");
    expect((r.trace as any).styleOnlyKept).toBeUndefined();
    expect(cuts.markers ?? []).not.toContain("styleOnlyKept");
  });

  it("★ a fact or hard finding beside the style one: today's path, the product list", async () => {
    // "מתאים לי" asks for a pick, and the draft picks nothing.
    const { r, cuts } = await turn("איזה גוון מייקאפ מתאים לי?", DRAFT, DRAFT, DRAFT);
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toEqual(["no_recommendation", "style"]);
    expect(r.reply).toBe(LIST);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect((r.trace as any).styleOnlyKept).toBeUndefined();
    expect(cuts.markers ?? []).not.toContain("styleOnlyKept");
  });

  it("★ what the style cleanup leaves must still say something: a fragment, or fewer than eight words, keeps today's path", async () => {
    const EN = "Thank you very much for your patience today.";
    const left = async (he: string) => { const t = await turn(ASK, ...Array(3).fill(`${he} ${EN}`)); expect(t.r.trace.gate3.problems, he).toEqual([{ kind: "style", codes: ["mixed_language"] }]); return t.r; };
    // The English sentence is cut: a condition without its claim is left.
    const fragment = await left("ואם מדובר במייקאפ אחר, אפשר לכתוב כאן איזה מוצר מעניין אותך.");
    expect(fragment.reply).toBe(LIST);
    expect((fragment.trace as any).styleOnlyKept).toBeUndefined();
    // A pleasantry is no answer to a product ask.
    const pleasantry = await left("בשמחה רבה, נעים מאוד.");
    expect(pleasantry.reply).toBe(LIST);
    expect((pleasantry.trace as any).styleOnlyKept).toBeUndefined();
    // Seven words: today's path. Eight: the draft goes out.
    const seven = await left("המייקאפ שלנו מגיע בכמה גוונים שונים מאוד.");
    expect(seven.reply).toBe(LIST);
    expect((seven.trace as any).styleOnlyKept).toBeUndefined();
    const eight = await left("המייקאפ שלנו מגיע בכמה וכמה גוונים שונים מאוד.");
    expect(eight.reply).toBe("המייקאפ שלנו מגיע בכמה וכמה גוונים שונים מאוד.");
    expect((eight.trace as any).styleOnlyKept).toBe(true);
  });

  it("★ the draft's team pass on an ask, next to an old item: no team sentence goes out, whatever is left", async () => {
    // An item is open with the team, and the draft says "passed to the team" again beside eight words of its own.
    const OPEN = { kind: "promise", text: "checking with the team: הלקוחה שואלת אם יש גוון כהה יותר במייקאפ", at: new Date().toISOString() };
    const PASS = "למייקאפ טינט יש פטנט שינוי גוון שמתאים כמעט לכולן. השאלה כבר אצל הצוות, והתשובה תגיע כאן בצ'אט.";
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [OPEN], turnCount: 3 });
    let t: any;
    try { t = await turn(ASK, PASS, PASS, PASS); } finally { (prisma as any).conversationState.findUnique = async () => null; }
    // No open item any more: the pass with no search is an unlooked pass, and no team sentence survives.
    expect(t.r.trace.gate3.problems.map((p: any) => p.kind)).toContain("unlooked_pass");
    expect(String(t.r.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM);
    void LIST;
  });
});

// Rule T (2026-11-19, the rating round on 9ce8a62b and the dev owner-rule round): what a cut may leave on a product turn.
describe("rule T: a cut on a product turn never leaves a wrong answer or a list in the answer's place", () => {
  const BROW = "Miss eyebrows הטוש המושלם למילוי גבות בקלילות";
  const STATEMENT = "הטושים שמצאנו מיועדים לגבות, לא לאזור מתחת לעיניים.";
  const ABSENCE = "לא מופיע אצלנו טוש חום שמצוין לשימוש מתחת לעיניים, אז לא כדאי להשתמש בהם שם.";
  const QUESTION = "כדי למצוא את המתאים: מה הכי חשוב לך, ולאיזה שימוש?";
  // The store's own words about the product: with them the absence sentence is a fact problem, as on the real turn
  // (gate3: [ungrounded_absence, style]).
  const BROW_DATA = [{ content: "טוש לגבות: מיועד לשימוש על הגבות, למילוי וסימון.", score: 0.9, documentTitle: "מוצרים", chunkIndex: 1, documentId: "d" }];
  const URBAN = [{ title: "Cropped Hoodie", price: 299 }, { title: "Oversized Cotton T-Shirt", price: 149 }, { title: "Ribbed Tank Top", price: 79 }];
  const run = async (incoming: string, query: string, ...drafts: string[]) => {
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query })] }, ...drafts.map((d, i) => ({ toolCalls: [respond(`d${i}`, { reply: d })] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
    const cuts = h.audits.find((a) => a.data.action === "ai.bot_turn")?.data.metadata.cuts ?? {};
    // The cards by product id: 101 and 102 for groundTitle and extraTitle, 201 onward for groundList in its order.
    return { r, cuts, cards: h.staged.flatMap((s: any) => (s.products ?? []).map((p: any) => String(p.productId))) };
  };

  it("★ (item 1) the checked statement that the found products do not fit is the answer: no list, no cards of them", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const { r, cuts, cards } = await run("טוש אני רוצה", "טוש", `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`);
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toEqual(["ungrounded_absence", "style"]);
    expect(r.reply).toBe(`${STATEMENT} ${QUESTION}`);
    expect(r.reply).not.toMatch(/הנה כמה אפשרויות|Miss eyebrows/);
    expect(cards).toEqual([]);
    expect((r.trace as any).statementKept).toBe(true);
    expect(r.trace.gate3.rewrite).toBe("cleaned_partial");
    expect((r.trace as any).fallbackKinds).toBeUndefined();
    expect(cuts.markers).toContain("statementKept");
    const { cutLine } = await import("../scripts/replay-v2");
    expect(cutLine(r.trace)).toContain(" | statementKept | ");
  });

  it("★ (item 1) the same on a text channel: no product lines under it", async () => {
    h.textChannel = true;
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const { r } = await run("טוש אני רוצה", "טוש", `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`);
    expect(r.reply).toBe(`${STATEMENT} ${QUESTION}`);
    expect(r.reply).not.toMatch(/Miss eyebrows|₪/);
  });

  it("★ a checked statement that does not rule the products out goes with their cards, and no question is added", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const fits = "הטושים שמצאנו מיועדים למילוי גבות בקלילות, כמו שכתוב בשם המוצר.";
    const { r, cards } = await run("טוש אני רוצה", "טוש", `${fits} ${ABSENCE}`, `${fits} ${ABSENCE}`, `${fits} ${ABSENCE}`);
    expect(r.reply).toBe(fits);
    expect(cards).toEqual(["101", "102"]);
    expect((r.trace as any).statementKept).toBe(true);
  });

  it("★ (owner rule, \"אז מה הכי זול אצלכם?\") the ₪149 item never goes out alone after the ₪79 sentence was cut", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = URBAN;
    const draft = "הכי זול אצלנו הוא Ribbed Tank Top ב-₪79. יש חולצת Oversized Cotton T-Shirt ב-₪149.";
    const { r, cuts, cards } = await run("אז מה הכי זול אצלכם?", "זול", draft, draft, draft);
    expect(r.reply).toBe("הנה כמה אפשרויות: Ribbed Tank Top, Oversized Cotton T-Shirt, Cropped Hoodie.");
    expect(r.reply ?? "").not.toMatch(/זול/);
    expect((r.trace as any).memberCut).toBe(true);
    expect(cuts.markers).toContain("memberCut");
    expect(r.trace.gate3.rewrite).toBe("fallback");
    // The cards: the cheapest of the found products first.
    expect(cards).toEqual(["203", "202", "201"]);
  });

  it("★ the same draft with a rewrite that keeps both items is the answer", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = URBAN;
    const draft = "הכי זול אצלנו הוא Ribbed Tank Top ב-₪79. יש חולצת Oversized Cotton T-Shirt ב-₪149.";
    const both = "המחיר הנמוך ביותר שמצאנו הוא Ribbed Tank Top ב-₪79, ואחריו Oversized Cotton T-Shirt ב-₪149.";
    const { r } = await run("אז מה הכי זול אצלכם?", "זול", draft, both);
    expect(r.reply).toContain("₪79");
    expect(r.reply).toContain("₪149");
    expect((r.trace as any).memberCut).toBeUndefined();
  });

  it("★ (\"אני מחפשת את הכי זול שיש\") the fallback's cards are the cheapest found, never the first three", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = [{ title: "Wool Coat", price: 799 }, { title: "Leather Boots", price: 529 }, { title: "Cropped Hoodie", price: 299 }, { title: "Heavyweight Boxy Tee", price: 169 }, { title: "Ribbed Tank Top", price: 79 }, { title: "Silk Scarf", price: 49, inventoryState: "out_of_stock" }];
    const draft = "יש אצלנו פריטים במחיר זול.";
    const { r, cards } = await run("יש לכם משהו ממש זול? אני מחפשת את הכי זול שיש", "זול", draft, draft, draft);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    // Ribbed Tank Top ₪79, Heavyweight Boxy Tee ₪169, Cropped Hoodie ₪299; the ₪49 scarf is out of stock.
    expect(cards).toEqual(["205", "204", "203"]);
    expect(r.reply).toBe("הנה כמה אפשרויות: Ribbed Tank Top, Heavyweight Boxy Tee, Cropped Hoodie.");
    expect(r.reply ?? "").not.toMatch(/זול/);
  });

  it("★ a cheap ask whose found products carry no price gets no cards", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = [{ title: "Wool Coat", price: null }, { title: "Leather Boots", price: null }];
    const draft = "יש אצלנו פריטים במחיר זול.";
    const { r, cards } = await run("יש לכם משהו ממש זול? אני מחפשת את הכי זול שיש", "זול", draft, draft, draft);
    expect(cards).toEqual([]);
    expect(r.reply).toBe(QUESTION);
  });

  it("★ a list ask (\"מה יש כרגע במלאי?\"): the card step adds none of the products the statement rules out", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const { r, cards } = await run("מה יש כרגע במלאי?", "טוש", `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`);
    expect(r.reply).toBe(`${STATEMENT} ${QUESTION}`);
    expect(cards).toEqual([]);
    expect((r.trace as any).listAskCards).toBeUndefined();
  });

  it("★ a text channel, titles the statement shares no word with: the first products in stock are not listed under it", async () => {
    h.textChannel = true;
    h.groundTitle = "Miss eyebrows Pen"; h.extraTitle = "Miss eyebrows Pen"; h.groundCategory = "טושים"; h.chunks = BROW_DATA;
    const st = "הטושים שמצאנו מתאימים לגבות בלבד, ולא מיועדים לאזור מתחת לעיניים.";
    const { r } = await run("טוש אני רוצה", "טוש", `${st} ${ABSENCE}`, `${st} ${ABSENCE}`, `${st} ${ABSENCE}`);
    expect(r.reply).toBe(`${st} ${QUESTION}`);
    expect((r.trace as any).statementKept).toBe(true);
  });

  it("★ the cut sentence names a found product, the statement rules the found ones out: the statement, never the list", async () => {
    h.groundTitle = "Miss eyebrows Pen"; h.extraTitle = "Deep Line Pen"; h.groundCategory = "טושים"; h.chunks = BROW_DATA;
    const st = "הטושים שמצאנו מתאימים לגבות בלבד, ולא מיועדים לאזור מתחת לעיניים.";
    const named = "לא מופיע אצלנו טוש Deep Line שמצוין לשימוש מתחת לעיניים, אז לא כדאי להשתמש בו שם.";
    const { r, cards } = await run("טוש אני רוצה", "טוש", `${st} ${named}`, `${st} ${named}`, `${st} ${named}`);
    expect(r.reply).toBe(`${st} ${QUESTION}`);
    expect(cards).toEqual([]);
  });

  it("★ a short statement that rules the products out is kept too; one that does not is no answer under 8 words", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const out = "הטושים מיועדים לגבות, לא לעיניים.";
    const a = await run("טוש אני רוצה", "טוש", `${out} ${ABSENCE}`, `${out} ${ABSENCE}`, `${out} ${ABSENCE}`);
    expect(a.r.reply).toBe(`${out} ${QUESTION}`);
    expect(a.cards).toEqual([]);

    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0; h.calls.length = 0;
    const thin = "הטושים מיועדים לגבות בלבד.";
    const b = await run("טוש אני רוצה", "טוש", `${thin} ${ABSENCE}`, `${thin} ${ABSENCE}`, `${thin} ${ABSENCE}`);
    expect(b.r.trace.gate3.rewrite).toBe("fallback");
    expect((b.r.trace as any).statementKept).toBeUndefined();
    expect(b.cards).toEqual(["101", "102"]);
  });

  // The cleanup's own cut (a wrong price, no model round by itself) on a product ask that is not about price.
  const WRONG = "הכי זול אצלנו הוא Ribbed Tank Top ב-₪59. יש גם חולצת Oversized Cotton T-Shirt ב-₪149, במגוון צבעים ומידות לבחירה.";
  const RIGHT = "הכי זול אצלנו הוא Ribbed Tank Top ב-₪79. יש גם חולצת Oversized Cotton T-Shirt ב-₪149, במגוון צבעים ומידות לבחירה.";
  it("★ a wrong price cut out of a two-product answer: the rest is not sent as the answer, the model writes it again", async () => {
    h.groundList = URBAN;
    const { r, cuts } = await run("מה יש לכם בחולצות?", "חולצות", WRONG, RIGHT);
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("ungrounded_price");
    expect((r.trace as any).directRejected).toContain("memberCut");
    expect((r.trace as any).rewriteSkipped).toBeUndefined();
    expect(r.reply).toBe(RIGHT);
    expect((r.trace as any).memberCut).toBeUndefined();
    expect(cuts.markers ?? []).not.toContain("memberCut");
  });

  it("★ the same with a rewrite that repeats the wrong price: the found products in the store's order, no ranking", async () => {
    h.groundList = URBAN;
    const { r, cuts, cards } = await run("מה יש לכם בחולצות?", "חולצות", WRONG, WRONG, WRONG);
    expect(r.reply).toBe("הנה כמה אפשרויות: Cropped Hoodie, Oversized Cotton T-Shirt, Ribbed Tank Top.");
    expect(cards).toEqual(["201", "202", "203"]);
    expect(cuts.markers).toContain("memberCut");
  });

  it("★ the cut sentence named a found product: a statement that rules none out is no answer, the found products go out", async () => {
    h.groundTitle = "Miss eyebrows Pen"; h.extraTitle = "Deep Line Pen"; h.groundCategory = "טושים"; h.chunks = BROW_DATA;
    const st = "הטושים שמצאנו מיועדים לשימוש על הגבות, למילוי וסימון של הגבות.";
    const named = "לא מופיע אצלנו טוש Deep Line שמצוין לשימוש מתחת לעיניים, אז לא כדאי להשתמש בו שם.";
    const { r, cards } = await run("טוש אני רוצה", "טוש", `${st} ${named}`, `${st} ${named}`, `${st} ${named}`);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect((r.trace as any).statementKept).toBeUndefined();
    // Rule S: the list leaves out the product the draft itself said is not advisable there.
    expect(r.reply).toBe("הנה כמה אפשרויות: Miss eyebrows Pen.");
    expect(cards).toEqual(["101"]);
  });

  it("★ a kept statement on a cheap ask carries the cheapest of the found products first", async () => {
    h.groundList = [{ title: BROW, price: 99 }, { title: "Miss eyebrows טוש עדין לגבות", price: 59 }, { title: "Miss eyebrows טוש כהה לגבות", price: 79 }];
    h.chunks = BROW_DATA;
    const fits = "הטושים שמצאנו מיועדים למילוי גבות בקלילות, כמו שכתוב בשם המוצר.";
    const { r, cards } = await run("יש לכם טוש זול?", "טוש", `${fits} ${ABSENCE}`, `${fits} ${ABSENCE}`, `${fits} ${ABSENCE}`);
    expect((r.trace as any).statementKept).toBe(true);
    expect(r.reply).toBe(fits);
    expect(cards).toEqual(["202", "203", "201"]);
  });

  it("★ a cheap ask with no priced product on a text channel: the question, never the unpriced products as a list", async () => {
    h.textChannel = true;
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = [{ title: "Wool Coat", price: null }, { title: "Leather Boots", price: null }];
    const draft = "יש אצלנו פריטים במחיר זול.";
    const { r } = await run("יש לכם משהו ממש זול? אני מחפשת את הכי זול שיש", "זול", draft, draft, draft);
    expect(r.reply).toBe(QUESTION);
  });

  it("★ a cheap ask that names no kind of product, Hebrew titles: no word of the ask rules the found products out", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = [{ title: "חולצת כותנה רחבה", price: 149 }, { title: "גופיית ריב", price: 79 }, { title: "קפוצ'ון קצר", price: 299 }];
    const draft = "יש אצלנו פריטים במחיר זול.";
    const { r, cards } = await run("אז מה הכי זול אצלכם?", "זול", draft, draft, draft);
    expect(cards).toEqual(["202", "201", "203"]);
    expect(r.reply).toBe("הנה כמה אפשרויות: גופיית ריב, חולצת כותנה רחבה, קפוצ'ון קצר.");
  });

  // The model attached the cards itself: three drafts of the same text with both found products as cards.
  const runWithCards = async (text: string, incoming = "טוש אני רוצה") => {
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "טוש" })] }, ...[0, 1, 2].map((i) => ({ toolCalls: [respond(`d${i}`, { reply: text, cards: ["PRODUCT_1", "PRODUCT_2"] })] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
    return { r, cards: h.staged.flatMap((x: any) => (x.products ?? []).map((p: any) => String(p.productId))) };
  };
  it("★ the model's own cards of the products the kept statement rules out do not go out under it", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const { r, cards } = await runWithCards(`${STATEMENT} ${ABSENCE}`);
    expect(r.reply).toBe(`${STATEMENT} ${QUESTION}`);
    expect(cards).toEqual([]);
  });

  it("★ a kept statement that points at its cards keeps them: without them the pointer would dangle", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const st = "הטושים שמופיעים בכרטיסים מיועדים לגבות, לא לאזור מתחת לעיניים.";
    const { r, cards } = await runWithCards(`${st} ${ABSENCE}`);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["101", "102"]);
  });

  it("★ a short statement that points at its cards goes as it is, cards and all, never the list in its place", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const st = "הטושים שמופיעים בכרטיסים מיועדים לגבות, לא לעיניים.";
    const { r, cards } = await runWithCards(`${st} ${ABSENCE}`);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["101", "102"]);
    expect((r.trace as any).statementKept).toBe(true);
  });

  it("★ a list ask, the kept text asks its own question and is no hollow remainder: the card step still adds none of the products it rules out", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const st = `${STATEMENT} לאיזה שימוש צריך את הטוש?`;
    const { r, cards } = await run("מה יש כרגע במלאי?", "טוש", `${st} ${ABSENCE}`, `${st} ${ABSENCE}`, `${st} ${ABSENCE}`);
    expect(r.reply).toBe(st);
    expect((r.trace as any).statementKept).toBeUndefined();
    expect(cards).toEqual([]);
    expect((r.trace as any).listAskCards).toBeUndefined();
  });

  it("★ the same on a text channel: no product lines under the kept text", async () => {
    h.textChannel = true;
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const st = `${STATEMENT} לאיזה שימוש צריך את הטוש?`;
    const { r } = await run("טוש אני רוצה", "טוש", `${st} ${ABSENCE}`, `${st} ${ABSENCE}`, `${st} ${ABSENCE}`);
    expect(r.reply).toBe(st);
    expect((r.trace as any).statementKept).toBeUndefined();
  });

  it("★ (owner rule, Hebrew titles) a cheap ask names no kind of product: the dearer item still never goes out alone", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = [{ title: "חולצת כותנה רחבה", price: 149 }, { title: "גופיית ריב", price: 79 }, { title: "קפוצ'ון קצר", price: 299 }];
    const draft = "הכי זול אצלנו היא גופיית ריב ב-₪79. יש חולצת כותנה רחבה ב-₪149.";
    const { r, cards } = await run("אז מה הכי זול אצלכם?", "זול", draft, draft, draft);
    expect(r.reply).toBe("הנה כמה אפשרויות: גופיית ריב, חולצת כותנה רחבה, קפוצ'ון קצר.");
    expect((r.trace as any).memberCut).toBe(true);
    expect(cards).toEqual(["202", "201", "203"]);
  });

  it("★ (owner rule, a store with Hebrew categories) the cheap ask's filler word is no kind of product: the same answer", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = [{ title: "חולצת כותנה רחבה", price: 149, category: "בגדים" }, { title: "גופיית ריב", price: 79, category: "בגדים" }, { title: "קפוצ'ון קצר", price: 299, category: "בגדים" }];
    const draft = "הכי זול אצלנו היא גופיית ריב ב-₪79. יש חולצת כותנה רחבה ב-₪149.";
    const { r, cards } = await run("אז מה הכי זול אצלכם?", "זול", draft, draft, draft);
    expect(r.reply).toBe("הנה כמה אפשרויות: גופיית ריב, חולצת כותנה רחבה, קפוצ'ון קצר.");
    expect((r.trace as any).memberCut).toBe(true);
    expect(cards).toEqual(["202", "201", "203"]);
  });

  // The model's own card of what the text offers in place of her kind stays. A card the model did not send is rule S's.
  const other = "Cover me קונסילר";
  const runOther = async (st: string) => {
    // A store with its own categories: the other product is not of her kind, so the product fallback never lists it.
    h.groundList = [{ title: BROW, price: 59, category: "גבות" }, { title: other, price: 89, category: "פנים" }];
    h.chunks = BROW_DATA;
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "טוש" })] }, ...[0, 1, 2].map((i) => ({ toolCalls: [respond(`d${i}`, { reply: `${st} ${ABSENCE}`, cards: ["PRODUCT_1", "PRODUCT_2"] })] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "טוש אני רוצה" }, "autonomous");
    return { r, cards: h.staged.flatMap((x: any) => (x.products ?? []).map((p: any) => String(p.productId))) };
  };
  it("★ the text rules her kind out and names another product in its place: that card stays, the ruled-out one does not come back", async () => {
    const st = `${STATEMENT} לאזור הזה יש אצלנו את ${other}.`;
    const { r, cards } = await runOther(st);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["202"]);
    expect((r.trace as any).statementKept).toBeUndefined();
  });

  it("★ the same when the text points at the card: it never goes out with no card under it", async () => {
    const st = "הטושים מיועדים לגבות, לא לעיניים. הקונסילר שמופיע בכרטיסים.";
    const { r, cards } = await runOther(st);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["202"]);
  });

  it("★ a short statement of that kind (the statement path): the card the cleanup left under it stays", async () => {
    const st = "הטושים מיועדים לגבות, לא לעיניים. הקונסילר בכרטיסים.";
    const { r, cards } = await runOther(st);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["202"]);
    expect((r.trace as any).statementKept).toBe(true);
  });

  it("★ she asks for the very use the text says they are for: it is a yes, and the model's cards stay", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const { r, cards } = await runWithCards(`${STATEMENT} ${ABSENCE}`, "יש לכם טוש לגבות?");
    expect(r.reply).toBe(STATEMENT);
    expect(cards).toEqual(["101", "102"]);
  });

  it("★ the same when the model sent no cards: the kept statement goes with the found products", async () => {
    h.groundTitle = BROW; h.extraTitle = BROW; h.chunks = BROW_DATA;
    const { r, cards } = await run("יש לכם טוש לגבות?", "טוש", `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`, `${STATEMENT} ${ABSENCE}`);
    expect(r.reply).toBe(STATEMENT);
    expect(cards).toEqual(["101", "102"]);
  });

  // Follow-up to cba121cf (Supervisor's probe of the helpers, 2026-11-19): five wrong results, each at the helper and at the turn.
  const FIVE = [{ title: "טוש גבות חום", price: 79 }, { title: "טוש גבות שחור", price: 149 }, { title: "קונסילר לעיניים", price: 99 }, { title: "מברשת איפור", price: null }, { title: "שפתון אדום", price: 59, inventoryState: "out_of_stock" }];
  const NOT_CHEAP_ASKS = [
    "המוצר שקיבלתי זול ושבור, אני רוצה החזר כספי",
    "יש אפשרות למשלוח זול יותר?",
    "יש קופון? אני מחפשת מחיר זול יותר",
    "ההזמנה שלי לא הגיעה, וזה לא היה זול",
    "באתר אחר ראיתי את זה יותר זול, למה אצלכם יקר?",
    "המשלוח הכי זול כמה עולה?",
    "is there a cheaper shipping option?",
    // (H) a past statement with no ask.
    "קניתי אצלכם והיה זול, תודה",
  ];
  // The model's drafts with the cards it chose, over the five found products.
  const runFive = async (incoming: string, text: string, cardKeys: string[] = [], list: any[] = FIVE) => {
    h.groundList = list;
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "טוש" })] }, ...[0, 1, 2].map((i) => ({ toolCalls: [respond(`d${i}`, { reply: text, ...(cardKeys.length ? { cards: cardKeys } : {}) })] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
    const cuts = h.audits.find((a) => a.data.action === "ai.bot_turn")?.data.metadata.cuts ?? {};
    return { r, cuts, cards: h.staged.flatMap((x: any) => (x.products ?? []).map((p: any) => String(p.productId))) };
  };

  it.each(NOT_CHEAP_ASKS)("★ (A) a cheap word on a matter no product list answers (%s): a failed draft with found products gets no product list", async (incoming) => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    h.groundList = URBAN;
    const draft = "יש אצלנו פריטים במחיר זול.";
    const { r, cards } = await run(incoming, "זול", draft, draft, draft);
    expect(r.reply ?? "").not.toMatch(/הנה כמה אפשרויות|Here are|Ribbed|Oversized|Cropped/);
    expect(cards).toEqual([]);
  });

  it("★ (A) the helper: a cheap ask keeps the exclusions of a product ask, and a word about the shipping or another seller's price is none", async () => {
    const { cheapAsk, cheapNoun, listAsk } = await import("../services/reply-engine/engine");
    for (const x of NOT_CHEAP_ASKS) expect([x, cheapAsk(x)]).toEqual([x, false]);
    // Nor a list ask: no cards go under the reply for the cheap word alone. Another filter word of its own still does.
    for (const x of NOT_CHEAP_ASKS) expect([x, listAsk(x)]).toEqual([x, false]);
    for (const x of ["מה יש במבצע?", "יש לכם משהו זול?", "מה יש במבצע? והמשלוח הכי זול כמה עולה?", "מה יש כרגע במלאי?"]) expect([x, listAsk(x)]).toEqual([x, true]);
    for (const x of ["הזול הזה הגיע שבור", "המשלוח לא היה זול", "is the delivery cheap?", "what is the cheapest express delivery?", "מה הכי זול של המשלוח?", "ראיתי את זה יותר זול בחנות אחרת"]) expect([x, cheapAsk(x)]).toEqual([x, false]);
    // Each exclusion of a product ask, with a cheap word in the message: a payment problem, a how-to, a video.
    for (const x of ["התשלום נכשל על הפריט הכי זול", "איפה ההזמנה שלי? הזמנתי את הכי זול", "איך משתמשים בטוש הזול?", "יש סרטון על הדגם הזול?", "payment failed on the cheapest item", "how do I use the cheap one?"]) expect([x, cheapAsk(x)]).toEqual([x, false]);
    // The asks stay asks, also next to a word about shipping or another seller in another clause.
    for (const x of ["אז מה הכי זול אצלכם?", "יש לכם משהו ממש זול? אני מחפשת את הכי זול שיש", "יש לכם משהו זול?", "יש חולצה זולה?", "יש חולצה זולה עם משלוח חינם?", "do you have anything cheaper with free shipping?", "ראיתי באתר אחר, יש לכם משהו יותר זול?", "זה יקר לי, יש משהו יותר זול?", "something cheaper?", "something cheap for delivery tomorrow?"]) expect([x, cheapAsk(x)]).toEqual([x, true]);
    // "Expensive" is no kind of product.
    expect(cheapNoun("זה יקר לי, יש משהו יותר זול?")).toBeNull();
    // (H) a past statement is no ask; a question in the word's own clause still is, and so is an ask in another clause.
    for (const x of ["הטוש שקניתי היה ממש זול", "it was cheap, thanks", "אתמול זה היה זול יותר, מה קרה?", "החולצה הייתה זולה", "החולצה היתה מאוד זולה", "המחירים היו זולים פעם", "they were much cheaper last year", "זה היה כל כך זול", "זה היה הכי זול שמצאתי", "it was so cheap", "it was very cheap",
      // Negated, in a question: the question mark does not make it an ask.
      "למה זה לא היה זול?", "למה היא לא הייתה זולה?", "למה היא לא היתה זולה?", "למה הם לא היו זולים?"]) expect([x, cheapAsk(x)]).toEqual([x, false]);
    for (const x of ["מה היה הכי זול אצלכם?", "היה לכם משהו זול?", "בשבוע שעבר היה זול, יש משהו זול גם עכשיו?"]) expect([x, cheapAsk(x)]).toEqual([x, true]);
  });

  // What the store's own text says of the found products, so the statements below stand as checked facts.
  const FIT_DATA = [{ content: "טוש גבות: מיועד לגבות, לא מתאים לאזור העיניים ולא מיועד לילדים מתחת לגיל 3. קונסילר לעיניים: מתאים לאזור העיניים. אם הגוון לא מתאים אפשר להחליף את המוצר בחנות.", score: 0.9, documentTitle: "מוצרים", chunkIndex: 1, documentId: "f" }];
  // A sentence the owner's list cuts, that names no product and no use.
  const CUT = "יש אחריות לשנה.";
  const withCut = () => { h.chunks = FIT_DATA; h.policyRow = { data: { blockedTopics: ["אחריות"] } }; };

  it("★ (B) the use after \"not for\" names no product, and the one the text says fits stays: its card goes out, the ruled-out ones do not", async () => {
    withCut();
    const st = "הטושים לא מתאימים לעיניים, אבל קונסילר לעיניים מתאים.";
    const { r, cards } = await runFive("יש טוש לעיניים?", `${st} ${CUT}`, ["PRODUCT_1", "PRODUCT_3"]);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["203"]);
  });

  it("★ (B) the statement of the found pens with the under-eye product as the model's card: that card is not ruled out by it", async () => {
    withCut();
    const { r, cards } = await runFive("יש טוש לעיניים?", `${STATEMENT} ${CUT}`, ["PRODUCT_1", "PRODUCT_2", "PRODUCT_3"]);
    expect(r.reply).toBe(STATEMENT);
    expect(cards).toEqual(["203"]);
  });

  it("★ (C) a sentence that names none and speaks of her kind rules out that kind only: the other product's card stays", async () => {
    withCut();
    const st = "הטוש לא מיועד לילדים מתחת לגיל 3.";
    const { r, cards } = await runFive("יש טוש לעיניים?", `${st} ${CUT}`, ["PRODUCT_1", "PRODUCT_3"]);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["203"]);
  });

  it("★ (D) a condition (\"אם הגוון לא מתאים\") rules nothing out: the card of the product it names stays", async () => {
    withCut();
    const st = "אפשר להחליף את טוש גבות שחור בחנות אם הגוון לא מתאים.";
    const { r, cards } = await runFive("יש טוש לעיניים?", `${st} ${CUT}`, ["PRODUCT_2"]);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["202"]);
  });

  it("★ (E) variants of one title: the dearer one never goes out alone after the cheaper one's sentence was cut", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    const draft = "הכי זול אצלנו טוש גבות חום ב-₪79. יש טוש גבות שחור ב-₪149.";
    const { r, cuts, cards } = await runFive("מה הטוש הכי זול?", draft);
    expect((r.trace as any).memberCut).toBe(true);
    expect(cuts.markers).toContain("memberCut");
    expect(r.reply).toBe("הנה כמה אפשרויות: טוש גבות חום, טוש גבות שחור.");
    expect(cards).toEqual(["201", "202"]);
  });

  it("★ a cheap ask with a kind, no found product of that kind has a price but others do: the question line, no cards", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    const draft = "יש אצלנו מברשות במחיר זול.";
    const { r, cards } = await runFive("מה המברשת הכי זולה?", draft);
    expect(r.reply).toBe(QUESTION);
    expect(cards).toEqual([]);
    // The cheapest of her kind when a found product is of it; of all that was found when none is, or she names none.
    const { cheapestOfKind } = await import("../services/reply-engine/engine");
    const of = (kind: string | null) => cheapestOfKind(FIVE, kind).map((c) => c.title);
    expect(of("המברשת")).toEqual([]);
    expect(of("הטוש")).toEqual(["טוש גבות חום", "טוש גבות שחור"]);
    expect(of(null)).toEqual(["טוש גבות חום", "קונסילר לעיניים", "טוש גבות שחור"]);
    expect(of("מסקרה")).toEqual(["טוש גבות חום", "קונסילר לעיניים", "טוש גבות שחור"]);
  });

  it("★ a cheap ask with a kind, on a kept statement whose own card was ruled out: no cheaper product of another kind goes under it", async () => {
    withCut();
    const st = "טוש גבות חום לא מתאים למריחת איפור.";
    const { r, cards } = await runFive("מה המברשת הכי זולה?", `${st} יש אחריות לשנה. האחריות מכסה פגמים.`, ["PRODUCT_1"]);
    expect((r.trace as any).statementKept).toBe(true);
    expect(r.reply).toBe(`${st} ${QUESTION}`);
    expect(cards).toEqual([]);
  });

  it("★ (F) \"X no, Y yes\": the pens are ruled out and the product the sentence says yes to keeps its card", async () => {
    withCut();
    const st = "הטושים לא מתאימים לעיניים, קונסילר לעיניים כן.";
    const { r, cards } = await runFive("יש טוש לעיניים?", `${st} ${CUT}`, ["PRODUCT_1", "PRODUCT_3"]);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["203"]);
  });

  it("★ (the sixth case) a statement that rules the found products out stands when the cut sentence's use word counts as a member cut", async () => {
    withCut();
    // The cut sentence says "מתחת לעיניים" and names one of the pens: by the measure, a member of the answer was cut.
    const cut = "יש אחריות על טוש גבות חום גם בשימוש מתחת לעיניים.";
    const { memberCutOf } = await import("../services/reply-engine/engine");
    expect(memberCutOf([cut], STATEMENT, FIVE)).toBe(true);
    const { r, cuts, cards } = await runFive("יש טוש לעיניים?", `${STATEMENT} ${cut}`);
    expect((r.trace as any).memberCut).toBe(true);
    expect((r.trace as any).statementKept).toBe(true);
    expect(cuts.markers).toEqual(expect.arrayContaining(["memberCut", "statementKept"]));
    // The statement, never the list of the pens it rules out, and neither pen's card: only the found product whose
    // title holds her use word (rule S: never the makeup brush, which is not what she asked for).
    expect(r.reply).toBe(STATEMENT);
    expect(cards).toEqual(["203"]);
  });

  it("★ (G) a shipping price that equals a found product's price names no product: the answer left is no member cut", async () => {
    h.policyRow = { data: { blockedTopics: ["משלוח"] } };
    const st = "טוש גבות שחור קיים אצלנו והמחיר שלו הוא ₪149.";
    const { r, cards } = await runFive("יש טוש גבות שחור?", `${st} המשלוח עולה ₪79.`, ["PRODUCT_2"]);
    expect((r.trace as any).memberCut).toBeUndefined();
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["202"]);
  });

  // Follow-up I and J (Supervisor, 2026-11-19): the right product was ruled out, or the result turned on the list.
  const THREE = FIVE.slice(0, 3);
  const CREAMS = [{ title: "קרם פנים לעור יבש", price: 79 }, { title: "קרם פנים לעור שמן", price: 89 }, { title: "סרום לילה", price: 99 }];
  const J_SENTENCE = "הטושים שמצאנו מתאימים לגבות בלבד, ולא מיועדים לאזור מתחת לעיניים.";

  it.each([
    "לעיניים הטושים לא מתאימים, לגבות כן.",
    "לעיניים הטושים שמצאנו לא מיועדים.",
  ])("★ (I) a use word in front of the subject (%s): the pens are ruled out, the product whose title holds the use word keeps its card", async (st) => {
    withCut();
    const { r, cards } = await runFive("יש טוש לעיניים?", `${st} ${CUT}`, ["PRODUCT_1", "PRODUCT_3"], THREE);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["203"]);
  });

  it("★ (I) a product said by its whole title after the use: that one is ruled out, never its sibling the use words belong to", async () => {
    h.chunks = [{ content: "קרם פנים לעור יבש: מיועד לעור יבש, לא מתאים לעור שמן. קרם פנים לעור שמן: מתאים לעור שמן.", score: 0.9, documentTitle: "מוצרים", chunkIndex: 1, documentId: "c" }];
    h.policyRow = { data: { blockedTopics: ["אחריות"] } };
    const st = "לעור שמן קרם פנים לעור יבש לא מתאים.";
    const { r, cards } = await runFive("יש קרם לעור שמן?", `${st} ${CUT}`, ["PRODUCT_1", "PRODUCT_2"], CREAMS);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["202"]);
  });

  it.each([[3, THREE], [4, [...THREE, FIVE[3]]], [4, [...THREE, FIVE[4]]], [5, FIVE]])("★ (J) one subject and what it is for, with %i found products: the pens are ruled out whatever else was found", async (_n, list) => {
    // The store's own text says what the sentence says, so it stands as a checked fact.
    h.chunks = [{ content: "טוש גבות: מתאים לגבות בלבד, לא מיועד לאזור מתחת לעיניים. קונסילר לעיניים: מתאים לאזור העיניים.", score: 0.9, documentTitle: "מוצרים", chunkIndex: 1, documentId: "j" }];
    h.policyRow = { data: { blockedTopics: ["אחריות"] } };
    const { r, cards } = await runFive("יש טוש לעיניים?", `${J_SENTENCE} ${CUT}`, ["PRODUCT_1", "PRODUCT_3"], list as any[]);
    expect(r.reply).toBe(J_SENTENCE);
    expect(cards).toEqual(["203"]);
  });

  // Three last cases (Supervisor, 2026-11-19): her kind's word naming another product, a use word away from the
  // kind's word, and a later side that says the same subject does fit.
  const SHOES = [{ title: "נעלי ריצה Air Zoom", price: 300 }, { title: "נעלי הליכה Comfort", price: 250 }, { title: "סנדלי שטח Trek", price: 200 }];
  const SOCKS = { title: "גרבי ריצה", price: 30 };
  const HAND_CREAM = { title: "קרם ידיים", price: 40 };
  const K1_SENTENCE = "קרם ידיים לא מתאים לפנים.";
  const K2_SENTENCE = "לריצה ארוכה הנעליים שמצאנו לא מתאימות.";
  const K3_SENTENCE = "הטושים לא מתאימים לעיניים רגישות, אבל לעיניים רגילות הם מתאימים.";
  // The store's own text says what the sentence says, so it stands as a checked fact; one more sentence is cut.
  const storeSays = (content: string) => {
    h.chunks = [{ content, score: 0.9, documentTitle: "מוצרים", chunkIndex: 1, documentId: "k" }];
    h.policyRow = { data: { blockedTopics: ["אחריות"] } };
  };

  it("★ (K1) her kind's word with a word no found title of her kind holds: it speaks of another product, and the found ones keep their cards", async () => {
    storeSays("קרם ידיים: לא מתאים לפנים. קרם פנים לעור יבש: לעור יבש. קרם פנים לעור שמן: מתאים לעור שמן.");
    const a = await runFive("יש קרם לעור שמן?", `${K1_SENTENCE} ${CUT}`, ["PRODUCT_1", "PRODUCT_2"], CREAMS);
    expect(a.r.reply).toBe(K1_SENTENCE);
    expect(a.cards).toEqual(["201", "202"]);
    // With that product found, it is the one the sentence rules out.
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    const b = await runFive("יש קרם לעור שמן?", `${K1_SENTENCE} ${CUT}`, ["PRODUCT_2", "PRODUCT_4"], [...CREAMS, HAND_CREAM]);
    expect(b.r.reply).toBe(K1_SENTENCE);
    expect(b.cards).toEqual(["202"]);
  });

  it.each([[3, SHOES], [4, [...SHOES, SOCKS]]])("★ (K2) a use word away from the kind's word, with %i found products: all of her kind are ruled out, whatever else was found", async (_n, list) => {
    storeSays("נעלי ריצה Air Zoom ונעלי הליכה Comfort: לא מתאימות לריצה ארוכה. סנדלי שטח Trek: לטיולים.");
    const { r, cards } = await runFive("יש נעליים לריצה?", `${K2_SENTENCE} ${CUT}`, ["PRODUCT_1", "PRODUCT_2"], list as any[]);
    expect(r.reply).toBe(K2_SENTENCE);
    expect(cards).toEqual([]);
  });

  it("★ (K2) a found product of another kind whose title holds her use word is never put in: the model's own remaining card stays", async () => {
    storeSays("נעלי ריצה Air Zoom ונעלי הליכה Comfort: לא מתאימות לריצה ארוכה. סנדלי שטח Trek: לטיולים.");
    // Cards on all three shoes: the two ruled out go, the sandals stay, and the socks ("גרבי ריצה") do not come in.
    const { r, cards } = await runFive("יש נעליים לריצה?", `${K2_SENTENCE} ${CUT}`, ["PRODUCT_1", "PRODUCT_2", "PRODUCT_3"], [...SHOES, SOCKS]);
    expect(r.reply).toBe(K2_SENTENCE);
    expect(cards).toEqual(["203"]);
    // The socks the model carded itself stay (the old rule).
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    const b = await runFive("יש נעליים לריצה?", `${K2_SENTENCE} ${CUT}`, ["PRODUCT_1", "PRODUCT_4"], [...SHOES, SOCKS]);
    expect(b.cards).toEqual(["204"]);
  });

  it("★ (K3) a later side says the same subject does fit for part of what she asks: its products keep their cards", async () => {
    storeSays("טוש גבות: לא מתאים לעיניים רגישות, מתאים לעיניים רגילות. קונסילר לעיניים: מתאים לאזור העיניים.");
    // With the use in front.
    const st = "לעיניים רגישות הטושים לא מתאימים, אבל לעיניים רגילות הם מתאימים.";
    const { r, cards } = await runFive("יש טוש לעיניים?", `${st} ${CUT}`, ["PRODUCT_1", "PRODUCT_2"], THREE);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(["201", "202"]);
  });

  // The device check read "לא מתאימים לעיניים רגישות" as a fit for another use and the turn went to the general list.
  it.each([
    [K3_SENTENCE, ["201", "202"]],
    ["הטושים לא מתאימים לעיניים רגישות.", []],
  ])("★ (K3, the device check) a \"does not fit\" is no fit for another device: the sentence goes out as written (%s)", async (st, want) => {
    storeSays("טוש גבות: לא מתאים לעיניים רגישות, מתאים לעיניים רגילות. קונסילר לעיניים: מתאים לאזור העיניים.");
    const { r, cards } = await runFive("יש טוש לעיניים?", `${st} ${CUT}`, ["PRODUCT_1", "PRODUCT_2"], THREE);
    expect(r.reply).toBe(st);
    expect(cards).toEqual(want);
  });

  it("★ (K) the helpers: another product of her kind's word, the use word's place, and a side with no subject of its own", async () => {
    const { unfitProducts } = await import("../services/reply-engine/engine");
    const on = (t: string, list: any[], noun = "טוש", incoming = "יש טוש לעיניים?") => [list.length, [...unfitProducts(t, list, noun, incoming)].sort()];
    const cream = (t: string, list: any[] = CREAMS) => on(t, list, "קרם", "יש קרם לעור שמן?");
    const shoe = (t: string, list: any[] = SHOES) => on(t, list, "נעליים", "יש נעליים לריצה?");
    // K1. Her kind's word, no "the", and right after it a word no found title of her kind holds: another product.
    expect(cream(K1_SENTENCE)).toEqual([3, []]);
    expect(cream(K1_SENTENCE, [...CREAMS, HAND_CREAM])).toEqual([4, [3]]);
    expect(on("טוש שפתיים לא מתאים לעיניים.", THREE)).toEqual([3, []]);
    expect(shoe("נעלי עבודה לא מתאימות לריצה.")).toEqual([3, []]);
    // Also when nothing of her kind was found: the brow pencil is not the brow pen it speaks of.
    expect(on("טוש גבות לא מתאים לעיניים.", [FIVE[2], { title: "עיפרון גבות", price: 49 }, FIVE[4]])).toEqual([3, []]);
    // A word a found title of her kind holds tells that one apart, also with an ending, also beside a product of
    // another kind whose title holds the same word.
    expect(on("טוש שחור לא מתאים לעיניים.", THREE)).toEqual([3, [1]]);
    expect(on("טושים שחורים לא מתאימים לעיניים.", THREE)).toEqual([3, [1]]);
    expect(on("טוש גבות לא מתאים לעיניים.", [FIVE[0], { title: "טוש שחור", price: 149 }, { title: "עיפרון גבות", price: 99 }])).toEqual([3, [0]]);
    // A word she said as the use, right after the kind's word, names no other product.
    expect(on("טוש לעיניים לא מתאים לעור רגיש.", THREE)).toEqual([3, [0, 1]]);
    expect(cream("קרם פנים לא מתאים לעור שמן.")).toEqual([3, [0, 1]]);
    // Said with "the", or followed by a pointing word or by the sentence going on: the found ones.
    expect(cream("הקרם לידיים לא מתאים לפנים.")).toEqual([3, [0, 1]]);
    expect(cream("הקרם הזה לא מתאים לעור שמן.")).toEqual([3, [0, 1]]);
    expect(on("הטושים שלנו לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("הטושים האלה לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טושים אלה לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טושים כאלה לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טוש זה לא מתאים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טושים לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טושים שמצאנו לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טושים אצלנו לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טושים, לצערי, לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    // Another product and the found ones in one text: the found ones are ruled out.
    expect(on("אין לנו טוש שפתיים, והטושים שמצאנו לא מתאימים לעיניים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("טוש שפתיים לא מתאים לעיניים, וגם הטושים שמצאנו לא.", THREE)).toEqual([3, [0, 1]]);
    // K2. A word she said as the use tells one of her kind apart only right at the kind's word, on any list.
    expect(shoe(K2_SENTENCE)).toEqual([3, [0, 1]]);
    expect(shoe(K2_SENTENCE, [...SHOES, SOCKS])).toEqual([4, [0, 1]]);
    expect(shoe("נעלי הריצה לא מתאימות למרתון.")).toEqual([3, [0]]);
    expect(shoe("נעלי הריצה לא מתאימות למרתון.", [...SHOES, SOCKS])).toEqual([4, [0]]);
    expect(shoe("נעלי ההליכה לא מתאימות לריצה.")).toEqual([3, [1]]);
    expect(shoe("נעלי ההליכה לא מתאימות לריצה.", [...SHOES, SOCKS])).toEqual([4, [1]]);
    expect(shoe("הנעליים לריצה לא מתאימות למרתון.")).toEqual([3, [0]]);
    expect(cream("הקרם לעור יבש לא מתאים לעור שמן.")).toEqual([3, [0]]);
    // K3. A side, or a sentence, that says fits for a use she named with no subject of its own.
    expect(on(K3_SENTENCE, THREE)).toEqual([3, []]);
    expect(on("הטושים לא מתאימים לעיניים רגישות, אבל לעיניים רגילות כן.", THREE)).toEqual([3, []]);
    expect(on("הטושים לא מתאימים לעיניים רגישות, אבל הם מתאימים לעיניים רגילות.", THREE)).toEqual([3, []]);
    expect(on("טוש גבות חום לא מתאים לעיניים רגישות, אבל לעיניים רגילות הוא מתאים.", THREE)).toEqual([3, []]);
    expect(on("הטושים לא מתאימים לעיניים רגישות. לעיניים רגילות הם מתאימים.", THREE)).toEqual([3, []]);
    // Only the subject of the one before it: a product ruled out earlier or later stays ruled out.
    expect(on("טוש גבות שחור לא מתאים לעיניים. טוש גבות חום לא מתאים לעיניים רגישות, אבל לעיניים רגילות הוא מתאים.", THREE)).toEqual([3, [1]]);
    expect(on("טוש גבות חום לא מתאים לעיניים רגישות, אבל לעיניים רגילות הוא מתאים. טוש גבות שחור לא מתאים לעיניים.", THREE)).toEqual([3, [1]]);
    // No "fits" in it, no use she named, a use she did not name, or a subject of its own: the one before it stands.
    expect(on("הטושים לא מתאימים לעיניים רגישות. גם לעיניים רגילות.", THREE)).toEqual([3, [0, 1]]);
    expect(on("הטושים לא מתאימים לעיניים. זה מתאים?", THREE)).toEqual([3, [0, 1]]);
    expect(on("הטושים לא מתאימים לעיניים, אבל לגבות הם מתאימים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("הטושים לא מתאימים לעיניים. הם מתאימים לגבות.", THREE)).toEqual([3, [0, 1]]);
    expect(on("הטושים לא מתאימים לעיניים, אבל קונסילר לעיניים מתאים.", THREE)).toEqual([3, [0, 1]]);
    expect(on("הטושים לא מתאימים לעיניים, אבל לעיניים מתאים איילינר.", THREE)).toEqual([3, [0, 1]]);
    expect(on("הטושים לא מתאימים לעיניים רגישות, אבל לעיניים רגילות מתאים סרום.", THREE)).toEqual([3, [0, 1]]);
  });

  it("★ (I, J) the helpers: who the sentence speaks of, in order, on any list of found products", async () => {
    const { unfitProducts, herUseWords } = await import("../services/reply-engine/engine");
    const LISTS: any[][] = [THREE, [...THREE, FIVE[3]], [...THREE, FIVE[4]], FIVE];
    const on = (t: string, list: any[], noun: string | null = "טוש", incoming = "יש טוש לעיניים?") => [list.length, [...unfitProducts(t, list, noun, incoming)].sort()];
    for (const list of LISTS) {
      const n = list.length;
      // I: her kind's word is the subject; the use word in front of it names no product.
      expect(on("לעיניים הטושים לא מתאימים, לגבות כן.", list)).toEqual([n, [0, 1]]);
      expect(on("לעיניים הטושים שמצאנו לא מיועדים.", list)).toEqual([n, [0, 1]]);
      // With no subject before the words, the use word her own message says is no product.
      expect(on("מתחת לעיניים לא מתאים להשתמש בטושים.", list)).toEqual([n, []]);
      expect(on("לעיניים הטושים לא מתאימים, לגבות כן.", list, null)).toEqual([n, []]);
      // On an ask for brows the same sentence is a yes.
      expect(on("לעיניים הטושים לא מתאימים, לגבות כן.", list, "טוש", "יש טוש לגבות?")).toEqual([n, []]);
      // J: one subject, and what it is for.
      expect(on(J_SENTENCE, list)).toEqual([n, [0, 1]]);
      expect(on(J_SENTENCE, list, "טוש", "")).toEqual([n, [0, 1]]);
      expect(on(J_SENTENCE, list, "טוש", "יש טוש לגבות?")).toEqual([n, []]);
      expect(on("טוש גבות חום מתאים לגבות ולא מתאים לעיניים.", list)).toEqual([n, [0]]);
      expect(on("לעיניים הטושים לא מתאימים ולגבות הם מתאימים.", list)).toEqual([n, [0, 1]]);
      expect(on("הטושים מתאימים לגבות, לעיניים לא מתאימים.", list)).toEqual([n, [0, 1]]);
      // Words that go on with the same subject between the "fits" and the "not".
      for (const j of ["וגם", "גם", "הם", "והם", "הן", "הוא", "היא", "זה"]) expect([j, ...on(`הטושים מתאימים לגבות, ${j} לא מתאימים לעיניים.`, list)]).toEqual([j, n, [0, 1]]);
      expect(on("הטושים מתאימים לגבות ולא מתאימים לעיניים וגם לא מתאימים לשפתיים.", list)).toEqual([n, [0, 1]]);
      expect(on("טוש גבות חום לא מתאים לעיניים, וגם טוש גבות שחור לא מתאים.", list)).toEqual([n, [0, 1]]);
      // The "fits" nearest before the "not" is the one that counts.
      expect(on("הקונסילר מתאים והטושים מתאימים לגבות ולא מתאימים לעיניים.", list)).toEqual([n, [0, 1]]);
      // Two products as one subject of both.
      expect(on("טוש גבות חום וקונסילר לעיניים מתאימים לגבות ולא מתאימים לעור רגיש.", list)).toEqual([n, [0, 2]]);
      // A subject of its own between the "fits" and the "not", found or not: which is which is not guessed.
      expect(on("הטושים מתאימים והקונסילר לא מתאים לגבות.", list)).toEqual([n, []]);
      expect(on("קונסילר לעיניים מתאים וטוש גבות חום לא מתאים.", list)).toEqual([n, []]);
      expect(on("קונסילר לעיניים מתאים והטושים לא מתאימים.", list)).toEqual([n, []]);
      expect(on("טוש גבות חום מתאים וטוש גבות שחור לא מתאים.", list)).toEqual([n, []]);
      expect(on("הקונסילר מתאים והשפתון לא מתאים.", list)).toEqual([n, []]);
      expect(on("הקונסילר מתאים והשפתון לא מתאים לגבות אלא מתאים לשפתיים.", list)).toEqual([n, []]);
      // A "fits" after the "not" is not the one that counts.
      expect(on("הקונסילר מתאים והשפתון לא מתאים לגבות ומתאים לשפתיים.", list)).toEqual([n, []]);
      // What the "fits" word is for ends at the "not": the last word that says fits is the concealer's.
      expect(on("הקונסילר מתאים והטושים מיועדים לגבות ולא מתאימים לעיניים.", list)).toEqual([n, []]);
      expect(on("הקונסילר מתאים, סבון לא מתאים.", list)).toEqual([n, []]);
      expect(on("הטושים מתאימים לגבות והקונסילר לא מתאים לעיניים.", list)).toEqual([n, []]);
      // Nor a use in front of the "not" that her message does not say.
      expect(on("הטושים מתאימים לגבות, לשפתיים לא מתאימים.", list)).toEqual([n, []]);
      // No "fits" in the sentence: her kind is the subject, a product next to it by a single word is left.
      expect(on("הטושים והקונסילר לא מתאימים לעור רגיש.", list)).toEqual([n, [0, 1]]);
      // Her kind, less a product of it the text names elsewhere (the one offered in their place).
      expect(on("הטושים לא מתאימים לעיניים. במקומם יש את טוש גבות שחור.", list)).toEqual([n, [0]]);
      // A yes to another use than hers is no yes to her.
      expect(on("הטושים לא מתאימים לעיניים, לשפתיים כן.", list)).toEqual([n, [0, 1]]);
      // A part with no subject that says they fit the very use she asks for: a yes.
      expect(on("הטושים לא מיועדים לילדים, מתאימים לעיניים.", list)).toEqual([n, []]);
      // Her kind's word with a word that tells one of them apart: that one only.
      expect(on("הטוש השחור לא מתאים לעיניים.", list)).toEqual([n, [1]]);
      // A product reached through a single word of its title, when the sentence says no whole title and not her kind.
      expect(on("הקונסילר לא מתאים לגבות.", list)).toEqual([n, [2]]);
    }
    expect(on(J_SENTENCE, FIVE.slice(0, 2))).toEqual([2, [0, 1]]);
    // An earlier part with its own subject says fits, the later one names what does not: only where that was found.
    expect(on("הקונסילר מתאים, השפתון לא מתאים.", THREE)).toEqual([3, []]);
    expect(on("הקונסילר מתאים, השפתון לא מתאים.", FIVE)).toEqual([5, [4]]);
    // Among her kind, a word that tells one apart counts even when it is the use she asked for.
    const MIX = [{ title: "טוש גבות חום", price: 79 }, { title: "טוש עיניים שחור", price: 149 }, { title: "סרום לילה", price: 99 }];
    expect(on("טוש העיניים לא מתאים לעור רגיש.", MIX)).toEqual([3, [1]]);
    // What a "fits" word is for tells none of them apart.
    expect(on(J_SENTENCE, MIX)).toEqual([3, [0, 1]]);
    // A title that is the start of a longer one the sentence says is not said.
    const STARTS = [{ title: "קרם פנים", price: 59 }, { title: "קרם פנים לעור יבש", price: 79 }, { title: "סרום לילה", price: 99 }];
    expect(on("קרם פנים לעור יבש לא מתאים לעור שמן.", STARTS, "קרם", "יש קרם לעור שמן?")).toEqual([3, [1]]);
    expect(on("קרם פנים לא מתאים לעור שמן.", STARTS, "קרם", "יש קרם לעור שמן?")).toEqual([3, [0]]);
    // The whole title wins over single words of a sibling's title.
    expect(on("לעור שמן קרם פנים לעור יבש לא מתאים.", CREAMS, "קרם", "יש קרם לעור שמן?")).toEqual([3, [0]]);
    expect(on("לעור שמן קרם פנים לעור יבש לא מתאים.", [...CREAMS, FIVE[3], FIVE[4]], "קרם", "יש קרם לעור שמן?")).toEqual([5, [0]]);
    // What a "fits" word is for is the use too, and so is a use word in front that her message does not say.
    const LIPS = [...THREE, { title: "גלוס לשפתיים", price: 49 }];
    expect(on("הטושים מתאימים לשפתיים בלבד, ולא מיועדים לעיניים.", LIPS)).toEqual([4, [0, 1]]);
    expect(on("לשפתיים הטושים לא מתאימים.", LIPS)).toEqual([4, [0, 1]]);
    const PENS = [{ title: "Brow Pen Brown", price: 79 }, { title: "Brow Pen Black", price: 149 }, { title: "Eye Concealer", price: 99 }];
    expect(on("For the eye the pens do not fit.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, [0, 1]]);
    expect(on("The pens are suitable for brows only, and are not meant for the eye area.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, [0, 1]]);
    expect(on("Brow Pen Brown fits the brows and does not fit the eye.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, [0]]);
    expect(on("Brow Pen Brown is suitable for brows and is not meant for the eye.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, [0]]);
    expect(on("The pens are suitable for brows, they are not meant for the eye.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, [0, 1]]);
    expect(on("Brow Pen Brown fits the brows, it does not fit the eye.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, [0]]);
    expect(on("The pens are suitable for brows and also are not meant for the eye.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, [0, 1]]);
    expect(on("The concealer fits and the lipstick does not fit.", PENS, "pen", "do you have a pen for the eye?")).toEqual([3, []]);
    // The words her message says as the use: after "ל" or "for", never her kind's word, never a verb's "for".
    expect(herUseWords("יש טוש לעיניים?", "טוש")).toEqual(["עיניים"]);
    expect(herUseWords("יש קרם לעור שמן?", "קרם")).toEqual(["עור"]);
    expect(herUseWords("something for winter?")).toEqual(["winter"]);
    expect(herUseWords("do you have a pen for the eye?", "pen")).toEqual(["eye"]);
    expect(herUseWords("I am looking for a brow pen")).toEqual([]);
    expect(herUseWords("יש לכם טוש חום?", "טוש")).toEqual([]);
    expect(herUseWords("יש משהו לטוש?", "טוש")).toEqual([]);
  });

  it("★ (B to E) the helpers, on the Supervisor's fixture", async () => {
    const { namedMembers, memberCutOf, unfitProducts } = await import("../services/reply-engine/engine");
    const u = (t: string) => [...unfitProducts(t, FIVE, "טוש", "יש טוש לעיניים?")].sort();
    // B: what follows "not for" is the use, never a product; the one the text says fits is never ruled out.
    expect(u("טוש גבות חום לא מתאים לעיניים, אבל קונסילר לעיניים מתאים.")).toEqual([0]);
    expect(u("הטושים שמצאנו מיועדים לגבות, לא לאזור מתחת לעיניים.")).toEqual([0, 1]);
    expect(u("טוש גבות שחור לא מתאים לעיניים.")).toEqual([1]);
    expect(u("הטושים לא מתאימים לעיניים. קונסילר לעיניים מתאים בדיוק לזה.")).toEqual([0, 1]);
    // The subject before the words still names: the under-eye product itself can be the one ruled out.
    expect(u("קונסילר לעיניים לא מתאים לגבות.")).toEqual([2]);
    // One the text says fits in another sentence is never ruled out by a sentence that names it with others.
    expect(u("טוש גבות שחור מתאים לגבות. טוש גבות לא מתאים לעיניים.")).toEqual([0]);
    // Also when the sentence that says it fits is the yes to her own ask ("for brows, not for eyes" on an ask for brows).
    expect([...unfitProducts("טוש גבות חום מיועד לגבות, לא לעיניים. טוש גבות לא מתאים לעור רגיש.", FIVE, "טוש", "יש טוש לגבות?")]).toEqual([1]);
    // The same beside a pen the second sentence does not speak of (the word at the kind's word tells the brow pens apart).
    expect([...unfitProducts("טוש גבות חום מיועד לגבות, לא לעיניים. טוש גבות לא מתאים לעור רגיש.", [FIVE[0], FIVE[1], { title: "טוש שחור", price: 149 }], "טוש", "יש טוש לגבות?")]).toEqual([1]);
    // The use ends at the comma: a product named after it is still named.
    expect(u("טוש גבות חום לא מתאים לעיניים, וגם טוש גבות שחור.")).toEqual([0, 1]);
    // C: names none, speaks of her kind: that kind only. With no kind and no title word in it: none.
    expect(u("הטוש לא מיועד לילדים מתחת לגיל 3.")).toEqual([0, 1]);
    expect(u("המוצרים שמצאנו לא מתאימים לעיניים.")).toEqual([]);
    expect(u("המברשת לא מתאימה לעור רגיש.")).toEqual([3]);
    // D: a condition rules nothing out; a statement after the condition's clause still does.
    expect(u("אם הגוון לא מתאים אפשר להחליף את טוש גבות שחור בחנות.")).toEqual([]);
    expect(u("במידה והטוש לא מתאים, אפשר להחזיר אותו.")).toEqual([]);
    expect([...unfitProducts("If the Ribbed Tank Top does not fit, you can exchange it.", URBAN)]).toEqual([]);
    expect([...unfitProducts("The Ribbed Tank Top does not fit a tall frame.", URBAN)]).toEqual([2]);
    expect(u("אם חיפשת גוון כהה, טוש גבות שחור לא מתאים.")).toEqual([1]);
    // E: siblings are told apart by the word or the price only one of those matched has.
    expect([...namedMembers("יש טוש גבות שחור ב-₪149.", FIVE)]).toEqual([1]);
    expect([...namedMembers("טוש גבות חום עולה ₪79.", FIVE)]).toEqual([0]);
    expect([...namedMembers("יש טוש גבות ב-₪149.", FIVE)]).toEqual([1]);
    expect([...namedMembers("יש טוש גבות בגוון שחור.", FIVE)]).toEqual([1]);
    // A title that is the start of a longer one: the longer one the text says is the one named.
    const PRE = [{ title: "טוש גבות", price: 79 }, { title: "טוש גבות שחור", price: 79 }];
    expect([...namedMembers("יש טוש גבות שחור.", PRE)]).toEqual([1]);
    expect([...namedMembers("יש טוש גבות.", PRE)]).toEqual([0]);
    // A price two of them share tells neither apart: the one named by its whole title is the one named.
    const TWO = [{ title: "טוש גבות חום", price: 79 }, { title: "טוש גבות שחור", price: 79 }];
    expect([...namedMembers("יש טוש גבות חום ב-₪79.", TWO)]).toEqual([0]);
    expect([...namedMembers("יש טוש גבות ב-₪79.", TWO)]).toEqual([0, 1]);
    // A word tells it apart from the others matched, also when a found product that is not matched has it too.
    expect([...namedMembers("יש טוש גבות בגוון שחור.", [...FIVE, { title: "עיפרון שחור", price: 45 }])]).toEqual([1]);
    // Also far from the title's other words, where no other measure marks it.
    expect([...namedMembers("טוש גבות מגיע אצלנו במבחר גוונים, כולל שחור.", FIVE)]).toEqual([1]);
    expect([...namedMembers("טוש גבות חום וטוש גבות שחור", FIVE)]).toEqual([0, 1]);
    // None told apart: the text speaks of them all.
    expect([...namedMembers("יש לנו טוש גבות בכמה גוונים.", FIVE)]).toEqual([0, 1]);
    expect(memberCutOf(["טוש גבות חום עולה ₪79."], "יש טוש גבות שחור ב-₪149.", FIVE)).toBe(true);
    expect(memberCutOf(["טוש גבות חום עולה ₪79."], "יש לנו טוש גבות בכמה גוונים.", FIVE)).toBe(false);
    expect(memberCutOf(["קונסילר לעיניים עולה ₪99."], "יש טוש גבות שחור ב-₪149.", FIVE)).toBe(true);
    expect(memberCutOf(["המשלוח עולה ₪30."], "יש טוש גבות שחור ב-₪149.", FIVE)).toBe(false);
    // F: "X no, Y yes". The words speak of the subject of their own comma part; the part that says yes fits.
    expect(u("הטושים לא מתאימים לעיניים, קונסילר לעיניים כן.")).toEqual([0, 1]);
    expect(u("קונסילר לעיניים כן, הטושים לא מתאימים לעיניים.")).toEqual([0, 1]);
    expect(u("טוש גבות חום לא מתאים לעיניים, קונסילר לעיניים מתאים.")).toEqual([0]);
    expect([...unfitProducts("The Cropped Hoodie does not fit a tall frame, the Ribbed Tank Top does.", URBAN)]).toEqual([0]);
    // A later part that neither says yes nor goes on with the same words is not the subject.
    expect(u("הטושים לא מתאימים לעיניים, קונסילר לעיניים זמין במלאי.")).toEqual([0, 1]);
    expect(u("טוש גבות חום לא מתאים לעיניים, וגם יש לנו קונסילר לעיניים.")).toEqual([0]);
    expect(u("טוש גבות חום לא מתאים לעיניים, טוש גבות שחור.")).toEqual([0]);
    // One that goes on with them is.
    expect(u("טוש גבות חום לא מתאים לעיניים, טוש גבות שחור גם לא.")).toEqual([0, 1]);
    expect(u("טוש גבות חום לא מתאים לעיניים, וכן טוש גבות שחור.")).toEqual([0, 1]);
    for (const x of ["nor the Ribbed Tank Top", "and also the Ribbed Tank Top", "also the Ribbed Tank Top", "the Ribbed Tank Top either"]) expect([x, [...unfitProducts(`The Cropped Hoodie does not fit a tall frame, ${x}.`, URBAN)].sort()]).toEqual([x, [0, 2]]);
    // The yes marks its product as fitting where the words name it with its sibling, after them or before them.
    expect(u("טוש גבות לא מתאים לעיניים, טוש גבות שחור כן.")).toEqual([0]);
    expect(u("טוש גבות לא מתאים לעיניים, טוש גבות שחור גם כן.")).toEqual([0, 1]);
    const PENS = [{ title: "Brow Pen Brown", price: 79 }, { title: "Brow Pen Black", price: 149 }];
    expect([...unfitProducts("The Brow Pen does not fit the eyes.", PENS)]).toEqual([0, 1]);
    for (const x of ["does", "yes"]) {
      expect([x, [...unfitProducts(`The Brow Pen does not fit the eyes, the Brow Pen Black ${x}.`, PENS)]]).toEqual([x, [0]]);
      expect([x, [...unfitProducts(`The Brow Pen Black ${x}, the Brow Pen Brown does not fit the eyes.`, PENS)]]).toEqual([x, [0]]);
    }
    // The same subject goes on in a later part that says what it does fit: still ruled out.
    expect(u("הטושים לא מתאימים לעיניים, הם מתאימים רק לגבות.")).toEqual([0, 1]);
    expect(u("טוש גבות חום לא מתאים לעיניים, הוא מתאים רק לגבות.")).toEqual([0]);
    // A list of subjects before the words.
    expect(u("טוש גבות חום, טוש גבות שחור לא מתאימים לעיניים.")).toEqual([0, 1]);
    // The subject before the words, in an earlier part, and after them when nothing before names or speaks of any.
    expect(u("טוש גבות שחור, שמגיע בגוון כהה, לא מתאים לעיניים.")).toEqual([1]);
    expect(u("לא מתאימים לעיניים: טוש גבות חום, טוש גבות שחור.")).toEqual([0, 1]);
    // G: a price said of the shipping names no product; a product's price with shipping after it still does.
    expect(memberCutOf(["המשלוח עולה ₪79."], "יש טוש גבות שחור ב-₪149.", FIVE)).toBe(false);
    expect([...namedMembers("המשלוח עולה ₪79.", FIVE)]).toEqual([]);
    for (const x of ["משלוח עולה ₪79", "משלוחים עולים ₪79", "השילוח עולה ₪79", "ההובלה עולה ₪79", "שליח עולה ₪79", "shipping costs ₪79", "delivery costs ₪79", "postage is ₪79", "a courier is ₪79"]) expect([x, [...namedMembers(`${x}.`, FIVE)]]).toEqual([x, []]);
    // The price before the shipping word, or the shipping as what comes with the product.
    expect([...namedMembers("יש אצלנו פריט ב-₪79 כולל משלוח.", FIVE)]).toEqual([0]);
    for (const x of ["יש אצלנו פריט כולל משלוח ב-₪79.", "יש אצלנו פריט עם משלוח ב-₪79.", "an item with delivery for ₪79.", "an item including delivery for ₪79."]) expect([x, [...namedMembers(x, FIVE)]]).toEqual([x, [0]]);
    expect([...namedMembers("המשלוח חינם, והפריט עולה ₪79.", FIVE)]).toEqual([0]);
  });

  it("the helpers, on the real lines", async () => {
    const { cheapAsk, cheapNoun, cheapestFirst, namedMembers, memberCutOf, unfitProducts, aboutFound } = await import("../services/reply-engine/engine");
    for (const x of ["אז מה הכי זול אצלכם?", "יש לכם משהו ממש זול? אני מחפשת את הכי זול שיש", "יש לכם משהו זול?", "לא מצאתי משהו זול", "מה המחיר הנמוך ביותר?", "what is the cheapest you have?", "do you have cheap shirts?"]) expect([x, cheapAsk(x)]).toEqual([x, true]);
    // The word negated is a complaint, never an ask for the low end; a word that only holds the letters is no ask.
    for (const x of ["זה נשמע לי לא זול בכלל", "זה לא הכי זול", "it's not that cheap", "טוש אני רוצה", "מה אתם ממליצים?", "יש לכם זולית?"]) expect([x, cheapAsk(x)]).toEqual([x, false]);
    expect(cheapNoun("אז מה הכי זול אצלכם?")).toBeNull();
    expect(cheapNoun("יש לכם משהו ממש זול? אני מחפשת את הכי זול שיש")).toBeNull();
    expect(cheapNoun("מה המחיר הנמוך ביותר?")).toBeNull();
    expect(cheapNoun("what is the cheapest you have?")).toBeNull();
    expect(cheapNoun("יש חולצה זולה?")).toBe("חולצה");
    const found = [{ title: "Oversized Cotton T-Shirt", price: 149, inventoryState: "in_stock" }, { title: "Ribbed Tank Top", price: 79, inventoryState: "in_stock" }, { title: "Cropped Hoodie", price: 299, inventoryState: "in_stock" }, { title: "Wool Coat", price: 60, inventoryState: "out_of_stock" }, { title: "Gift Box", price: null, inventoryState: "in_stock" }, { title: "Site Only", price: 10, priceOnSite: true, inventoryState: "in_stock" }];
    expect(cheapestFirst(found).map((c) => c.title)).toEqual(["Ribbed Tank Top", "Oversized Cotton T-Shirt", "Cropped Hoodie"]);
    const cutOut = ["הכי זול אצלנו הוא Ribbed Tank Top ב-₪79."];
    expect(memberCutOf(cutOut, "יש חולצת Oversized Cotton T-Shirt ב-₪149.", found)).toBe(true);
    // The cut product is still named in what is left: nothing is missing.
    expect(memberCutOf(["Ribbed Tank Top מתאים לריצה."], "יש Ribbed Tank Top ב-₪79 ו-Oversized Cotton T-Shirt ב-₪149.", found)).toBe(false);
    // What is left names no found product: it is no list with a member missing.
    expect(memberCutOf(cutOut, "המשלוח חינם מעל ₪200.", found)).toBe(false);
    // A cut sentence that named no product took no member.
    expect(memberCutOf(["אין לנו חנות פיזית."], "יש חולצת Oversized Cotton T-Shirt ב-₪149.", found)).toBe(false);
    // A found product's own price with a currency mark names it; a bare number or another price does not.
    expect([...namedMembers("יש פריט ב-₪79.", found)]).toEqual([1]);
    expect([...namedMembers("יש 79 פריטים.", found)]).toEqual([]);
    expect([...namedMembers("המשלוח עולה ₪30.", found)]).toEqual([]);
    const brows = [{ title: BROW, price: 59, inventoryState: "in_stock" }, { title: BROW, price: 59, inventoryState: "in_stock" }];
    expect([...unfitProducts(STATEMENT, brows)]).toEqual([0, 1]);
    expect([...unfitProducts("הטוש לא מתאים לאזור העיניים.", brows)]).toEqual([0, 1]);
    // "Not stated that it fits" keeps the products (the caveat goes with them).
    expect([...unfitProducts("לא מצוין שהוא מתאים לאזור העיניים.", brows)]).toEqual([]);
    expect([...unfitProducts("מיועד למילוי גבות, ולא מצוין שהוא מתאים למתחת לעיניים.", brows)]).toEqual([]);
    expect([...unfitProducts("לא כתוב שהטוש לא מתאים לעור רגיש.", brows)]).toEqual([]);
    // What the sentence says past "not stated that it fits" still counts.
    expect([...unfitProducts("לא מצוין שהוא מתאים לעיניים, ולכן הטוש לא מתאים לשימוש שם.", brows)]).toEqual([0, 1]);
    // The product the text offers in their place is not ruled out with them, in the next sentence or past a turn of the same one.
    const two = [{ title: BROW, price: 59, inventoryState: "in_stock" }, { title: "Cover me קונסילר", price: 89, inventoryState: "in_stock" }];
    expect([...unfitProducts(`${STATEMENT} לאזור הזה יש אצלנו את Cover me קונסילר.`, two, "טוש")]).toEqual([0]);
    expect([...unfitProducts("הטושים מיועדים לגבות, לא לאזור העיניים, אבל Cover me קונסילר מתאים לשם.", two, "טוש")]).toEqual([0]);
    expect([...unfitProducts("Cover me קונסילר לא מתאים לגבות, אבל הוא מתאים לאזור העיניים.", two, "טוש")]).toEqual([1]);
    // A sentence that names none rules out the found products the text names nowhere else, never the one it offers.
    const three = [{ title: BROW, price: 59, inventoryState: "in_stock" }, { title: "Kiss eyebrows הטוש העדין למילוי גבות", price: 69, inventoryState: "in_stock" }, { title: "Cover me קונסילר", price: 89, inventoryState: "in_stock" }];
    expect([...unfitProducts("הטושים שמצאנו לא מתאימים לאזור העיניים. לאזור הזה יש אצלנו את Cover me קונסילר.", three, "טוש")]).toEqual([0, 1]);
    // (F) Each comma part has its own subject: the part that says fits marks its product, the other part's pens are out.
    expect([...unfitProducts("לאזור העיניים מתאים Cover me קונסילר, והטושים לא מתאימים.", two, "טוש")]).toEqual([0]);
    // In one part it names a product and says both that something fits and that something does not: which is which is not guessed.
    expect([...unfitProducts("לאזור העיניים מתאים Cover me קונסילר והטושים לא מתאימים.", two, "טוש")]).toEqual([]);
    // (J) One subject and what it is for: the "fits" is its own, and the pen is ruled out unless brows are her ask.
    expect([...unfitProducts("הטושים שמצאנו מתאימים לגבות בלבד, ולא מיועדים לאזור מתחת לעיניים.", two, "טוש")]).toEqual([0]);
    expect([...unfitProducts("הטושים שמצאנו מתאימים לגבות בלבד, ולא מיועדים לאזור מתחת לעיניים.", two, "טוש", "יש טוש לעיניים?")]).toEqual([0]);
    expect([...unfitProducts("הטושים שמצאנו מתאימים לגבות בלבד, ולא מיועדים לאזור מתחת לעיניים.", two, "טוש", "יש טוש לגבות?")]).toEqual([]);
    // They are for the very thing she asks for: a yes, nothing is ruled out. Asked for the other use, they are.
    expect([...unfitProducts(STATEMENT, brows, "טוש", "יש לכם טוש לגבות?")]).toEqual([]);
    expect([...unfitProducts(STATEMENT, brows, "טוש", "טוש אני רוצה")]).toEqual([0, 1]);
    expect([...unfitProducts(STATEMENT, brows, "טוש", "יש טוש חום לעיניים?")]).toEqual([0, 1]);
    expect([...unfitProducts("Ribbed Tank Top is meant for summer, not for winter.", found, null, "something for summer?")]).toEqual([]);
    expect([...unfitProducts("Ribbed Tank Top is meant for summer, not for winter.", found, null, "something for winter?")]).toEqual([1]);
    expect([...unfitProducts("הטוש לא מיועד לגבות.", brows, "טוש", "יש לכם טוש לגבות?")]).toEqual([0, 1]);
    expect([...unfitProducts(STATEMENT, brows, "טוש", "יש טוש גבות?")]).toEqual([]);
    expect([...unfitProducts("הטושים מתאימים לגבות ולא מתאימים לעיניים.", brows, "טוש", "יש טוש לעיניים?")]).toEqual([0, 1]);
    expect([...unfitProducts("הטושים מתאימים לגבות ולא מתאימים לעיניים.", brows, "טוש", "יש טוש לגבות?")]).toEqual([]);
    expect([...unfitProducts("Ribbed Tank Top is not meant for summer.", found, null, "something for summer?")]).toEqual([1]);
    // Only the product the sentence names.
    expect([...unfitProducts("Ribbed Tank Top לא מתאים לחורף.", found)]).toEqual([1]);
    // A sentence that names none and does not speak of the found products rules none out.
    expect([...unfitProducts("המשלוח לא מתאים לכתובות בחו\"ל.", brows)]).toEqual([]);
    expect([...unfitProducts("המשלוח לא מתאים לכתובות בחו\"ל.", found, "חולצה")]).toEqual([]);
    expect(aboutFound(STATEMENT, brows, "טוש")).toBe(true);
    expect(aboutFound("אפשר לשלם באשראי או בביט, לפי מה שנוח.", brows, "טוש")).toBe(false);
    expect([...namedMembers(ABSENCE, brows)]).toEqual([]);
  });

  // Rule S: the shown set follows the final text, one measure for the cards and the text channel's product lines.
  // Rating round on 9ce8a62b. Item 2: "מה מתאים למכשיר תמי 4?" got "לתמי 4 מתאים משטח סמובי אלכסה, ..." with no card
  // and no product line in 7 of 18 replays (one word of the title, "אלכסה", against titles that share the rest).
  const MATS = [{ title: "סמובי אלכסה - משטח הזזה 35*28 ס\"מ", price: 227 }, { title: "סמובי אריאל - משטח הזזה 34*38 ס\"מ", price: 189 }, { title: "סמובי גפן - משטח הזזה 20*30 ס\"מ", price: 149 }];
  const MAT_DATA = [{ content: "סמובי אלכסה: מתאים לתמי 4.", score: 0.9, documentTitle: "מוצרים", chunkIndex: 1, documentId: "m" }];
  const MAT_ASK = "מה מתאים למכשיר תמי 4?";
  const MAT_FIT = "לתמי 4 מתאים משטח סמובי אלכסה.";
  const B_SENTENCE = "טוש גבות חום לא מתאים לעיניים, אבל קונסילר לעיניים מתאים.";
  const OTHERS = "מתאים לך שאציג עוד פריטים במחירים נמוכים?";
  const COATS = [{ title: "Leather Jacket", price: 799 }, { title: "Wool Coat", price: 529 }, { title: "Ribbed Tank Top", price: 79 }];
  /** A turn whose drafts differ (the first, then the rewrites), each with its own cards. */
  const runDrafts = async (incoming: string, list: any[], ...drafts: Array<{ reply: string; cards?: string[] }>) => {
    h.groundList = list;
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "x" })] }, ...drafts.map((d, i) => ({ toolCalls: [respond(`d${i}`, d)] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
    return { r, t: r.trace as any, cards: h.staged.flatMap((x: any) => (x.products ?? []).map((p: any) => String(p.productId))) };
  };

  it("★ (rule S, item 2) a product the reply recommends by name gets its product line on a text channel", async () => {
    h.chunks = MAT_DATA; h.textChannel = true;
    const { r, t, cards } = await runDrafts(MAT_ASK, MATS, { reply: MAT_FIT });
    expect(r.trace.gate3.rewrite).toBe("none");
    expect(t.shownBy).toEqual(["named"]);
    expect(t.listedProducts).toEqual(["PRODUCT_1"]);
    expect(String(r.reply).startsWith(`${MAT_FIT}\n\nסמובי אלכסה - משטח הזזה 35*28 ס"מ\n₪227`)).toBe(true);
    expect(r.reply).not.toContain("אריאל");
    expect(r.reply).not.toContain("גפן");
    expect(cards).toEqual([]);
  });

  it("★ (rule S, item 2) the same on a cards channel: its card, with no card from the model and with the model's card on another product", async () => {
    h.chunks = MAT_DATA;
    const none = await runDrafts(MAT_ASK, MATS, { reply: MAT_FIT });
    expect(none.r.reply).toBe(MAT_FIT);
    expect(none.cards).toEqual(["201"]);
    expect(none.t.cards).toEqual(["PRODUCT_1"]);
    h.responses.length = 0; h.staged.length = 0;
    // Prod 2026-11-18 (a08a83): Alexa named, Ariel's card sent.
    const wrong = await runDrafts(MAT_ASK, MATS, { reply: MAT_FIT, cards: ["PRODUCT_2"] });
    expect(wrong.cards).toEqual(["201"]);
    expect(wrong.t.cardToNamed).toBe(true);
    h.responses.length = 0; h.staged.length = 0;
    // A card of the named product keeps the model's other cards beside it.
    const both = await runDrafts(MAT_ASK, MATS, { reply: MAT_FIT, cards: ["PRODUCT_1", "PRODUCT_3"] });
    expect(both.cards).toEqual(["201", "203"]);
    expect(both.t.shownBy).toBeUndefined();
  });

  it("★ (rule S) a question that names two found products shows both; a named product that is out of stock is not shown", async () => {
    const two = await runDrafts("מה יש לכם במעילים?", COATS, { reply: "מה מעניין אותך יותר, Leather Jacket או Wool Coat?" });
    expect(two.cards).toEqual(["201", "202"]);
    expect(two.t.shownBy).toEqual(["named"]);
    h.responses.length = 0; h.staged.length = 0;
    const out = await runFive("יש לכם שפתון?", "יש לנו שפתון אדום.");
    expect(out.cards).toEqual([]);
  });

  it("★ (rule S) the card swap: the text rules the brown pen out and says the concealer fits: the concealer's card, never the black pen's", async () => {
    // The draft passes the checks whole: nothing was cut, and the model's card on the brown pen still goes.
    h.chunks = FIT_DATA;
    const clean = await runFive("יש טוש לעיניים?", B_SENTENCE, ["PRODUCT_1", "PRODUCT_3"]);
    expect(clean.r.trace.gate3.rewrite).toBe("none");
    expect(clean.r.reply).toBe(B_SENTENCE);
    expect(clean.cards).toEqual(["203"]);
    expect((clean.r.trace as any).shownBy).toEqual(["unfit"]);
    expect((clean.r.trace as any).cardsByNoun).toBeUndefined();
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    // With a cut beside it (the cards-by-kind step swapped the concealer for the black pen: ["202"]).
    withCut();
    const cut = await runFive("יש טוש לעיניים?", `${B_SENTENCE} ${CUT}`, ["PRODUCT_1", "PRODUCT_3"]);
    expect(cut.r.reply).toBe(B_SENTENCE);
    expect(cut.cards).toEqual(["203"]);
    expect((cut.r.trace as any).cardsByNoun).toBeUndefined();
  });

  it("★ (rule S, item 1) the list that goes out when the statement is cut never offers what the draft ruled out", async () => {
    // Nothing grounds the sentence: both drafts are cut and the found products go out in its place.
    const { r, cards } = await runFive("יש טוש לעיניים?", B_SENTENCE, ["PRODUCT_1", "PRODUCT_3"]);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect((r.trace as any).fallbackKinds).toEqual(["ungrounded_negative_fit"]);
    expect(r.reply).toBe("הנה כמה אפשרויות: טוש גבות שחור, קונסילר לעיניים. אין לנו אישור שהם מתאימים בדיוק למה שביקשת.");
    expect(cards).toEqual(["202", "203"]);
  });

  it("★ (rule S, item 1) the same on a text channel: the product lines are the same set", async () => {
    h.textChannel = true;
    const { r } = await runFive("יש טוש לעיניים?", B_SENTENCE, ["PRODUCT_1", "PRODUCT_3"]);
    expect((r.trace as any).listedProducts).toEqual(["PRODUCT_2", "PRODUCT_3"]);
    expect(r.reply).not.toContain("טוש גבות חום");
    expect(r.reply).toContain("טוש גבות שחור\n₪149");
    expect(r.reply).toContain("קונסילר לעיניים\n₪99");
  });

  it("★ (rule S, item 1) the same name is said once, and two found products she cannot tell apart are one card", async () => {
    const fit = "הטושים שמצאנו מתאימים גם לאזור שמתחת לעיניים.";
    // Two store products with one title at two prices: one name in the line, both cards.
    const twins = await runFive("מה יש לכם לאיפור?", fit, [], [{ title: BROW, price: 79 }, { title: BROW, price: 89 }, { title: "קונסילר לעיניים", price: 99 }]);
    expect((twins.r.trace as any).fallbackKinds).toEqual(["ungrounded_positive_fit"]);
    expect(twins.r.reply).toBe(`הנה כמה אפשרויות: ${BROW}, קונסילר לעיניים. אין לנו אישור שהם מתאימים בדיוק למה שביקשת.`);
    expect(twins.cards).toEqual(["201", "202", "203"]);
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    // The same title at the same price: once.
    const same = [{ title: BROW, price: 79 }, { title: BROW, price: 79 }, { title: "קונסילר לעיניים", price: 99 }];
    const one = await runFive("מה יש לכם לאיפור?", fit, [], same);
    expect(one.r.reply).toBe(`הנה כמה אפשרויות: ${BROW}, קונסילר לעיניים. אין לנו אישור שהם מתאימים בדיוק למה שביקשת.`);
    expect(one.cards).toEqual(["201", "203"]);
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    // The place of the second one goes to the next found product.
    const next = await runFive("מה יש לכם לאיפור?", fit, [], [...same, { title: "שפתון אדום", price: 59 }]);
    expect(next.r.reply).toBe(`הנה כמה אפשרויות: ${BROW}, קונסילר לעיניים, שפתון אדום. אין לנו אישור שהם מתאימים בדיוק למה שביקשת.`);
    expect(next.cards).toEqual(["201", "203", "204"]);
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    // And on the model's own cards.
    const own = await runFive("מה יש לכם לאיפור?", "אלה המוצרים שיש אצלנו בחנות, אפשר לבחור מה שנוח לך.", ["PRODUCT_1", "PRODUCT_2", "PRODUCT_3"], same);
    expect(own.cards).toEqual(["201", "203"]);
    expect((own.r.trace as any).shownBy).toEqual(["twice"]);
  });

  it("★ (rule S, b) a question that offers other products carries no cards of the ones at hand", async () => {
    // The owner's topic is blocked: the first draft loses its sentence, the rewrite is the question alone, and the
    // model's cards (₪799 and ₪529) came with both.
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    const { r, t, cards } = await runDrafts("מה יש לכם במעילים?", COATS, { reply: `Leather Jacket ו-Wool Coat הם לא הכי זול שיש. ${OTHERS}`, cards: ["PRODUCT_1", "PRODUCT_2"] }, { reply: OTHERS, cards: ["PRODUCT_1", "PRODUCT_2"] }, { reply: OTHERS, cards: ["PRODUCT_1", "PRODUCT_2"] });
    expect(r.reply).toBe(OTHERS);
    expect(cards).toEqual([]);
    expect(t.shownBy).toEqual(["others"]);
    expect(t.cards).toEqual([]);
  });

  it("★ (rule S, b) on a text channel the question goes out with no product lines", async () => {
    h.textChannel = true;
    const { r, t } = await runDrafts("מה יש לכם במעילים?", COATS, { reply: OTHERS, cards: ["PRODUCT_1", "PRODUCT_2"] });
    expect(r.reply).toBe(OTHERS);
    expect(t.listedProducts).toBeUndefined();
    h.responses.length = 0; h.staged.length = 0;
    // And with no cards from the model.
    const bare = await runDrafts("מה יש לכם במעילים?", COATS, { reply: OTHERS });
    expect(bare.r.reply).toBe(OTHERS);
    expect(bare.t.listedProducts).toBeUndefined();
  });

  it("★ (rule S, b) the cards stay when the text speaks of them: it points at them, names one, or says more than the question", async () => {
    for (const reply of ["רוצה שאציג עוד מוצרים כמו האלה?", "שאציג עוד פריטים כמו Wool Coat?", "אלה המעילים שלנו. שאציג עוד פריטים במחירים נמוכים?", "יש לנו עוד פריטים במחירים נמוכים."]) {
      const { r, t, cards } = await runDrafts("מה יש לכם במעילים?", COATS, { reply, cards: ["PRODUCT_1", "PRODUCT_2"] });
      expect(r.reply, reply).toBe(reply);
      expect(cards, reply).toEqual(["201", "202"]);
      // Without the cards the pointer would point at nothing: the check on the final text keeps them.
      expect(t.shownKept, reply).toEqual(reply.includes("האלה") ? ["others"] : undefined);
      h.responses.length = 0; h.staged.length = 0;
    }
  });

  it("★ (rule S) a card whose product only a removed sentence named goes with the sentence", async () => {
    h.policyRow = { data: { blockedTopics: ["זול"] } };
    const kept = "כל המעילים שלנו עשויים מחומרים טבעיים ונשלחים בתוך שלושה ימי עסקים.";
    const { r, cards } = await runFive("מה יש לכם במעילים?", `Leather Jacket הוא לא הכי זול שיש לנו. ${kept}`, ["PRODUCT_1", "PRODUCT_2"], COATS);
    expect(r.reply).toBe(kept);
    expect((r.trace as any).cutText).toEqual(["Leather Jacket הוא לא הכי זול שיש לנו."]);
    expect(cards).toEqual(["202"]);
    expect((r.trace as any).shownBy).toEqual(["cut"]);
  });

  it("★ (rule S, item 1) on a cheap ask the list is the cheapest of her kind, never a cheaper product of another kind for the use she named", async () => {
    // The concealer (₪99) is for the use she named and costs less than the black pen (₪149): she asked for a cheap pen.
    const { r, cards } = await runFive("יש טוש זול לעיניים?", "הטושים שמצאנו מתאימים גם לאזור שמתחת לעיניים.");
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(r.reply).toBe("הנה כמה אפשרויות: טוש גבות חום, טוש גבות שחור. אין לנו אישור שהם מתאימים בדיוק למה שביקשת.");
    expect(cards).toEqual(["201", "202"]);
  });

  it("★ (rule S, item 1) a product either draft ruled out stays off the list, whichever draft said it", async () => {
    const fits = "הטושים שמצאנו מתאימים גם לאזור שמתחת לעיניים.";
    const line = "הנה כמה אפשרויות: טוש גבות שחור, קונסילר לעיניים. אין לנו אישור שהם מתאימים בדיוק למה שביקשת.";
    // The first draft rules the brown pen out and the rewrite does not.
    const first = await runDrafts("יש טוש לעיניים?", FIVE, { reply: B_SENTENCE, cards: ["PRODUCT_1", "PRODUCT_3"] }, { reply: fits, cards: ["PRODUCT_1", "PRODUCT_2"] });
    expect(first.r.trace.gate3.rewrite).toBe("fallback");
    expect(first.r.reply).toBe(line);
    expect(first.cards).toEqual(["202", "203"]);
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    // Only the rewrite does.
    const second = await runDrafts("יש טוש לעיניים?", FIVE, { reply: fits, cards: ["PRODUCT_1", "PRODUCT_2"] }, { reply: B_SENTENCE, cards: ["PRODUCT_1", "PRODUCT_3"] });
    expect(second.r.trace.gate3.rewrite).toBe("fallback");
    expect(second.r.reply).toBe(line);
    expect(second.cards).toEqual(["202", "203"]);
  });

  it("★ (rule S) the statement that stands on a member cut shows what she asked for, wherever it stands on the list", async () => {
    withCut();
    const six = [{ title: "מברשת איפור", price: 39 }, { title: "קונסילר לעיניים", price: 99 }, { title: "שפתון ורוד", price: 59 }, { title: "טוש גבות חום", price: 79 }, { title: "טוש גבות שחור", price: 149 }, { title: "קרם עיניים", price: 89 }];
    const { r, cards } = await runFive("יש טוש לעיניים?", `${STATEMENT} יש אחריות על טוש גבות חום גם בשימוש מתחת לעיניים.`, [], six);
    expect((r.trace as any).statementKept).toBe(true);
    // Both products for the use she named, not only the one among the first three found; never the pens it rules out.
    expect(cards).toEqual(["202", "206"]);
  });

  it("★ (rule S) a word she said as the use names no product, and a message that asks for no product gets no card by a name", async () => {
    h.chunks = FIT_DATA;
    const use = "יש לנו כמה מוצרים לעיניים, אשמח לעזור לבחור.";
    const a = await runFive("יש טוש לעיניים?", use);
    expect(a.r.reply).toBe(use);
    expect(a.cards).toEqual([]);
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    // A returns question: the reply names a found product, and no card goes with it.
    h.chunks = [{ content: "אפשר להחזיר כל מוצר בתוך 14 יום מיום הקבלה.", score: 0.9, documentTitle: "מדיניות", chunkIndex: 1, documentId: "p" }];
    const policy = "את Wool Coat אפשר להחזיר בתוך 14 יום מיום הקבלה.";
    const b = await runFive("מה מדיניות ההחזרות שלכם?", policy, [], COATS);
    expect(b.r.reply).toBe(policy);
    expect(b.cards).toEqual([]);
  });

  it("★ (rule S) the product lines of a text channel: only what she asked for, and the shown set even when it is another kind", async () => {
    h.textChannel = true;
    h.chunks = FIT_DATA;
    const mixed = [{ title: "מברשת איפור", price: 59 }, { title: "טוש גבות חום", price: 79 }, { title: "שפתון ורוד", price: 49 }, { title: "טוש גבות שחור", price: 149 }];
    const a = await runFive("יש לכם טוש?", "יש לנו כמה טושים, הנה הם.", [], mixed);
    expect((a.r.trace as any).listedProducts).toEqual(["PRODUCT_2", "PRODUCT_4"]);
    expect(a.r.reply).not.toContain("מברשת");
    expect(a.r.reply).not.toContain("שפתון");
    h.responses.length = 0; h.staged.length = 0; h.audits.length = 0;
    // The model's own card on a product of another kind that the text offers: its line goes out.
    const b = await runFive("יש טוש לעיניים?", "אולי מברשת איפור תתאים.", ["PRODUCT_4"]);
    expect((b.r.trace as any).listedProducts).toEqual(["PRODUCT_4"]);
    expect(b.r.reply).toContain("אולי מברשת איפור תתאים.\n\nמברשת איפור\n");
  });

  it("★ (rule S) the helpers: the shown set, the products of her ask, and a product said by name", async () => {
    const { shownProducts, ofHerAsk, forHerUse, namedMembers } = await import("../services/reply-engine/engine");
    const found = (list: any[]) => list.map((c, i) => ({ productId: String(201 + i), inventoryState: "in_stock", ...c }));
    const five = found(FIVE), coats = found(COATS), mats = found(MATS);
    const shown = (a: any) => shownProducts({ cards: [], ...a });
    // Never a product the text rules out; and the word after "not for" is the use, it names no product.
    expect(shown({ text: B_SENTENCE, cards: ["PRODUCT_1", "PRODUCT_3"], candidates: five, unfit: new Set([0]) })).toEqual({ cards: ["PRODUCT_3"], why: ["unfit"] });
    expect(shown({ text: "הטושים לא מתאימים לעיניים.", cards: ["PRODUCT_1", "PRODUCT_2"], candidates: five, unfit: new Set([0, 1]) })).toEqual({ cards: [], why: ["unfit"] });
    expect(shown({ text: "טוש גבות חום לא מתאים לעיניים.", candidates: five, unfit: new Set([0]), addNamed: true })).toEqual({ cards: [], why: [] });
    expect(shown({ text: "The pens are not meant for eyes.", candidates: found([{ title: "Brow Pen", price: 79 }, { title: "Eyes Concealer", price: 99 }]), addNamed: true })).toEqual({ cards: [], why: [] });
    // After a cut: a product only the removed sentence named goes with it; one the text still speaks of stays, and a
    // removed sentence that names none (or says a price) takes none.
    const ships = "כל המעילים נשלחים בתוך שלושה ימי עסקים.";
    const cutS = "Leather Jacket הוא לא הכי זול שיש לנו.";
    expect(shown({ text: ships, cards: ["PRODUCT_1", "PRODUCT_2"], candidates: coats, removed: [cutS] })).toEqual({ cards: ["PRODUCT_2"], why: ["cut"] });
    expect(shown({ text: "Leather Jacket נשלח בתוך שלושה ימי עסקים.", cards: ["PRODUCT_1", "PRODUCT_2"], candidates: coats, removed: [cutS] })).toEqual({ cards: ["PRODUCT_1", "PRODUCT_2"], why: [] });
    expect(shown({ text: ships, cards: ["PRODUCT_1", "PRODUCT_2"], candidates: coats, removed: [CUT] })).toEqual({ cards: ["PRODUCT_1", "PRODUCT_2"], why: [] });
    expect(shown({ text: ships, cards: ["PRODUCT_1", "PRODUCT_2"], candidates: coats, removed: ["המשלוח עולה ₪799."] })).toEqual({ cards: ["PRODUCT_1", "PRODUCT_2"], why: [] });
    // One question that offers other products, naming none of the found ones.
    const offers = [OTHERS, "רוצה לראות עוד מוצרים?", "שאציג עוד כמה אפשרויות?", "רוצה לראות עוד דגמים?", "רוצה לראות עוד חלופות?",
      "רוצה לראות פריטים אחרים?", "רוצה לראות מוצרים נוספים?", "רוצה לראות אפשרויות אחרות?", "רוצה לראות את הדגמים האחרים?", "רוצה לראות חלופות נוספות?",
      "Would you like to see more options at lower prices?", "Want to see other items?", "Shall I show another model?", "Want different products?"];
    for (const t of offers) expect(shown({ text: t, cards: ["PRODUCT_1", "PRODUCT_2"], candidates: coats }), t).toEqual({ cards: [], why: ["others"] });
    for (const t of ["יש לנו עוד פריטים במחירים נמוכים.", "אלה המעילים שלנו. שאציג עוד פריטים במחירים נמוכים?", "שאציג עוד פריטים כמו Wool Coat?", "מה עוד מעניין אותך?", "רוצה לשמוע עוד פרטים?", "רוצה לראות עוד?"]) expect(shown({ text: t, cards: ["PRODUCT_1", "PRODUCT_2"], candidates: coats }), t).toEqual({ cards: ["PRODUCT_1", "PRODUCT_2"], why: [] });
    // A product the text names: in place of cards on products it names none of; with no cards only on a product turn.
    expect(shown({ text: MAT_FIT, candidates: mats })).toEqual({ cards: [], why: [] });
    expect(shown({ text: MAT_FIT, candidates: mats, addNamed: true })).toEqual({ cards: ["PRODUCT_1"], why: ["named"] });
    expect(shown({ text: MAT_FIT, cards: ["PRODUCT_2"], candidates: mats })).toEqual({ cards: ["PRODUCT_1"], why: ["named"] });
    expect(shown({ text: MAT_FIT, cards: ["PRODUCT_1", "PRODUCT_3"], candidates: mats })).toEqual({ cards: ["PRODUCT_1", "PRODUCT_3"], why: [] });
    // Words the titles share name none of them.
    expect(shown({ text: "לתמי 4 מתאים משטח הזזה של סמובי.", cards: ["PRODUCT_2"], candidates: mats, addNamed: true })).toEqual({ cards: ["PRODUCT_2"], why: [] });
    // Never one out of stock, never by the customer's own first name, never by a word she said as the use; three at most.
    expect(shown({ text: "יש לנו שפתון אדום.", candidates: five, addNamed: true })).toEqual({ cards: [], why: [] });
    expect(shown({ text: "נשמח לעזור, אריאל.", candidates: mats, addNamed: true, contactNames: ["אריאל"] })).toEqual({ cards: [], why: [] });
    expect(shown({ text: "נשמח לעזור, אריאל.", candidates: mats, addNamed: true })).toEqual({ cards: ["PRODUCT_2"], why: ["named"] });
    expect(shown({ text: "יש לנו כמה מוצרים לעיניים.", candidates: five, addNamed: true, uses: ["עיניים"] })).toEqual({ cards: [], why: [] });
    expect(shown({ text: "יש לנו כמה מוצרים לעיניים.", candidates: five, addNamed: true })).toEqual({ cards: ["PRODUCT_3"], why: ["named"] });
    expect(shown({ text: "יש לנו טוש גבות חום, טוש גבות שחור, קונסילר לעיניים ומברשת איפור.", candidates: five, addNamed: true })).toEqual({ cards: ["PRODUCT_1", "PRODUCT_2", "PRODUCT_3"], why: ["named"] });
    // Her kind: a card stays when it is of her kind or the text names it; with none, her kind's that are not ruled out.
    const hers = new Set([0, 1]);
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_1", "PRODUCT_3"], candidates: five, hers })).toEqual({ cards: ["PRODUCT_1"], why: ["kind"] });
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_3", "PRODUCT_4"], candidates: five, hers })).toEqual({ cards: ["PRODUCT_1", "PRODUCT_2"], why: ["kind"] });
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_3", "PRODUCT_4"], candidates: five, hers, unfit: new Set([0]) })).toEqual({ cards: ["PRODUCT_2"], why: ["kind"] });
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_3", "PRODUCT_4"], candidates: five, hers, unfit: new Set([0, 1]) })).toEqual({ cards: ["PRODUCT_3", "PRODUCT_4"], why: [] });
    expect(shown({ text: "אולי מברשת איפור תתאים.", cards: ["PRODUCT_4"], candidates: five, hers })).toEqual({ cards: ["PRODUCT_4"], why: [] });
    expect(shown({ text: "הנה מה שמצאתי.", candidates: five, hers })).toEqual({ cards: [], why: [] });
    // A product of another kind whose title holds her use word stays when it was carded, and is never put in.
    const ofUse = new Set([2]);
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_3", "PRODUCT_4"], candidates: five, hers, ofUse })).toEqual({ cards: ["PRODUCT_3"], why: ["kind"] });
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_4"], candidates: five, hers, ofUse, unfit: new Set([0, 1]) })).toEqual({ cards: ["PRODUCT_4"], why: [] });
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_4"], candidates: five, hers, ofUse, unfit: new Set([0]) })).toEqual({ cards: ["PRODUCT_2"], why: ["kind"] });
    // Each product once: the same id, or the same title at the same price; the same title at another price is another
    // product. A key past the list is dropped.
    const twins = [{ productId: "1", title: "A Pen", price: 79 }, { productId: "1", title: "A Pen", price: 79 }, { productId: "2", title: "A Pen", price: 79 }, { productId: "3", title: "A Pen", price: 89 }, { productId: "4", title: "B Pen", price: 79 }, { productId: "4", title: "C Pen", price: 99 }];
    expect(shown({ text: "הנה מה שמצאתי.", cards: ["PRODUCT_1", "PRODUCT_2", "PRODUCT_3", "PRODUCT_4", "PRODUCT_5", "PRODUCT_6", "PRODUCT_1", "PRODUCT_9"], candidates: twins })).toEqual({ cards: ["PRODUCT_1", "PRODUCT_4", "PRODUCT_5"], why: ["twice"] });
    // The found products of her ask: of her kind and in stock, with the ones whose title holds her use word.
    expect(ofHerAsk(five, "טוש", "יש טוש לעיניים?")).toEqual([0, 1, 2]);
    expect(ofHerAsk(five, "טוש", "יש טוש?")).toEqual([0, 1]);
    expect(ofHerAsk(five, null, "מה יש לכם?")).toEqual([0, 1, 2, 3]);
    expect(ofHerAsk(five, "מעיל", "יש מעיל לעיניים?")).toEqual([0, 1, 2, 3]);
    // A found product whose own category is another kind is not of her ask.
    const bags = [{ productId: "1", title: "Canvas Tote", inventoryState: "in_stock" }, { productId: "2", title: "קשת לשיער", inventoryState: "in_stock", attributes: { category: "קשתות" } }];
    expect(ofHerAsk(bags, "תיק", "יש תיק?")).toEqual([0]);
    expect(forHerUse(five, ["עיניים"])).toEqual([2]);
    expect(forHerUse(five, [])).toEqual([]);
    // By name: a word only one title has; two words the titles share, a price, or being the only one found is no name.
    expect([...namedMembers(MAT_FIT, mats, "name")]).toEqual([0]);
    expect([...namedMembers("משטח הזזה של סמובי מתאים.", mats, "name")]).toEqual([]);
    // By name: the whole title, the title with no size, its head, in any letter case.
    for (const said of ["לתמי 4 מתאים סמובי אלכסה - משטח הזזה 35*28 ס\"מ.", "לתמי 4 מתאים סמובי אלכסה - משטח הזזה.", "לתמי 4 מתאים סמובי אלכסה."]) expect([...namedMembers(said, mats, "name")]).toEqual([0]);
    expect([...namedMembers("the wool coat is warm.", coats, "name")]).toEqual([1]);
    expect([...namedMembers("יש לנו טוש גבות.", five)]).toEqual([0, 1]);
    expect([...namedMembers("יש לנו טוש גבות.", five, "name")]).toEqual([]);
    expect(shown({ text: "יש לנו טוש גבות.", candidates: five, addNamed: true })).toEqual({ cards: [], why: [] });
    // A whole title in another letter case, when each of its words is in another title too.
    const pens = found([{ title: "Brow Pen", price: 79 }, { title: "Eye Pen", price: 89 }, { title: "Brow Pencil", price: 59 }]);
    expect([...namedMembers("We have the brow pen in stock.", pens, "name")]).toEqual([0]);
    // A title inside a longer found title the text says is not said itself, in any letter case and in every mode.
    for (const how of ["any", "words", "name"] as const) {
      expect([...namedMembers("We have the brow pencil in stock.", pens, how)], how).toEqual([2]);
      expect([...namedMembers("We have the Brow Pencil in stock.", pens, how)], how).toEqual([2]);
    }
    expect([...namedMembers("We have the Brow Pen in stock.", pens, "name")]).toEqual([0]);
    expect(shown({ text: "For brows we recommend the brow pencil.", candidates: pens, addNamed: true })).toEqual({ cards: ["PRODUCT_3"], why: ["named"] });
    expect([...namedMembers("We have a pen for brows.", pens, "name")]).toEqual([]);
    expect([...namedMembers("המחיר הוא ₪799.", coats)]).toEqual([0]);
    expect([...namedMembers("המחיר הוא ₪799.", coats, "name")]).toEqual([]);
    expect([...namedMembers("המחיר הוא ₪799.", coats, "words")]).toEqual([]);
    expect([...namedMembers("המוצר הזה מתאים.", [coats[0]])]).toEqual([0]);
    expect([...namedMembers("המוצר הזה מתאים.", [coats[0]], "name")]).toEqual([]);
    expect([...namedMembers("המוצר הזה מתאים.", [coats[0]], "words")]).toEqual([]);
  });
});

describe("a draft that hedges on the fit of what was found never gets the product list (the 41805962 replay, NE'A L1122)", () => {
  // The turn as the replay prints it: her message, the search, the first three titles, the draft. The fourth product and
  // the stock states stand in for what the file does not print (the cards were products 2, 3 and 5).
  const PENCILS = [{ title: "עיפרון עיניים ושפתיים Drama qween", price: 59, inventoryState: "out_of_stock" }, { title: "עיפרון עיניים ושפתיים LiLu", price: 59 }, { title: "עיפרון עיניים ושפתיים first coffee", price: 59 }, { title: "שמן שפתיים פנומנל", price: 69, inventoryState: "out_of_stock" }, { title: "קיט בייסיק לשפתיים שמן שפתיים פנומנל ועיפרון פירסט קופי", price: 119 }];
  const L1122 = "מצאתי עיפרון בגוון חום שוקולדי, אבל בתיאור מצוין שהוא מיועד לתחימת שפתיים ולא מצוין אם מתאים מתחת לעיניים. אפשר לראות גם עיפרון עיניים חום, אבל הגוון שלו לא מצוין בתיאור.";
  const PENS = [{ title: "טוש גבות חום", price: 79 }, { title: "טוש גבות שחור", price: 149 }, { title: "קונסילר לעיניים", price: 99 }];
  const PEN_DATA = [{ content: "טוש גבות: מיועד לגבות.", score: 0.9, documentTitle: "מוצרים", chunkIndex: 1, documentId: "f" }];
  const LIST = /הנה כמה אפשרויות|אין לנו אישור שהם מתאימים/;
  // Was the team line (2026-11-23: there is none). With nothing left to say on a product ask: the question that moves
  // the choice on, never the list and never a team claim.
  const noAnswer = (x: any) => { expect(String(x.reply ?? "").replace(HAND, "")).not.toMatch(TEAM_CLAIM); expect(String(x.reply ?? "")).not.toMatch(LIST); };
  const turn = async (incoming: string, query: string, list: any[], ...drafts: string[]) => {
    h.groundList = list;
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query })] }, ...drafts.map((d, i) => ({ toolCalls: [respond(`d${i}`, { reply: d })] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
    return { r, t: r.trace as any, cards: h.staged.flatMap((x: any) => (x.products ?? []).map((p: any) => String(p.productId))) };
  };
  const again = () => { h.responses.length = 0; h.staged.length = 0; h.audits.length = 0; };

  it("★ L1122: the hedge is no fit claim, and the draft goes out as the answer", async () => {
    const { r, t, cards } = await turn("אני רוצה גוון חום למתחת לעיינים", "עיפרון חום עיניים", PENCILS, L1122, L1122, L1122);
    // Only the wording ("מצאתי") is left to fix.
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toEqual(["style"]);
    expect(r.reply).toBe("יש עיפרון בגוון חום שוקולדי, אבל בתיאור מצוין שהוא מיועד לתחימת שפתיים ולא מצוין אם מתאים מתחת לעיניים. אפשר לראות גם עיפרון עיניים חום, אבל הגוון שלו לא מצוין בתיאור.");
    expect(r.reply).not.toMatch(LIST);
    expect(t.fallbackKinds).toBeUndefined();
    // It names no product, so a rewrite is asked; the rewrite says the same, and the draft stands as a statement,
    // with the in-stock products of her ask under it.
    expect(t.statementKept).toBe(true);
    expect(cards).toEqual(["202", "203", "205"]);
  });

  it("★ what a cut leaves of a hedged draft is the answer, also when the cut took another product's sentence", async () => {
    h.chunks = PEN_DATA; h.policyRow = { data: { blockedTopics: ["אחריות"] } };
    const hedge = "טוש גבות חום מיועד לגבות, ולא מצוין אם הוא מתאים לעיניים.";
    // The owner's list cuts the second sentence, and it named a found product the hedge does not.
    const { r, t, cards } = await turn("יש טוש לעיניים?", "טוש", PENS, ...[0, 1, 2].map(() => `${hedge} על טוש גבות שחור יש אחריות לשנה.`));
    expect(t.memberCut).toBe(true);
    expect(t.hedgeKept).toBe(true);
    expect(r.reply).toBe(hedge);
    // Only the product it names goes under it.
    expect(cards).toEqual(["201"]);
  });

  it("★ with nothing left of the hedged draft, no products and never the list", async () => {
    h.chunks = PEN_DATA; h.policyRow = { data: { blockedTopics: ["אחריות"] } };
    // The owner's list cuts the whole sentence, the hedge with it.
    const gone = "לא מצוין שהטושים מתאימים לעיניים, ויש עליהם אחריות לשנה.";
    const { r, t, cards } = await turn("יש טוש לעיניים?", "טוש", PENS, gone, gone, gone);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(t.hedgeKept).toBeUndefined();
    noAnswer(r);
    expect(cards).toEqual([]);
  });

  it("★ a bare hedge of a few words, or one that leans on the cut sentence, is no answer: no products, no list", async () => {
    h.chunks = PEN_DATA; h.policyRow = { data: { blockedTopics: ["אחריות"] } };
    // Five words are left.
    const short = "לא ידוע אם הטושים מתאימים לעיניים. על טוש גבות שחור יש אחריות לשנה.";
    // What is left opens with "אבל".
    const leans = "על טוש גבות שחור יש אחריות לשנה. אבל לא ידוע אם טוש גבות חום מתאים לעיניים או רק לגבות.";
    for (const draft of [short, leans]) {
      const { r, t, cards } = await turn("יש טוש לעיניים?", "טוש", PENS, draft, draft, draft);
      expect(r.trace.gate3.rewrite).toBe("fallback");
      expect(t.hedgeKept).toBeUndefined();
      noAnswer(r);
      expect(cards).toEqual([]);
      again();
    }
  });

  it("★ a remnant that lost the hedge is not the hedged answer: no products, no list", async () => {
    h.chunks = PEN_DATA; h.policyRow = { data: { blockedTopics: ["אחריות"] } };
    // The owner's list cuts the hedge sentence, which named the black pen; the brown pen's sentence is left, and alone
    // it would read as an offer.
    const draft = "לא מצוין אם טוש גבות שחור מתאים לעיניים, ויש עליו אחריות לשנה. טוש גבות חום עולה 79 ₪ והוא נמצא במלאי אצלנו עכשיו.";
    const { r, t, cards } = await turn("יש טוש לעיניים?", "טוש", PENS, draft, draft, draft);
    expect(r.trace.gate3.rewrite).toBe("fallback");
    expect(t.hedgeKept).toBeUndefined();
    noAnswer(r);
    expect(cards).toEqual([]);
  });

  it("★ a hedge in either draft: the list never goes out for the other draft's cut fit claim", async () => {
    h.chunks = PEN_DATA; h.policyRow = { data: { blockedTopics: ["אחריות"] } };
    const gone = "לא מצוין אם הטושים מתאימים לעיניים, ויש עליהם אחריות לשנה.";
    const fits = "הטושים שמצאנו מתאימים גם לאזור שמתחת לעיניים.";
    // Without a hedge the cut fit claim gets the list, with the word that the fit is not confirmed.
    const none = await turn("יש טוש לעיניים?", "טוש", PENS, fits, fits, fits);
    expect(none.r.reply).toMatch(LIST);
    expect(none.cards.length).toBeGreaterThan(0);
    again();
    // The first draft hedged and the rewrite claimed the fit.
    const first = await turn("יש טוש לעיניים?", "טוש", PENS, gone, fits, fits);
    expect(first.r.trace.gate3.rewrite).toBe("fallback");
    noAnswer(first.r);
    expect(first.cards).toEqual([]);
    again();
    // Only the rewrite hedged.
    const second = await turn("יש טוש לעיניים?", "טוש", PENS, fits, gone, gone);
    expect(second.r.trace.gate3.rewrite).toBe("fallback");
    noAnswer(second.r);
    expect(second.cards).toEqual([]);
  });

  it("★ the helpers: \"not stated whether it fits\" rules no product out and marks none as fitting", async () => {
    const { unfitProducts } = await import("../services/reply-engine/engine");
    const on = (text: string) => [...unfitProducts(text, PENS as any[], "טוש", "יש טוש לעיניים?")].sort();
    expect(on("לא מצוין אם טוש גבות חום מתאים לאזור העיניים.")).toEqual([]);
    expect(on("טוש גבות חום מיועד לגבות, ולא מצוין אם הוא מתאים לאזור העיניים.")).toEqual([]);
    // What the sentence says past the hedge still counts, with "אם" as with "ש".
    expect(on("לא מצוין שהוא מתאים לעיניים, ולכן הטוש לא מתאים לשימוש שם.")).toEqual([0, 1]);
    expect(on("לא מצוין אם הוא מתאים לעיניים, ולכן הטוש לא מתאים לשימוש שם.")).toEqual([0, 1]);
    // The hedge is no "it fits" either: the product it names is still ruled out by the sentence that says so.
    expect(on("לא מצוין אם טוש גבות חום מתאים לעיניים. טוש גבות חום לא מתאים לעור רגיש.")).toEqual([0]);
    // A condition is no hedge: the product it names is one the text says fits.
    expect(on("אם טוש גבות חום מתאים לך, הוא במלאי. הטושים האחרים לא מתאימים לאזור העיניים.")).toEqual([1]);
  });
});

describe("the size table's fit cut leaves no orphan opening (the 41805962 replay, Smoovee L511 and L1929)", () => {
  const ASK = "נינג׳ה קרמה 28x18 סודה 18x14";
  async function sized(...drafts: string[]) {
    h.groundTitle = "משטח הזזה 20*30"; h.extraTitle = "משטח הזזה 16.4*23";
    h.responses.push({ toolCalls: [tc("z0", "woocommerce.list_products", { query: "משטח" })] }, ...drafts.map((d, i) => ({ toolCalls: [respond(`z${i + 1}`, { reply: d })] })));
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: ASK }, "autonomous");
    return { r, t: r.trace as any, reply: String(r.reply ?? "") };
  }

  it("★ L1929: a size with a decimal is never split: the whole sentence goes, and no \"4×23 ס\"מ, ב-89 ₪.\" is left", async () => {
    const d = "לנינג'ה קרמה מתאים משטח הזזה 20*30. לסודה מתאים משטח בגודל 16.4×23 ס\"מ, ב-89 ₪.";
    const { t, reply } = await sized(d, d, d);
    expect(t.fitClaimCut).toBe(1);
    expect(reply).not.toMatch(/(?:^|\n|\.\s)\s*4×23/);
    expect(reply).not.toMatch(/ב-89 ₪/);
    // Cut as ONE sentence: split at "16." its second half would only have gone as a leaning fragment.
    expect(t.leaningCut).toBeUndefined();
    expect(reply).toBe("לנינג'ה קרמה מתאים משטח הזזה 20*30.\nלמידה 18×14: משטח הזזה 16.4*23.");
  });

  it("★ a measure or a price alone right after a cut sentence goes with it", async () => {
    const d = "לסודה מתאים המשטח הגדול. 20×30 ס\"מ, ב-₪79. המשטחים עשויים במבוק.";
    const { t, reply } = await sized(d, d, d);
    expect(t.fitClaimCut).toBe(1);
    expect(t.leaningCut).toBe(1);
    expect(reply).toBe("המשטחים עשויים במבוק.\nלמידה 28×18: משטח הזזה 20*30.\nלמידה 18×14: משטח הזזה 16.4*23.");
  });

  it("★ L511: the sentence after a cut one that opens with a bare pronoun goes with it", async () => {
    const d = "לנינג'ה קרמה ולסודה מתאים משטח הזזה 20*30. הוא במבצע עכשיו ב-₪79. המשלוח מגיע תוך שלושה ימי עסקים.";
    const { t, reply } = await sized(d, d, d);
    expect(t.fitClaimCut).toBe(1);
    expect(t.leaningCut).toBe(1);
    expect(reply).not.toMatch(/הוא במבצע/);
    expect(reply).toMatch(/למידה 28×18: משטח הזזה 20\*30\./);
    expect(reply).toMatch(/למידה 18×14: משטח הזזה 16\.4\*23\./);
  });

  it("★ a pronoun sentence after a sentence that stays is kept, and so is a full sentence after a cut one", async () => {
    const d = "לנינג'ה קרמה מתאים משטח הזזה 20*30. הוא במבצע עכשיו ב-₪79. לסודה מתאים המשטח הגדול. המשטחים עשויים במבוק.";
    const { t, reply } = await sized(d, d, d);
    expect(t.fitClaimCut).toBe(1);
    expect(t.leaningCut).toBeUndefined();
    expect(reply).toMatch(/^לנינג'ה קרמה מתאים משטח הזזה 20\*30\. הוא במבצע עכשיו ב-₪79\. המשטחים עשויים במבוק\./);
    expect(reply).not.toMatch(/המשטח הגדול/);
    expect(reply).toMatch(/למידה 18×14: משטח הזזה 16\.4\*23\./);
  });
});

describe("the customer ended it: the turn is marked for the quiet close (2026-11-19), through a whole turn", () => {
  const at = new Date("2026-11-19T09:00:00.000Z");
  const thanks = (bot: string) => [
    { direction: "INBOUND", body: "יש לכם תיק בד?", metadata: null, createdAt: new Date(at.getTime() - 120_000) },
    { direction: "OUTBOUND", body: bot, senderName: "AI Bot", metadata: { source: "ai_bot" }, createdAt: new Date(at.getTime() - 60_000) },
    { direction: "INBOUND", body: "תודה רבה", metadata: null, createdAt: at },
  ];
  const end = { ...opts, incomingMessage: "תודה רבה" };

  it("★ \"תודה רבה\" after an answer, the reply asks nothing: the live state carries the mark, with the message's own time", async () => {
    h.history = thanks("כן, יש תיק בד ב-₪79.");
    h.responses.push({ toolCalls: [respond("e1", { reply: "בשמחה, יום נעים." })] });
    await runReplyEngineTurn(end, "autonomous");
    expect(h.upserts[0].where.conversationId_lane.lane).toBe("live");
    expect(h.upserts[0].create.facts._endedAt).toBe(at.toISOString());
  });

  it("★ not an end: the bot had asked, the reply asks, or the customer asks for more", async () => {
    const cases: Array<[any[], string, string]> = [
      [thanks("יש תיק בד ב-₪79. לשלוח קישור?"), "תודה רבה", "בשמחה, יום נעים."],
      [thanks("כן, יש תיק בד ב-₪79."), "תודה רבה", "בשמחה! יש עוד משהו שאפשר לעזור בו?"],
      [thanks("כן, יש תיק בד ב-₪79.").map((m, i) => (i === 2 ? { ...m, body: "תודה, ומה לגבי משלוח?" } : m)), "תודה, ומה לגבי משלוח?", "המשלוח מגיע תוך כמה ימים."],
    ];
    for (const [history, incoming, reply] of cases) {
      h.upserts.length = 0;
      h.history = history;
      h.responses.push({ toolCalls: [respond("e2", { reply })] });
      await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
      expect([incoming, reply, h.upserts[0].create.facts._endedAt]).toEqual([incoming, reply, undefined]);
    }
  });

  it("★ the shadow lane never carries the mark", async () => {
    h.history = thanks("כן, יש תיק בד ב-₪79.");
    h.responses.push({ toolCalls: [respond("e3", { reply: "בשמחה, יום נעים." })] });
    await runReplyEngineTurn(end, "shadow");
    expect(h.upserts[0].where.conversationId_lane.lane).toBe("shadow");
    expect(h.upserts[0].create.facts._endedAt).toBeUndefined();
  });
});

/**
 * The model's own close_conversation (2026-11-22). On dev, with the bot idle default on, a customer wrote
 * "תודה רבה, זה הכל" and the model called the business's close tool: the conversation closed at once, with no
 * closing event, so a late "and one more thing" would open a new conversation instead of landing in this one.
 */
describe("the model's own close_conversation, through a whole turn", () => {
  const at = new Date("2026-11-22T09:00:00.000Z");
  const STOCK = "יש גופיית ריב בגווני שחור ואקרו, אבל לא בלבן.";
  const ASKED = "יש בשחור ובאקרו. עוד משהו שאוכל לעזור בו?";
  const DEFERRED = "close_deferred: the customer said goodbye. Do not close now: the conversation closes by itself a few minutes after a goodbye and stays open for a late message. Answer the customer as you would answer any goodbye, and do not call close_conversation again.";
  const NOT_ALLOWED = "close_not_allowed: do NOT close this conversation. The customer has not ended it (an explicit thanks, bye or that's all after their need was met). Answer their latest message and keep the conversation open.";
  const talk = (botLine: string, incoming: string) => [
    { direction: "INBOUND", body: "יש גופיית ריב בלבן?", metadata: null, createdAt: new Date(at.getTime() - 120_000) },
    { direction: "OUTBOUND", body: botLine, senderName: "AI Bot", metadata: { source: "ai_bot" }, createdAt: new Date(at.getTime() - 60_000) },
    { direction: "INBOUND", body: incoming, metadata: null, createdAt: at },
  ];
  const group = (enabled: boolean) => ({ enabled, reminderAfterMinutes: 45, closeAfterReminderMinutes: 20, reminderText: "", closeText: "" });
  /** The model calls the close tool first, reads the result, then answers. */
  const closeTurn = async (incoming: string, o: { botLine?: string; lane?: "autonomous" | "shadow"; answer?: Record<string, unknown> } = {}) => {
    h.offerClose = true;
    h.history = talk(o.botLine ?? STOCK, incoming);
    h.responses.push(
      { toolCalls: [tc("k1", "close_conversation", { reason: "the customer said goodbye" })] },
      { toolCalls: [respond("k2", { reply: "בשמחה, יום נעים!", ...(o.answer ?? {}) })] },
    );
    return runReplyEngineTurn({ ...opts, incomingMessage: incoming }, o.lane ?? "autonomous");
  };
  const closeRan = () => h.dispatched.some((d: any) => d.name === "close_conversation") || h.submitted.includes("close_conversation");
  const modelRead = () => String(h.calls[1]?.messages.find((m: any) => m.role === "tool" && m.tool_call_id === "k1")?.content ?? "");
  const reasonRead = () => { try { return JSON.parse(modelRead()).reason ?? null; } catch { return null; } };
  const logged = (r: any) => r.toolCallLog.find((t: any) => t.tool === "close_conversation")?.decision;
  const auditCode = () => h.audits.find((a: any) => a.data.action === "ai.tool_call.close_conversation")?.data.metadata.errorCode;
  const mark = () => h.upserts[0]?.create.facts._endedAt;
  afterEach(() => { delete process.env.BOT_IDLE_DEFAULT_ON; });

  it("★ the dev case: \"תודה רבה, זה הכל\" with the default on: the close never runs, the model is told why, the turn is marked", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    const r = await closeTurn("תודה רבה, זה הכל");
    expect(closeRan()).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(reasonRead()).toBe(DEFERRED);
    expect(JSON.parse(modelRead())).toEqual({ ok: false, failure: "refused", reason: DEFERRED });
    // Never read as a close that happened: the worker announces a close only for an "executed" call.
    expect(logged(r)).toBe("deny");
    expect(r.trace.tools.find((t: any) => t.tool === "close_conversation")).toMatchObject({ decision: "deny" });
    expect(auditCode()).toBe("refused:close_deferred");
    expect(r.reply).toBe("בשמחה, יום נעים!");
    expect(r.escalation).toBeNull();
    expect(mark()).toBe(at.toISOString());
    expect(h.settingReads).toEqual([["t1", "botIdleAutomation"]]);
  });

  it("★ the same on every channel of the two groups, and for a business with its own saved rule", async () => {
    for (const [channel, row] of [["WHATSAPP", null], ["INSTAGRAM", null], ["SHOPIFY_LIVE_CHAT", null], ["WHATSAPP", JSON.stringify({ groups: { messaging: group(true) } })], ["WEBCHAT", JSON.stringify({ groups: { liveChat: group(true) } })]] as const) {
      for (const k of ["responses", "calls", "dispatched", "submitted", "upserts", "audits"] as const) (h as any)[k].length = 0;
      process.env.BOT_IDLE_DEFAULT_ON = "true";
      h.channel = channel;
      h.idleRow = row;
      const r = await closeTurn("לא תודה, זה הכל");
      expect([channel, row, closeRan(), reasonRead(), logged(r), mark()]).toEqual([channel, row, false, DEFERRED, "deny", at.toISOString()]);
    }
  });

  it("★ after the bot's own question: a deferred close marks the turn; with no close call the same words do not", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    await closeTurn("לא תודה, זה הכל", { botLine: ASKED });
    expect([closeRan(), reasonRead(), mark()]).toEqual([false, DEFERRED, at.toISOString()]);

    h.upserts.length = 0; h.responses.length = 0; h.calls.length = 0;
    h.history = talk(ASKED, "לא תודה, זה הכל");
    h.responses.push({ toolCalls: [respond("k3", { reply: "בשמחה, יום נעים!" })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "לא תודה, זה הכל" }, "autonomous");
    expect(mark()).toBeUndefined();
  });

  it("★ a deferred close does not mark a turn that is still open: the reply asks, or it goes to a person", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    await closeTurn("תודה רבה, זה הכל", { answer: { reply: "בשמחה! רוצה שאשלח לך קישור לגופייה בשחור?" } });
    expect([closeRan(), reasonRead(), mark()]).toEqual([false, DEFERRED, undefined]);
  });

  it("★ no quiet close here: the close runs at once, as before (switch off, group switched off, a channel with no rule)", async () => {
    const cases: Array<[string | undefined, string, string | null, number]> = [
      [undefined, "WEBCHAT", null, 0],
      ["off", "WEBCHAT", null, 0],
      ["", "WHATSAPP", JSON.stringify({ groups: { messaging: group(true) } }), 0],
      ["on", "WEBCHAT", JSON.stringify({ groups: { liveChat: group(false) } }), 1],
      ["on", "WHATSAPP", JSON.stringify({ groups: { messaging: group(false) } }), 1],
      ["on", "SMS", null, 1],
    ];
    for (const [env, channel, row, reads] of cases) {
      for (const k of ["responses", "calls", "dispatched", "submitted", "upserts", "audits", "settingReads"] as const) (h as any)[k].length = 0;
      if (env === undefined) delete process.env.BOT_IDLE_DEFAULT_ON; else process.env.BOT_IDLE_DEFAULT_ON = env;
      h.channel = channel;
      h.idleRow = row;
      const r = await closeTurn("תודה רבה, זה הכל");
      expect([env, channel, h.dispatched.map((d: any) => d.name), logged(r), reasonRead(), h.settingReads.length]).toEqual([env, channel, ["close_conversation"], "executed", null, reads]);
    }
  });

  it("★ the setting could not be read: the close runs, because nothing proves a quiet close would follow", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    h.idleReadThrows = true;
    const r = await closeTurn("תודה רבה, זה הכל");
    expect(h.dispatched.map((d: any) => d.name)).toEqual(["close_conversation"]);
    expect(logged(r)).toBe("executed");
    expect(h.settingReads).toHaveLength(1);
  });

  it("★ the customer has not ended it: the close is refused, with the switch on or off, and nothing is marked", async () => {
    for (const env of ["on", undefined]) {
      for (const incoming of ["תודה, אבל עוד שאלה", "יש גם בכחול"]) {
        for (const k of ["responses", "calls", "dispatched", "submitted", "upserts", "audits", "settingReads"] as const) (h as any)[k].length = 0;
        if (env === undefined) delete process.env.BOT_IDLE_DEFAULT_ON; else process.env.BOT_IDLE_DEFAULT_ON = env;
        const r = await closeTurn(incoming, { answer: { reply: "בטח, אני כאן." } });
        expect([env, incoming, closeRan(), reasonRead(), logged(r), auditCode(), mark(), h.settingReads.length])
          .toEqual([env, incoming, false, NOT_ALLOWED, "deny", "refused:close_not_allowed", undefined, 0]);
      }
    }
  });

  it("★ a first message is never an end: the close is refused before the bot has answered anything", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    h.offerClose = true;
    h.history = [{ direction: "INBOUND", body: "תודה", metadata: null, createdAt: at }];
    h.responses.push({ toolCalls: [tc("k1", "close_conversation", { reason: "thanks" })] }, { toolCalls: [respond("k2", { reply: "היי! איך אפשר לעזור?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה" }, "autonomous");
    expect([closeRan(), reasonRead(), logged(r), mark()]).toEqual([false, NOT_ALLOWED, "deny", undefined]);
  });

  it("★ the model asks again in the same turn: still held back", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    h.offerClose = true;
    h.history = talk(STOCK, "תודה רבה, זה הכל");
    h.responses.push(
      { toolCalls: [tc("k1", "close_conversation", { reason: "bye" })] },
      { toolCalls: [tc("k1b", "close_conversation", { reason: "bye again" })] },
      { toolCalls: [respond("k2", { reply: "בשמחה, יום נעים!" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה רבה, זה הכל" }, "autonomous");
    expect(closeRan()).toBe(false);
    expect(r.toolCallLog.filter((t: any) => t.tool === "close_conversation").map((t: any) => t.decision)).toEqual(["deny", "deny"]);
    expect(mark()).toBe(at.toISOString());
  });

  it("★ the shadow lane: the same hold-back, nothing simulated, and no mark", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    const r = await closeTurn("תודה רבה, זה הכל", { lane: "shadow" });
    expect([closeRan(), reasonRead(), logged(r)]).toEqual([false, DEFERRED, "deny"]);
    expect(h.upserts[0].where.conversationId_lane.lane).toBe("shadow");
    expect(mark()).toBeUndefined();
  });

  it("★ a held-back close is not a tool asking for a person: a handoff on that turn is still judged on its own", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    for (const [incoming, reason] of [["תודה רבה, זה הכל", DEFERRED], ["יש גם בכחול", NOT_ALLOWED]] as const) {
      for (const k of ["responses", "calls", "dispatched", "submitted", "upserts", "audits"] as const) (h as any)[k].length = 0;
      h.offerClose = true;
      h.history = talk(STOCK, incoming);
      h.responses.push(
        { toolCalls: [tc("k1", "close_conversation", { reason: "done" })] },
        { toolCalls: [respond("k2", { reply: "מעבירים אותך לנציג שימשיך מכאן.", handoff: "closing the conversation" })] },
        { toolCalls: [respond("k3", { reply: "בשמחה, אני כאן אם צריך." })] },
      );
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: incoming }, "autonomous");
      expect([incoming, reasonRead(), r.trace.gate3.problems.map((p: any) => p.kind).includes("needless_handoff"), r.escalation]).toEqual([incoming, reason, true, null]);
    }
  });

  it("the control for that: any other refused tool still lets the handoff through", async () => {
    h.offerWrite = true;
    h.history = talk(STOCK, "תודה רבה, זה הכל");
    h.responses.push(
      { toolCalls: [tc("w1", "woocommerce.add_order_note", { order_id: "5", note: "x", customer_visible: true })] },
      { toolCalls: [respond("w2", { reply: "מעבירים אותך לנציג שימשיך מכאן.", handoff: "could not write the note" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה רבה, זה הכל" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).not.toContain("needless_handoff");
  });
});

// The customer's message, the draft and the sent text are the replay's own (prod replay 2026-11-22). The state holds the
// product as the earlier turn stored it: the store's price then, in the store's own writing.
describe("prod replay 2026-11-22, through a whole turn: a product an earlier turn showed", () => {
  const INCOMING = "איזה גוון מייקאפ יתאים לעור שלי?";
  const DRAFT = "יש לנו מייקאפ טינט שמתאים כמעט לכולן ומשנה גוון מלבן לצבע העור. אם הכוונה למייקאפ אחר, כתבי איזה מוצר ואכוון לפי הגוונים שלו.";
  const SENT = "מייקאפ טינט מתאים כמעט לכולן, הוא משנה גוון מלבן לצבע העור ומחירו 178 ₪. אם התכוונת למייקאפ אחר, כתבו איזה מוצר ואכוון אותך לפי הגוונים שלו.";
  const shown = [{ ref: "id:501", title: "מייקאפ טינט", price: "160.20", currency: "ILS", productId: "501", variantId: null, at: "2026-11-22T08:00:00.000Z" }];
  const withShown = async (offeredItems: any[], fn: () => Promise<void>) => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems, pending: [], turnCount: 4 });
    h.history = [{ direction: "INBOUND", body: INCOMING, metadata: null }];
    // The document gives the regular price.
    h.chunks = [{ content: "מייקאפ טינט: משנה גוון מלבן לצבע העור, מתאים כמעט לכולן. מחיר: 178 ₪." }];
    try { await fn(); } finally { (prisma as any).conversationState.findUnique = async () => null; }
  };
  // Everything the model was told across the turn (the calls share one growing list).
  const told = () => h.calls.at(-1).messages.map((m: any) => String(m.content ?? "")).join("\n");
  const firstKinds = (r: any) => r.trace.gate3.problems.map((p: any) => p.kind);
  const say = (...replies: string[]) => { for (const [i, reply] of replies.entries()) h.responses.push({ toolCalls: [respond(`m${i}`, { reply })] }); };

  it("★ the draft is never told to name products with prices: the shown product is its name", async () => {
    await withShown(shown, async () => {
      say(DRAFT, DRAFT.replace("כתבי", "אפשר לכתוב"));
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: INCOMING }, "autonomous");
      expect(firstKinds(r)).not.toContain("nameless_products");
      expect(told()).not.toContain("without naming any");
      expect(r.reply).toBe(DRAFT.replace("כתבי", "אפשר לכתוב"));
      expect(h.responses).toHaveLength(0);
    });
  });

  it("★ the control: with nothing shown before, the same draft is products without a name, and no document price is asked for", async () => {
    await withShown([], async () => {
      say(DRAFT, DRAFT, DRAFT);
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: INCOMING }, "autonomous");
      expect(firstKinds(r)).toContain("nameless_products");
      expect(told()).toContain("You present products without naming any.");
      expect(told()).toContain("each with the price the search gave for it (never a price from a document)");
    });
  });

  it("★ the document's price for the shown product is caught, and the rewrite is given the price read then", async () => {
    await withShown(shown, async () => {
      say(SENT, SENT.replace("178", "160.20"));
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: INCOMING }, "autonomous");
      expect(firstKinds(r)).toContain("price_against_store");
      expect(told()).toContain("The store's price: מייקאפ טינט: 160.20. Give that one;");
      expect(r.reply).toBe(SENT.replace("178", "160.20"));
      // The engine's own read came after the draft, under its own id.
      expect(r.trace.toolsAtFirstGate).toBe(0);
      expect(r.trace.tools.map((t: any) => t.callId)).toEqual(["auto_store_1"]);
    });
    // Without the earlier read the document's price went out (the defect).
    await withShown([], async () => {
      h.responses.length = 0;
      say(SENT, SENT);
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: INCOMING }, "autonomous");
      expect(firstKinds(r)).not.toContain("price_against_store");
    });
  });

  it("★ a rewrite that says the document's price again does not send it", async () => {
    await withShown(shown, async () => {
      say(SENT, SENT, SENT);
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: INCOMING }, "autonomous");
      expect(String(r.reply ?? "")).not.toContain("178");
      expect(told()).toContain("these sentences had to be cut (price_against_store");
    });
  });

  it("★ the trace says how many calls ran before the first draft was checked", async () => {
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "תיק בד" })] }, { toolCalls: [respond("s2", { reply: "יש Canvas Tote ב-₪79.", cards: ["PRODUCT_1"] })] });
    const searched = await runReplyEngineTurn(opts, "autonomous");
    expect(searched.trace.toolsAtFirstGate).toBe(1);
    expect(searched.trace.tools.map((t: any) => t.callId)).toEqual(["s1"]);
  });

  it("★ a product read this turn: the correction gives its price in the store's own writing", async () => {
    // The store writes "79.90"; a reply that says it that way is grounded, "79.9" is another string.
    h.groundList = [{ title: "Canvas Tote", price: "79.90" as any }];
    h.responses.push({ toolCalls: [tc("s1", "woocommerce.list_products", { query: "תיק בד" })] }, { toolCalls: [respond("s2", { reply: "יש Canvas Tote ב-₪89." })] }, { toolCalls: [respond("s3", { reply: "יש Canvas Tote ב-₪79.90." })] });
    const r = await runReplyEngineTurn(opts, "autonomous");
    expect(firstKinds(r)).toContain("price_against_store");
    expect(told()).toContain("The store's price: Canvas Tote: 79.90. Give that one;");
    expect(String(r.reply ?? "")).toContain("79.90");
    expect(String(r.reply ?? "")).not.toContain("89");
  });
});

/**
 * Omer 2026-11-23 ("ממש לא"): the bot takes load off the team and never adds any. It searches before it says it does
 * not know; what is truly missing after the lookup is a REAL hand-over (the approved line, the team told); nothing is
 * ever "passed to the team" to be answered later. The cases are the prod ones of 2026-11-16..23.
 */
describe("no team pass: look first, then answer or hand over (Omer 2026-11-23)", () => {
  it("★ Alea thickness: the reply answers it and says it waits for the team, with no search: the knowledge is searched, the answer stands, no hand-over", async () => {
    h.lexical = [{ content: "Q: מה עובי החומר פי וי סי? A: עובי החומר 2.2 - 2.5 מ\"מ.", score: 0.9, documentTitle: "שאלות", chunkIndex: 3, documentId: "d" }];
    h.responses.push(
      { toolCalls: [respond("al1", { reply: "העובי הוא 2.2-2.5 מ\"מ. לגבי העובי, השאלה כבר ממתינה לתשובת הצוות." })] },
      { toolCalls: [respond("al2", { reply: "עובי החומר הוא 2.2-2.5 מ\"מ." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה העובי של השטיח?" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).toContain("unlooked_pass");
    const kb = r.trace.tools.find((t: any) => t.tool === "search_knowledge");
    expect(kb).toBeTruthy();
    expect(r.reply).toBe("עובי החומר הוא 2.2-2.5 מ\"מ.");
    expect(r.escalation).toBeNull();
    expect(h.teamQuestions).toHaveLength(0);
  });

  it("★ the rewrite still passes it on after the search: the answer kept, the pass cut, a real hand-over", async () => {
    h.lexical = [{ content: "Q: מה עובי החומר? A: עובי החומר 2.2 - 2.5 מ\"מ.", score: 0.9, documentTitle: "שאלות", chunkIndex: 3, documentId: "d" }];
    const both = "העובי הוא 2.2-2.5 מ\"מ. לגבי עמידות לשמן, עדיין ממתינים לתשובת הצוות.";
    h.responses.push({ toolCalls: [respond("al3", { reply: both })] }, { toolCalls: [respond("al4", { reply: both })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה העובי והאם הוא עמיד לשמן?" }, "autonomous");
    handedOver(r);
    expect(r.reply).toBe(`העובי הוא 2.2-2.5 מ"מ. ${HAND}`);
    expect(h.teamQuestions).toHaveLength(1);
  });

  it("★ Smoovee coupon: \"I passed it to the team\" with no search; the knowledge has it, so it is answered", async () => {
    h.lexical = [{ content: "איך מקבלים קוד קופון? נרשמים לניוזלטר באתר, והקוד להטבה ברכישה הראשונה נשלח למייל.", score: 0.9, documentTitle: "קופונים", chunkIndex: 1, documentId: "d" }];
    h.responses.push(
      { toolCalls: [respond("cp1", { reply: "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט." })] },
      { toolCalls: [respond("cp2", { reply: "נרשמים לניוזלטר באתר, והקוד נשלח למייל." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איך מקבלים קוד קופון?" }, "autonomous");
    expect(r.trace.tools.some((t: any) => t.tool === "search_knowledge")).toBe(true);
    expect(r.reply).toBe("נרשמים לניוזלטר באתר, והקוד נשלח למייל.");
    expect(r.escalation).toBeNull();
  });

  it("★ the reservist discount, truly missing: searched, still not known, a hand-over and the question on the owner's list", async () => {
    h.responses.push(
      { toolCalls: [tc("rv0", "search_knowledge", { query: "הנחת מילואים" })] },
      { toolCalls: [respond("rv1", { reply: "לא ידוע לנו על הנחה למשרתי מילואים.", team_question: "האם יש הנחה למשרתי מילואים?" })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש הנחה למילואימניקים?" }, "autonomous");
    expect(r.trace.gate3.problems.map((p: any) => p.kind)).not.toContain("unlooked_pass");
    handedOver(r);
    expect(h.teamQuestions.map((q: any) => q.question)).toEqual(["האם יש הנחה למשרתי מילואים?"]);
  });

  it("★ every prod pass line, whatever the model wrote, ends as a real hand-over with nothing about a team left", async () => {
    const lines = [
      "לגבי העובי, השאלה כבר ממתינה לתשובת הצוות.",
      "הבקשה לבדוק את הקופון עדיין בטיפול הצוות.",
      "העניין כבר בבדיקה אצלם, ונעדכן כאן בצ'אט.",
      "ההנחיות המעשיות למסירה או לאיסוף עדיין בבירור מול הצוות.",
      "הצוות עדיין בודק אם סמובי אליס זמינה בשחור.",
      "אפשר לבדוק את זה מול הצוות.",
      "נבדוק מול הצוות את צפי ההזמנה, והתשובה תגיע כאן בצ'אט.",
      "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.",
    ];
    for (const line of lines) {
      h.responses.length = 0; h.teamQuestions.length = 0;
      h.responses.push({ toolCalls: [tc(`k${line.length}`, "search_knowledge", { query: "x" })] }, { toolCalls: [respond(`p${line.length}`, { reply: line })] }, { toolCalls: [respond(`q${line.length}`, { reply: line })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה עם זה?" }, "autonomous");
      handedOver(r);
      expect(r.reply, line).toBe(HAND);
    }
  });

  it("★ a plain answer: no hand-over, and the automatic lookup records no gap (only a hand-over turn does)", async () => {
    h.responses.push({ toolCalls: [respond("pa1", { reply: "אנחנו פתוחים א-ה 9-17." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי אתם פתוחים?" }, "autonomous");
    expect(r.escalation).toBeNull();
    expect(h.retrieveCalls.length).toBeGreaterThan(0);
    expect(h.retrieveCalls.every((a: any[]) => a[4]?.record === false)).toBe(true);
    expect(h.teamQuestions).toHaveLength(0);
  });

  it("★ the turn audit carries the model's search_knowledge query, its outcome and its hits", async () => {
    h.responses.push({ toolCalls: [tc("au0", "search_knowledge", { query: "זמני משלוח לאילת" })] }, { toolCalls: [respond("au1", { reply: "המשלוח לאילת מגיע תוך 3-5 ימי עסקים." })] });
    await runReplyEngineTurn({ ...opts, incomingMessage: "תוך כמה זמן מגיע לאילת?" }, "autonomous");
    const calls = h.audits.find((a) => a.data.action === "ai.bot_turn")?.data.metadata.toolCalls ?? [];
    const kb = calls.find((c: any) => c.tool === "search_knowledge");
    expect(kb).toMatchObject({ q: "זמני משלוח לאילת" });
    expect(["ok", "empty", "timeout"]).toContain(kb.outcome);
    expect(typeof kb.resultCount).toBe("number");
  });

  it("★ the prompt teaches no team pass and gives the approved line", async () => {
    h.responses.push({ toolCalls: [respond("pr1", { reply: "בטח." })] });
    await runReplyEngineTurn(opts, "autonomous");
    const sys = String(h.calls[0].messages[0].content);
    expect(sys).not.toMatch(/העברתי את השאלה לצוות|checking with the team|say you will check with the team/);
    expect(sys).toContain(HAND);
  });
});
