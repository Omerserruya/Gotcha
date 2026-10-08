/**
 * "Order event" over the real runner and walker:
 *   - ★ an order status → one run per automation listening for that status,
 *     with the order's variables; the same status again (a webhook retry, a
 *     second poll) → no second run; another status of the same order → its own run
 *   - statuses filter; an inactive workspace runs nothing
 *   - ★ no marketing consent needed (it is the customer's own order), but an
 *     opt-out wins; nobody reachable → a SKIPPED run with the reason
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  db: {} as Record<string, any[]>,
  seq: 0,
  redis: new Map<string, string>(),
  queued: [] as any[],
  sent: [] as string[],
}));

vi.mock("../services/ai-bot.service", () => ({
  processAIBot: vi.fn(async () => true),
  getBusinessHoursState: async () => ({ cfg: null, state: { configured: false, open: true, nextOpening: null, timezone: "UTC" } }),
}));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn() }));
vi.mock("../services/ensure-contact.service", () => ({
  ensureContactForInbound: async (a: any) => { const c = { id: `contact_${++H.seq}`, channel: a.channel, externalId: a.externalId, optOutChannels: [] }; H.db.contact.push({ ...c, tenantId: a.tenantId, displayName: a.displayName }); return c; },
}));

function m(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => m(row, w));
    if (v instanceof Date) return +row[k] === +v;
    if (v && typeof v === "object") {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
      if ("gte" in v) return row[k] >= v.gte;
      if ("contains" in v) return String(row[k] ?? "").includes(v.contains);
      if ("equals" in v) return String(row[k] ?? "").toLowerCase() === String(v.equals).toLowerCase();
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
function table(name: string) {
  const rows = () => (H.db[name] ??= []);
  return {
    findMany: async (a: any = {}) => rows().filter((r) => m(r, a.where)).slice(0, a.take ?? 1e9).map((r) => ({ ...r })),
    findFirst: async (a: any = {}) => {
      let r = rows().filter((x) => m(x, a.where));
      if (a.orderBy?.createdAt === "desc") r = [...r].sort((x, y) => +y.createdAt - +x.createdAt);
      const x = r[0];
      if (!x) return null;
      return a.include?.channelAccount ? { ...x, channelAccount: { externalId: "acct", credentials: {} } } : { ...x };
    },
    findUnique: async (a: any) => { const x = rows().find((r) => r.id === a.where.id); return x ? { ...x } : null; },
    count: async (a: any = {}) => rows().filter((r) => m(r, a.where)).length,
    create: async (a: any) => {
      if (name === "automationRun" && rows().some((r) => r.flowId === a.data.flowId && r.eventKey === a.data.eventKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const x = { id: `${name}_${++H.seq}`, createdAt: new Date(Date.now() + H.seq), startedAt: new Date(), ...a.data };
      rows().push(x);
      return { ...x };
    },
    createMany: async (a: any) => { for (const d of a.data) rows().push({ id: `${name}_${++H.seq}`, ...d }); return { count: a.data.length }; },
    update: async (a: any) => { const x = rows().find((r) => r.id === a.where.id); Object.assign(x, a.data); return { ...x }; },
  };
}

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    conversation: table("conversation"), chatbotFlow: table("chatbotFlow"), automationRun: table("automationRun"),
    automationRunStep: table("automationRunStep"),
    message: {
      ...table("message"),
      // The prior-contact check counts INBOUND messages in conversations of the
      // customer's contacts: evaluate that relation filter for real.
      count: async (a: any = {}) => (H.db.message ?? []).filter((msg) => {
        if (a.where?.tenantId && msg.tenantId !== a.where.tenantId) return false;
        if (a.where?.direction && msg.direction !== a.where.direction) return false;
        const rel = a.where?.conversation?.OR;
        if (!rel) return true;
        const conv = (H.db.conversation ?? []).find((c) => c.id === msg.conversationId);
        return !!conv && rel.some((r: any) => r.channel === conv.channel && r.customerExternalId === conv.customerExternalId);
      }).length,
    },
    contact: table("contact"),
    channelAccount: table("channelAccount"), consentRecord: table("consentRecord"), tenant: table("tenant"),
    flowCanvas: table("flowCanvas"), messageTemplate: table("messageTemplate"),
    voiceCallSession: {
      findFirst: async (a: any) => {
        const x = (H.db.voiceCallSession ?? []).find((r) => m(r, a.where));
        return x ? { ...x, channel: (H.db.line ?? []).find((l) => l.id === x.channelId) ?? null } : null;
      },
    },
  },
  getRedis: () => ({
    get: async (k: string) => H.redis.get(k) ?? null,
    set: async (k: string, v: string) => { H.redis.set(k, v); return "OK"; },
  }),
  incomingMessageQueue: { add: async (name: string, data: any, opts: any) => { H.queued.push({ name, data, opts }); } },
  flowResumeQueue: { add: async (_n: string, data: any, opts: any) => { H.queued.push({ name: "resume", data, opts }); } },
  notificationsQueue: { add: async () => undefined },
  getOutboundAdapter: () => ({
    sendTextMessage: async (_c: any, _a: any, _r: any, body: string) => { H.sent.push(body); return `ext_${++H.seq}`; },
    sendInteractiveMessage: async () => `ext_${++H.seq}`,
    sendTemplateMessage: async (_c: any, _a: any, _r: any, name: string) => { H.sent.push(`template:${name}`); return `ext_${++H.seq}`; },
  }),
  decryptCredentials: () => ({}),
  publishEvent: async () => undefined,
  describeSendError: () => ({ sendError: { message: "x" } }),
  safeFetch: vi.fn(),
}));

import { onOrderEvent, orderVariables, forStatus } from "../services/order.service";
import { resumeAutomationRun } from "../services/automation-runner.service";
import type { OrderEventJob } from "@chatcenter/shared";

const T = "T";
const trig = { id: "t", type: "automation_trigger", data: {} };
const e = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });
// The validator allows only a template on WhatsApp; a text step lets the test read the variables.
const review = (o: any = {}) => ({
  id: "f_review", tenantId: T, isActive: true, triggerType: "order_event", triggerConfig: { statuses: ["fulfilled"] }, activatedAt: new Date(0),
  nodes: [trig, { id: "s", type: "send_message_text", data: { text: "Hi {{first_name}}, order {{order_number}} ({{order_total}}: {{order_items}}) is on its way. How was it?" } }],
  edges: [e("t", "s")], ...o,
});
const order = (o: Partial<OrderEventJob> = {}): OrderEventJob => ({
  tenantId: T, source: "shopify", orderId: "5001", status: "fulfilled", orderNumber: "#1042", total: 590, currency: "ILS",
  customer: { email: "dana@test.local", phone: "+972501234567", firstName: "Dana Levi" },
  items: [{ title: "Cotton Trench Coat", quantity: 1 }, { title: "Socks", quantity: 2 }], orderUrl: "https://shop.test/orders/abc", ...o,
});
const runs = () => H.db.automationRun;

beforeEach(() => {
  H.seq = 0; H.redis = new Map(); H.queued = []; H.sent = [];
  H.db = {
    chatbotFlow: [review()],
    contact: [{ id: "k_wa", tenantId: T, channel: "WHATSAPP", externalId: "972501234567", phone: "972501234567", displayName: "Dana Levi", optOutChannels: [] }],
    conversation: [{ id: "c_wa", tenantId: T, channel: "WHATSAPP", customerExternalId: "972501234567", status: "OPEN", assignedAgentId: null, isHandedOver: false, automationRunId: null, handledBy: null, flowVariables: null, createdAt: new Date(1) }],
    channelAccount: [{ id: "wa1", tenantId: T, channel: "WHATSAPP", isActive: true }],
    tenant: [{ id: T, name: "Urban Supply", status: "ACTIVE" }],
    consentRecord: [], automationRun: [], automationRunStep: [], flowCanvas: [], messageTemplate: [],
    // Dana has written to the business before (the prior-contact rule).
    message: [{ id: "in0", tenantId: T, conversationId: "c_wa", direction: "INBOUND", body: "hi" }],
  };
});

describe("★ a review request (a send after a wait) is marketing; a status update is not", () => {
  const askLater = () => review({
    nodes: [trig, { id: "w", type: "wait", data: { durationMs: 3 * 86_400_000 } }, { id: "s", type: "send_message_text", data: { text: "How was your order? Leave us a review" } }],
    edges: [e("t", "w"), e("w", "s")],
  });
  const resume = () => resumeAutomationRun({ tenantId: T, conversationId: "c_wa", runId: runs()[0].id, message: "", channel: "whatsapp", fromTimer: true });

  it("a send straight on the event stays transactional: no removal line", async () => {
    await onOrderEvent(order());
    expect(H.sent[0]).not.toMatch(/Reply STOP|להסרה/);
  });

  it("★ a send after the wait carries the removal line", async () => {
    H.db.chatbotFlow = [askLater()];
    await onOrderEvent(order());
    expect(runs()[0].status).toBe("waiting");
    expect(H.sent).toEqual([]);
    await resume();
    expect(H.sent).toEqual(["How was your order? Leave us a review\n\nReply STOP to unsubscribe"]);
  });

  it("★ a review TEMPLATE after the wait: sent with its line; after \"הסר\" during the wait, not sent", async () => {
    H.db.messageTemplate = [{ id: "tpl", tenantId: T, name: "ask_review", language: "he", status: "APPROVED", category: "MARKETING", body: "איך היה?\n\nלהסרה השיבו הסר", headerType: null, headerContent: null, variables: [] }];
    const tplFlow = () => review({
      nodes: [trig, { id: "w", type: "wait", data: { durationMs: 3 * 86_400_000 } }, { id: "s", type: "send_message_template", data: { templateId: "tpl" } }],
      edges: [e("t", "w"), e("w", "s")],
    });
    H.db.chatbotFlow = [tplFlow()];
    await onOrderEvent(order());
    await resume();
    expect(H.sent).toEqual(["template:ask_review"]);

    H.db.automationRun = []; H.db.automationRunStep = []; H.sent = [];
    H.db.conversation[0].automationRunId = null; H.db.conversation[0].chatbotNodeId = null;
    await onOrderEvent(order({ orderId: "5002" }));
    H.db.contact[0].optOutChannels = ["WHATSAPP"];
    await resume();
    expect(H.sent).toEqual([]);
    expect(H.db.automationRunStep.find((s: any) => s.nodeId === "s")).toMatchObject({ status: "skipped", output: { action: "skipped_opted_out" } });
  });

  it("★ \"הסר\" during the wait wins at send time: nothing is sent, the step says why", async () => {
    H.db.chatbotFlow = [askLater()];
    await onOrderEvent(order());
    H.db.contact[0].optOutChannels = ["WHATSAPP"];
    await resume();
    expect(H.sent).toEqual([]);
    expect(H.db.automationRunStep.find((s: any) => s.nodeId === "s")).toMatchObject({ status: "skipped", output: { action: "skipped_opted_out" } });
  });
});

describe("★ order event", () => {
  it("one run with the order's variables; the same status again → no second run; no consent needed", async () => {
    expect((await onOrderEvent(order())).outcome).toBe("completed");
    expect(H.sent).toEqual(["Hi Dana, order #1042 (590.00 ILS: Cotton Trench Coat, Socks x2) is on its way. How was it?"]);
    expect(runs()).toEqual([expect.objectContaining({ triggerType: "order_event", eventKey: "order:shopify:5001:fulfilled", conversationId: "c_wa", status: "completed" })]);
    expect((await onOrderEvent(order())).outcome).toBe("duplicate");
    expect(H.sent).toHaveLength(1);
  });

  it("statuses: an automation for 'fulfilled' ignores 'paid'; one with no statuses hears every status, once each", async () => {
    expect((await onOrderEvent(order({ status: "paid" }))).outcome).toBe("no_automation");
    H.db.chatbotFlow = [review({ id: "f_all", triggerConfig: {} })];
    await onOrderEvent(order({ status: "paid" }));
    await onOrderEvent(order({ status: "fulfilled" }));
    expect(runs().map((r) => r.eventKey)).toEqual(["order:shopify:5001:paid", "order:shopify:5001:fulfilled"]);
    expect(forStatus([{ id: "a", triggerConfig: { statuses: ["paid"] } }, { id: "b", triggerConfig: {} }], "cancelled")).toEqual(["b"]);
  });

  it("★ an opt-out wins; nobody reachable → SKIPPED with the reason; an inactive workspace runs nothing", async () => {
    H.db.contact[0].optOutChannels = ["WHATSAPP"];
    expect((await onOrderEvent(order())).outcome).toBe("opted_out");
    expect(runs()).toEqual([expect.objectContaining({ status: "skipped", error: "opted_out" })]);
    expect(H.sent).toEqual([]);
    H.db.automationRun = [];
    H.db.contact = []; H.db.conversation = []; H.db.channelAccount = [];
    // With consent but no channel to reach them on: nobody reachable.
    expect((await onOrderEvent(order({ orderId: "5002", marketingConsent: { email: null, sms: true } }))).outcome).toBe("no_reachable_customer");
    H.db.automationRun = [];
    H.db.tenant[0].status = "SUSPENDED";
    expect((await onOrderEvent(order({ orderId: "5003" }))).outcome).toBe("tenant_inactive");
    expect(runs()).toEqual([]);
  });

  it("★ no conversation is opened for a customer the automation may not write to (it would only be left empty)", async () => {
    H.db.conversation = []; H.db.contact = []; H.db.message = [];
    const consented = { marketingConsent: { email: null, sms: true } };
    H.db.chatbotFlow = [review({ triggerConfig: { statuses: ["fulfilled"], channels: ["EMAIL"] } })];
    expect((await onOrderEvent(order(consented))).outcome).toBe("no_reachable_customer");
    expect(H.db.conversation).toEqual([]);
    // With WhatsApp allowed (or no channel limit) and the store's consent, one is opened by phone.
    H.db.automationRun = [];
    H.db.chatbotFlow = [review()];
    await onOrderEvent(order({ orderId: "5009", ...consented }));
    expect(H.db.conversation).toEqual([expect.objectContaining({ channel: "WHATSAPP", channelAccountId: "wa1" })]);
  });

  it("★ no prior contact and no consent → SKIPPED (no_prior_contact_or_consent), nothing sent, no conversation opened", async () => {
    H.db.message = [];                       // Dana never wrote
    expect((await onOrderEvent(order())).outcome).toBe("no_prior_contact_or_consent");
    expect(runs()).toEqual([expect.objectContaining({ status: "skipped", error: "no_prior_contact_or_consent", eventKey: "order:shopify:5001:fulfilled" })]);
    expect(H.sent).toEqual([]);
    // A brand-new buyer (no contact at all) is not given a fresh conversation either.
    H.db.automationRun = []; H.db.contact = []; H.db.conversation = [];
    expect((await onOrderEvent(order({ orderId: "5002" }))).outcome).toBe("no_prior_contact_or_consent");
    expect(H.db.conversation).toEqual([]);
  });

  it("★ applies to every order message: a status update too", async () => {
    H.db.message = [];
    H.db.chatbotFlow = [review({ triggerConfig: {} })];
    for (const status of ["created", "paid", "fulfilled", "cancelled"] as const) {
      expect((await onOrderEvent(order({ orderId: `s-${status}`, status }))).outcome).toBe("no_prior_contact_or_consent");
    }
    expect(H.sent).toEqual([]);
  });

  it("consent instead of prior contact: a granted ConsentRecord, or the store's own record", async () => {
    H.db.message = [];
    H.db.consentRecord = [{ id: "cr1", tenantId: T, subjectType: "contact", subjectId: "k_wa", purpose: "marketing_whatsapp", granted: true, createdAt: new Date(1) }];
    expect((await onOrderEvent(order())).outcome).toBe("completed");
    H.db.consentRecord = []; H.db.automationRun = []; H.sent = [];
    expect((await onOrderEvent(order({ orderId: "5003", marketingConsent: { email: null, sms: true } }))).outcome).toBe("completed");
    expect(H.sent).toHaveLength(1);
  });

  it("prior contact on ANOTHER channel counts (she wrote on the web chat with the same email)", async () => {
    H.db.message = [{ id: "w0", tenantId: T, conversationId: "c_web", direction: "INBOUND", body: "hello" }];
    H.db.contact.push({ id: "k_web", tenantId: T, channel: "WEBCHAT", externalId: "v-9", email: "dana@test.local", optOutChannels: [] });
    H.db.conversation.push({ id: "c_web", tenantId: T, channel: "WEBCHAT", customerExternalId: "v-9", status: "OPEN", createdAt: new Date(0) });
    expect((await onOrderEvent(order())).outcome).toBe("completed");
  });

  it("★ an opt-out wins over prior contact and over consent", async () => {
    H.db.contact[0].optOutChannels = ["WHATSAPP"];
    H.db.consentRecord = [{ id: "cr1", tenantId: T, subjectType: "contact", subjectId: "k_wa", purpose: "marketing_whatsapp", granted: true, createdAt: new Date(1) }];
    expect((await onOrderEvent(order())).outcome).toBe("opted_out");
    expect(H.sent).toEqual([]);
  });

  it("variables", () => {
    expect(orderVariables(order({ total: null, orderUrl: null, customer: {} }))).toEqual({
      order_number: "#1042", order_total: "", order_status: "fulfilled", order_items: "Cotton Trench Coat, Socks x2", order_url: "",
    });
  });
});
