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
  textChannel: false,
  offerWrite: false,
  lexicalFor: null as null | ((q: string) => any[]),
  policy: {} as Record<string, string>,
  teamQuestions: [] as any[],
  historyQueries: [] as any[],
  failReads: 0,
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
      ...(h.offerWrite ? [{ type: "function", function: { name: "woocommerce.add_order_note", description: "note", parameters: { type: "object", properties: {} } } }] : []),
    ],
    evaluatePolicies: async ({ toolName }: any) => ({ decision: h.policy[toolName] ?? "ALLOW", reason: "test" }),
    dispatchToolCall: async (tc: any, ctx: any) => {
      h.dispatched.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments), sandbox: ctx.sandbox ?? null });
      if (tc.function.name === "woocommerce.list_products" && h.slowReads > 0) { h.slowReads--; await new Promise((r) => setTimeout(r, 900)); }
      if (tc.function.name === "woocommerce.get_order" && h.slowOrders > 0) { h.slowOrders--; await new Promise((r) => setTimeout(r, h.orderDelay)); }
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
    candidates: [{ title, productId: "101", price: 79, currency: "ILS", inventoryState: "in_stock", url: h.groundUrl, attributes: h.groundCategory ? { category: h.groundCategory } : {}, unknownAttributes: [] }, ...(h.extraTitle ? [{ title: h.extraTitle, productId: "102", price: 89, currency: "ILS", inventoryState: "in_stock", url: "u2", attributes: {}, unknownAttributes: [] }] : [])],
    appliedFilters: [], unavailableFilters: [], safeModelSummary: title,
  }))(h.groundSeq.length ? h.groundSeq.shift()! : h.groundTitle),
}));
vi.mock("../services/knowledge.service", () => ({
  retrieveRelevantChunks: async () => [], buildKnowledgeContext: (c: any[]) => c.map((x) => x.content).join("\n"), shouldRecordKnowledgeGap: () => false,
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

beforeEach(() => {
  for (const k of ["responses", "calls", "scopeSeen", "dispatched", "submitted", "upserts", "audits", "staged", "teamQuestions", "historyQueries"] as const) (h as any)[k].length = 0;
  h.failReads = 0;
  h.slowReads = 0;
  h.slowOrders = 0;
  h.orderDelay = 900;
  h.textChannel = false;
  h.offerWrite = false;
  h.lexicalFor = null;
  h.history = null;
  h.lexical = [];
  h.groundTitle = "Canvas Tote";
  h.groundSeq = [];
  h.groundUrl = "u";
  h.groundCategory = "";
  h.extraTitle = "";
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

  it("★ the canned line goes out once: it is marked in the state (hidden from the model)", async () => {
    h.responses.push(
      { toolCalls: [respond("c1", { reply: "אפשר לשלם בתשלומים, ₪120 לחודש." })] },
      { toolCalls: [respond("c2", { reply: "בטח, ₪150 בלבד לחודש." })] },
    );
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אפשר לשלם בתשלומים?" }, "autonomous");
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
      // Not a product ask and not a question: silence is allowed (a question gets a holding line, below).
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "טוב" }, "autonomous");
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
    // A question is never met with silence: the team line once (2c57725b rating).
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "נו?" }, "autonomous");
    expect(r.trace.gate3.rewrite).not.toBe("silent");
    expect(r.reply).toBe("העברתי את השאלה לצוות, והתשובה תגיע כאן בצ'אט.");
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

  it("★ holding mode: the customer's digits go to the open payment item; the reply says nothing of the charge", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const { HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 3 });
    try {
      h.responses.push({ toolCalls: [respond("hm1", { reply: "תודה! ייתכן שאישור הויזה זמני ואינו חיוב סופי, והבדיקה מול ספק התשלום בתהליך." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "4 ספרות אחרונות 4155" }, "autonomous");
      expect(r.reply).toMatch(new RegExp(`^${HOLD_ACK_HE}`));
      expect(r.reply).toMatch(/בבדיקה אצל הצוות/);
      expect(r.reply).not.toMatch(/ויזה|ספק התשלום|זמני/);
      const up = h.upserts[h.upserts.length - 1];
      const saved: any[] = up?.create?.pending ?? up?.update?.pending ?? [];
      expect(saved.find((p: any) => /חויבתי פעמיים/.test(p.text))?.text).toMatch(/4155/);
      // One item: no second one opened for the digits.
      expect(saved.filter((p: any) => p.kind === "promise")).toHaveLength(1);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ an unasked first name is dropped from the reply", async () => {
    h.responses.push({ toolCalls: [respond("nm1", { reply: "היי אלה, אנחנו פתוחים א-ה 9-17." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי אתם פתוחים?" }, "autonomous");
    expect(r.reply).not.toMatch(/אלה/);
    expect(r.reply).toMatch(/9-17/);
  });

  it("★ holding mode: a team question the model raises on the held subject goes into the open item", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 3 });
    try {
      h.responses.push({ toolCalls: [respond("hm3", { reply: "קיבלתי את הספרות.", team_question: "4 ספרות אחרונות של הכרטיס 4155" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "4 ספרות אחרונות 4155" }, "autonomous");
      const up = h.upserts[h.upserts.length - 1];
      const saved: any[] = up?.create?.pending ?? up?.update?.pending ?? [];
      expect(saved.filter((p: any) => p.kind === "promise")).toHaveLength(1);
      expect(saved[0].text).toMatch(/4155/);
      expect(r.trace.teamQuestion ?? null).toBeNull();
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

  it("★ a question after the canned line: a new question goes to the team; its repeat gets the holding line once, then silence", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const { stillCheckingLine } = await import("../services/reply-engine/engine");
    const q = "איפה מזינים את הקופון?";
    const st = (pending: any[]) => { (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString() }, offeredItems: [], pending, turnCount: 3 }); };
    try {
      st([]);
      h.responses.push({ toolCalls: [respond("h1", { reply: "התיק עולה ₪120." })] }, { toolCalls: [respond("h2", { reply: "בטח, ₪150 בלבד." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: q }, "autonomous");
      expect(r.reply).toBe("העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.");
      expect(r.trace.teamQuestion).toBeTruthy();
      const item = [{ kind: "promise", text: `checking with the team: ${q}`, at: new Date().toISOString() }];
      st(item);
      const holding = stillCheckingLine(q, "he");
      h.responses.push({ toolCalls: [respond("h3", { reply: "התיק עולה ₪120." })] }, { toolCalls: [respond("h4", { reply: "בטח, ₪150 בלבד." })] });
      const r2 = await runReplyEngineTurn({ ...opts, incomingMessage: q }, "autonomous");
      expect(r2.reply).toBe(holding);
      h.history = [{ direction: "INBOUND", body: q, metadata: null }, { direction: "OUTBOUND", body: holding, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("h5", { reply: "התיק עולה ₪120." })] }, { toolCalls: [respond("h6", { reply: "בטח, ₪150 בלבד." })] });
      const r3 = await runReplyEngineTurn({ ...opts, incomingMessage: q }, "autonomous");
      expect(r3.reply ?? null).toBeNull();
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

  it("★ holding mode: a thanks gets a short welcome once, then nothing; the holding line at most every third turn", async () => {
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
      expect(r2.reply ?? null).toBeNull();
      // A status ask right after a holding line: not the line again.
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: holding, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("t3", { reply: "החיוב עדיין בבדיקה." })] });
      const r3 = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
      expect(r3.reply ?? "").not.toMatch(/בבדיקה אצל הצוות/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ a failed payment method: the guesses are cut, the question goes to the team with the fixed line", async () => {
    h.responses.push({ toolCalls: [respond("p1", { reply: "האם גם אחד מהם נכשל? ייתכן שהתשלום לא עבר בגלל תקלה." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "ניסיתי לשלם בביימי וזה נכשל" }, "autonomous");
    expect(r.reply).toMatch(/העברתי את זה לצוות/);
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
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "ומה עם משלוח לאילת?" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect((r.trace as any).newSubjectToTeam).toBe(true);
    expect(h.teamQuestions.map((q) => q.question)).toEqual(["ומה עם משלוח לאילת?"]);
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
    // A new request is passed to the team now and says so; "still being checked" is only for an open item.
    expect(r.reply ?? "").toMatch(/העברתי לצוות את הבקשה לשיחה/);
    expect(r.reply ?? "").not.toMatch(/עדיין בבדיקה אצל הצוות/);
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
  it("★ back on an open team subject: the reply says it is with the team", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: הגוון של קרם הלחות", at: new Date().toISOString() }], turnCount: 4 });
    h.responses.push({ toolCalls: [respond("o1", { reply: "אשמח לעזור עוד." })] });
    let r: any;
    try { r = await runReplyEngineTurn({ ...opts, incomingMessage: "מה עם הגוון של קרם הלחות?" }, "autonomous"); }
    finally { (prisma as any).conversationState.findUnique = async () => null; }
    expect(r.reply).toMatch(/בבדיקה אצל הצוות/);
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
  it("★ a team question recorded this turn is told to the customer", async () => {
    h.responses.push({ toolCalls: [respond("q1", { reply: "מבינים.", team_question: "חיוב כפול בביימי" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "חויבתי פעמיים בביימי" }, "autonomous");
    // A fixed line: the team question's own text is never quoted to the customer.
    expect(r.reply).toMatch(/העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט\./);
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
      expect(r.reply).toMatch(new RegExp(HOLD_ADVICE_HE.slice(0, 20)));
      expect(r.reply).not.toMatch(/לא אמורה להיות כפילות/);
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
      expect(r.reply).toMatch(new RegExp(HOLD_ADVICE_HE.slice(0, 20)));
    });
  });
  it("★ the holding line at most every third turn, counted in the state (a replay's history is another engine's)", async () => {
    await withHeld({ _holdLineTurn: "9" }, async () => {
      h.responses.push({ toolCalls: [respond("q2", { reply: "החיוב עדיין בבדיקה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/בבדיקה אצל הצוות/);
    });
    await withHeld({ _holdLineTurn: "6" }, async () => {
      h.responses.push({ toolCalls: [respond("q3", { reply: "החיוב עדיין בבדיקה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
      // The line was the last message sent (nothing since turn 6): the second fixed line, never the same one
      // (C pinned rating c24439a1).
      expect(r.reply ?? "").toMatch(/אני כאן, ותשובת הצוות תגיע כאן בצ'אט/);
      const up = h.upserts[h.upserts.length - 1];
      expect((up?.create ?? up?.update)?.facts?._spokeTurn).toBe("10");
    });
  });
  it("★ 'I've added it to the check' only when something new was added", async () => {
    const { HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    await withHeld({}, async () => {
      h.responses.push({ toolCalls: [respond("q4", { reply: "קיבלתי." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כבר שלחתי לכם 4155" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(new RegExp(HOLD_ACK_HE.slice(0, 12)));
    }, " (customer gave: 4155)");
  });
  it("★ the thanks once, counted in the state too", async () => {
    await withHeld({ _thanksTurn: "9" }, async () => {
      h.responses.push({ toolCalls: [respond("q6", { reply: "בשמחה!" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה" }, "autonomous");
      expect(r.reply ?? null).toBeNull();
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
  it("★ the thanks once per hold", async () => {
    await withHeld({ _thanksTurn: "5" }, async () => {
      h.responses.push({ toolCalls: [respond("d1", { reply: "בשמחה!" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "שיהיה תודה" }, "autonomous");
      expect(r.reply ?? null).toBeNull();
    });
  });
  it("★ a restatement after a silent turn gets a holding line (the second one after the first); right after one, nothing", async () => {
    await withHeld({ _holdLineTurn: "8", _spokeTurn: "8" }, async () => {
      h.responses.push({ toolCalls: [respond("d2", { reply: "לא נוצרה הזמנה, נכון." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא יצאה הזמנה" }, "autonomous");
      // The line at 8, silent at 9: the second line at 10, never the same one twice in a row (C pinned rating).
      expect(r.reply ?? "").toMatch(/אני כאן, ותשובת הצוות תגיע כאן בצ'אט/);
      const up = h.upserts[h.upserts.length - 1];
      expect((up?.create ?? up?.update)?.facts?._spokeTurn).toBe("10");
    });
    await withHeld({ _holdLineTurn: "9", _spokeTurn: "9" }, async () => {
      h.responses.push({ toolCalls: [respond("d3", { reply: "לא נוצרה הזמנה, נכון." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא יצאה הזמנה" }, "autonomous");
      expect(r.reply ?? null).toBeNull();
    });
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
  it("★ holding mode: a size sentence does not hang on the holding line", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.responses.push({ toolCalls: [respond("hz1", { reply: "אגב, יש לנו גם תיקי בד חדשים בקולקציה. החיוב עדיין בבדיקה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/תיקי בד/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
});

describe("657e5f85 rating: engine passes", () => {
  it("★ the turn a charge complaint opens: no state or cause, the team has it", async () => {
    h.responses.push({ toolCalls: [respond("op1", { reply: "ההזמנה 97858 בוטלה כי התשלום לא נקלט במערכת." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "חויבתי פעמיים ואין לי הזמנה" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/בוטלה|לא נקלט/);
    expect(r.reply ?? "").toMatch(/צוות/);
    expect(r.trace.teamQuestion).toBeTruthy();
  });
  it("★ holding mode's floor: a direct ask is never left without a reply", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _holdLineTurn: "7", _spokeTurn: "7" }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.responses.push({ toolCalls: [respond("fl1", { reply: "ההזמנה בוטלה כי התשלום לא נקלט." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תעדכנו בבקשה ושלחו לי מספר הזמנה" }, "autonomous");
      // Never left without a reply; the line was the last sent, so the second line (C pinned rating).
      expect(r.reply ?? "").toMatch(/אני כאן, ותשובת הצוות תגיע כאן בצ'אט/);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });
  it("★ holding mode's floor after the gate went silent: the bot quiet 2+ turns gets the holding line", async () => {
    const { prisma } = await import("@chatcenter/shared");
    const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString(), _spokeTurn: "7" }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }, { direction: "INBOUND", body: "נו", metadata: null }];
      h.responses.push({ toolCalls: [respond("fs1", { reply: para })] }, { toolCalls: [respond("fs2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא יצאה הזמנה" }, "autonomous");
      expect(r.reply ?? "").toMatch(/בבדיקה אצל הצוות/);
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
    expect(r.reply).toMatch(/שאר הפריטים/);
    expect(String(r.trace.teamQuestion ?? "")).toMatch(/טוסטר/);
  });
  it("★ a restock ask with no data: the team, never 'check the product page'", async () => {
    h.responses.push({ toolCalls: [respond("rs1", { reply: "בדקי בדף המוצר, שם מופיע המלאי." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי יתחדש המלאי של אליס שחור?" }, "autonomous");
    expect(r.reply).not.toMatch(/בדף המוצר/);
    expect(r.reply).toMatch(/העברתי את (?:זה|השאלה) לצוות/);
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
  it("★ a restock ask the gate lets through still goes to the team", async () => {
    h.responses.push({ toolCalls: [respond("rs2", { reply: "המלאי מתעדכן מדי פעם." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי יחזור למלאי האליס השחור?" }, "autonomous");
    expect(r.reply).toMatch(/העברתי את זה לצוות/);
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
  it("★ an imperative ask after a silent gate gets the holding line", async () => {
    await withHeld({ _holdLineTurn: "7", _spokeTurn: "9", _cannedTeamLineAt: new Date().toISOString() }, async () => {
      const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("im1", { reply: para })] }, { toolCalls: [respond("im2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תעדכנו בבקשה ושלחו לי מספר הזמנה" }, "autonomous");
      expect(r.reply ?? "").toMatch(/בבדיקה אצל הצוות/);
    });
  });
  it("★ a thanks after a silent gate in a hold gets the welcome once", async () => {
    await withHeld({ _cannedTeamLineAt: new Date().toISOString(), _spokeTurn: "9" }, async () => {
      const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }];
      h.responses.push({ toolCalls: [respond("th1", { reply: para })] }, { toolCalls: [respond("th2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "תודה" }, "autonomous");
      expect(r.reply).toBe("בשמחה!");
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
  it("★ a how-to or safety question answered 'no information': the team in the same turn, the question may follow", async () => {
    // No safety word: the how-to rule itself.
    h.responses.push({ toolCalls: [respond("hs1", { reply: "אין לי כאן הנחיה למיקום המעצורים. מה הדגם?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה שמים את המעצורים?" }, "autonomous");
    expect(r.reply).toMatch(/מה הדגם/);
    expect(r.reply).toMatch(/העברתי את זה לצוות/);
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
  it("★ a return request: the team now, the failure narration and the re-asked reason cut", async () => {
    h.lexical = [{ content: "מדיניות החזרות: אפשר להחזיר תוך 14 יום מקבלת המוצר.", score: 0.9, documentTitle: "returns", chunkIndex: 1, documentId: "d" }];
    h.responses.push({ toolCalls: [respond("rt1", { reply: "כרגע לא הצלחתי לבדוק את פרטי העסקה. מה סיבת ההחזרה? אפשר להחזיר תוך 14 יום." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אני רוצה להחזיר את הזמנה 97837 כי זה לא מתאים" }, "autonomous");
    expect(r.reply).not.toMatch(/לא הצלחתי/);
    expect(r.reply).not.toMatch(/סיבת ההחזרה/);
    expect(r.reply).toMatch(/14 יום/);
    expect(r.reply).toMatch(/העברתי את הבקשה לצוות/);
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
  it("★ one retry on a timeout; still nothing: a team item naming the order, the fixed line, no 'could not check'", async () => {
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
    expect(r.reply).toMatch(/העברתי את זה לצוות/);
    // The model is told the team gets it, never "say you could not check it".
    expect(JSON.stringify(h.calls.at(-1)?.messages ?? [])).toMatch(/the team gets this order now/);
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
  it("★ a held return and 'how do I return it?': the steps from the policy and the team's part, never silence", async () => {
    h.lexical = [{ content: "מדיניות החזרות: אפשר להחזיר תוך 14 יום באריזה המקורית, דמי משלוח 25 ש\"ח.", score: 0.9, documentTitle: "returns", chunkIndex: 1, documentId: "d" }];
    await withState(held("החזר כספי על המשטח, לא מתאים למיקסר"), async () => {
      h.responses.push({ toolCalls: [respond("rh1", { reply: "ההחזרה בבדיקה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אוקיי. מה לעשות? איך להחזיר את המוצר ולהזדכות על המחיר?" }, "autonomous");
      expect(r.reply ?? "").toMatch(/14 יום/);
      expect(r.reply ?? "").toMatch(/את פרטי הזיכוי הצוות יאשר כאן/);
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
  it("★ 5: the hold line was the last message SENT (a silent turn since): the second line, never the same one", async () => {
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
      expect(r.reply ?? "").toContain(HOLD_LINE_ALT.he);
    });
  });
});

describe("C pinned rating c24439a1: the holding floor", () => {
  it("★ 5b: the floor after the gate went silent: the second line when the line was the last message sent", async () => {
    const { HOLD_LINE_ALT } = await import("../services/reply-engine/engine");
    const { prisma } = await import("@chatcenter/shared");
    const para = "כדי לבדוק את החיוב צריך את ארבע הספרות האחרונות של הכרטיס ששימש לתשלום.";
    // The line went out at 7 and nothing since (the state); the history's last bot message is another engine's.
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: { _cannedTeamLineAt: new Date().toISOString(), _holdLineTurn: "7", _spokeTurn: "7" }, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: חויבתי פעמיים ואין הזמנה", at: new Date().toISOString() }], turnCount: 10 });
    try {
      h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: para, senderName: "AI Bot", metadata: null }, { direction: "INBOUND", body: "נו", metadata: null }];
      h.responses.push({ toolCalls: [respond("fa1", { reply: para })] }, { toolCalls: [respond("fa2", { reply: para })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "לא יצאה הזמנה" }, "autonomous");
      expect(r.reply ?? "").toContain(HOLD_LINE_ALT.he);
      expect(r.reply ?? "").not.toMatch(/בבדיקה אצל הצוות/);
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
    expect(r.reply ?? "").toMatch(/לצוות|https?:\/\//);
  });
  it("★ 2b: a short clarifying question the model wrote with no gate cut is sent as it is", async () => {
    // An explanation ask, so only "no cut this turn" keeps the model's question.
    h.responses.push({ toolCalls: [respond("cq1", { reply: "לאיזה מכשיר?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איך בוחרים איזה משטח מתאים לי?" }, "autonomous");
    // No sentence cut this turn (a no_search verdict may "clean" and remove nothing): sent as the model wrote it.
    expect(Number((r.trace as any).cutSentences ?? 0)).toBe(0);
    expect((r.reply ?? "").trim()).toBe("לאיזה מכשיר?");
  });
  it("★ 4: the team pass once in a reply", async () => {
    h.responses.push({ toolCalls: [respond("tp1", { reply: "אפשר להעביר את זה לצוות, והתשובה תגיע כאן בצ'אט. העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.", team_question: "משלוח לאילת" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש משלוח לאילת?" }, "autonomous");
    expect((r.reply ?? "").match(/לצוות/g) ?? []).toHaveLength(1);
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

  it("★ 3: \"כן מעדיפה להיות שקטה\" in a hold is peace of mind: the fixed noted line, the note on the item, never \"we'll keep quiet\"", async () => {
    const { HOLD_SETTLED_HE, SETTLED_NOTE } = await import("../services/reply-engine/gates");
    await withState(held, async () => {
      h.responses.push({ toolCalls: [respond("e1", { reply: "בסדר גמור, נשאיר את זה בשקט ולא נשלח הודעות נוספות." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן מעדיפה להיות שקטה" }, "autonomous");
      expect(r.reply).toContain(HOLD_SETTLED_HE);
      expect(r.reply).not.toMatch(/בשקט|לא נשלח/);
      const item = savedPending().find((p: any) => /חויבתי פעמיים/.test(p.text));
      expect(item.text).toContain(SETTLED_NOTE);
      expect(savedPending().filter((p: any) => p.kind === "promise")).toHaveLength(1);
    });
  });

  it("★ 3: a yes to the bot's own urgency question in a hold: the same noted line", async () => {
    const { HOLD_SETTLED_HE } = await import("../services/reply-engine/gates");
    h.history = [{ direction: "INBOUND", body: "חויבתי פעמיים", metadata: null }, { direction: "OUTBOUND", body: "החיוב בבדיקה אצל הצוות. זה דחוף עבורך?", senderName: "AI Bot", metadata: null }];
    await withState(held, async () => {
      h.responses.push({ toolCalls: [respond("e2", { reply: "בסדר." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "כן" }, "autonomous");
      expect(r.reply).toContain(HOLD_SETTLED_HE);
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

  it("★ 4: a photo in a hold: the acknowledgement, and the item records it", async () => {
    const { HOLD_ACK_HE } = await import("../services/reply-engine/gates");
    await withState(held, async () => {
      h.responses.push({ toolCalls: [respond("e5", { reply: "קיבלתי את התמונה." })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "[image]" }, "autonomous");
      expect(r.reply).toMatch(new RegExp(`^${HOLD_ACK_HE}`));
      expect(savedPending().find((p: any) => /חויבתי פעמיים/.test(p.text)).text).toContain("customer sent 1 attachment");
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

  it("★ (rating 9480dfb2, near-blocker 6) a waiting claim with no hand-over is cut; nothing left, the team line", async () => {
    h.responses.push({ toolCalls: [respond("wt1", { reply: "נציגינו עסוקים בפניות קודמות ויתפנו בהקדם." })] }, { toolCalls: [respond("wt2", { reply: "נציגינו עסוקים בפניות קודמות ויתפנו בהקדם." })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש חדש?" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/עסוקים|יתפנו/);
    expect(r.escalation).toBeNull();
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
    expect(r.reply ?? "").toMatch(/צוות/);
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

  it("★ (dev live round on b369e939, 1) a video ask shaped like a product ask gets the team line, never the product question", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", stage: "choosing", intent: "Zip Hoodie", facts: {}, offeredItems: [{ ref: "id:9", title: "Zip Hoodie", productId: "9", at: new Date().toISOString() }], pending: [], turnCount: 3 });
    try {
      const no = "אין לנו מידע על סרטון הדרכה לכביסה.";
      h.responses.push({ toolCalls: [respond("vd1", { reply: no })] }, { toolCalls: [respond("vd2", { reply: no })] }, { toolCalls: [respond("vd3", { reply: no })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "יש לכם סרטון הדרכה לכביסה?" }, "autonomous");
      expect(r.reply ?? "").not.toMatch(/לאיזה דגם|באיזו מידה/);
      expect(r.reply ?? "").toMatch(/צוות|https?:\/\//);
    } finally { (prisma as any).conversationState.findUnique = async () => null; }
  });

  it("★ (dev live round on b369e939, 2) a video ask whose answer was cut gets the team line and a team question", async () => {
    const reply = "אין לנו כרגע סרטון הדרכה לכביסה. כדאי לפעול לפי תווית הטיפול שעל הקפוצ'ון, כי הוראות הכביסה תלויות בה.";
    h.responses.push({ toolCalls: [respond("vc1", { reply })] }, { toolCalls: [respond("vc2", { reply })] }, { toolCalls: [respond("vc3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה איך מכבסים אותו" }, "autonomous");
    if (Number((r.trace as any).cutSentences ?? 0) > 0 || r.trace.gate3.rewrite === "fallback") {
      expect(r.reply ?? "").toMatch(/צוות/);
      expect(r.trace.teamQuestion ?? null).not.toBeNull();
      // The grounded rest stays in front of the team line (rating b369e939: NE'A's usage tip was lost).
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

  it("★ (48f3a261 verify, 7) a second video ask while one is open joins it: the holding line, no second team question", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma as any).conversationState.findUnique = async () => ({ tenantId: "t1", facts: {}, offeredItems: [], pending: [{ kind: "promise", text: "checking with the team: האם יש סרטון הדרכה לטוש הגבות", at: new Date().toISOString() }], turnCount: 4 });
    try {
      const pass = "העברתי את זה לצוות, והתשובה תגיע כאן בצ'אט.";
      h.responses.push({ toolCalls: [respond("j1", { reply: pass, team_question: "איפה הסרטון" })] }, { toolCalls: [respond("j2", { reply: pass, team_question: "איפה הסרטון" })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "איפה הסרטון" }, "autonomous");
      expect(h.teamQuestions).toHaveLength(0);
      expect(r.reply ?? "").not.toBe(pass);
      expect((r.trace as any).teamItemJoined).toBe(true);
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
  it("★ B1b: a direct video ask after the team pass is never silent: the still-checking line", async () => {
    await withState({ facts: { _cannedTeamLineAt: new Date().toISOString() }, pending: [{ kind: "promise", text: "checking with the team: האם יש סרטון הדרכה לטוש הגבות", at: new Date().toISOString() }] }, async () => {
      const no = "אין לנו סרטון הדרכה לטוש.";
      h.responses.push({ toolCalls: [respond("s1", { reply: no })] }, { toolCalls: [respond("s2", { reply: no })] }, { toolCalls: [respond("s3", { reply: no })] });
      const r = await runReplyEngineTurn({ ...opts, incomingMessage: "אשמח לסרטון הדרכה" }, "autonomous");
      expect((r.reply ?? "").trim()).not.toBe("");
      // The still-checking line for the open item, never a fresh "passed to the team".
      expect(r.reply).toMatch(/עדיין בבדיקה/);
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
  it("★ B1d: a request for the sizes she just gave is never left after a cut", async () => {
    h.groundTitle = "סמובי גפן 40x50";
    const reply = "למיקסר מתאים סמובי גפן 40x50. הוא עולה ₪999. אפשר לשלוח את רוחב ועומק הבסיס של כל אחד מהם?";
    h.responses.push({ toolCalls: [tc("z0", "woocommerce.list_products", { query: "משטח" })] }, { toolCalls: [respond("z1", { reply })] }, { toolCalls: [respond("z2", { reply })] }, { toolCalls: [respond("z3", { reply })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "משטח למיקסר 35x45 וטוסטר 25x35" }, "autonomous");
    expect(r.reply ?? "").not.toMatch(/רוחב ועומק/);
    expect(r.reply ?? "").not.toMatch(/999/);
  });

  it("★ queue 7: a team question opened now is told to her", async () => {
    h.responses.push({ toolCalls: [respond("t1", { reply: "אין לנו כרגע תאריך מאומת לחידוש המלאי בשחור.", team_question: "מתי צפוי חידוש מלאי של התיק בצבע שחור?" })] });
    const r = await runReplyEngineTurn({ ...opts, incomingMessage: "מתי יחזור למלאי בצבע שחור?" }, "autonomous");
    if (r.trace.teamQuestion) expect(r.reply).toMatch(/לצוות/);
    else throw new Error(`no team question was opened: ${JSON.stringify(r.trace.gate3)} ${r.reply}`);
  });
});
