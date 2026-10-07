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
    automationRunStep: table("automationRunStep"), message: table("message"), contact: table("contact"),
    channelAccount: table("channelAccount"), consentRecord: table("consentRecord"), tenant: table("tenant"),
    flowCanvas: table("flowCanvas"), messageTemplate: { findFirst: async () => null },
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
  }),
  decryptCredentials: () => ({}),
  publishEvent: async () => undefined,
  describeSendError: () => ({ sendError: { message: "x" } }),
  safeFetch: vi.fn(),
}));

import { onOrderEvent, orderVariables, forStatus } from "../services/order.service";
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
    consentRecord: [], automationRun: [], automationRunStep: [], message: [], flowCanvas: [],
  };
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
    expect((await onOrderEvent(order({ orderId: "5002" }))).outcome).toBe("no_reachable_customer");
    H.db.automationRun = [];
    H.db.tenant[0].status = "SUSPENDED";
    expect((await onOrderEvent(order({ orderId: "5003" }))).outcome).toBe("tenant_inactive");
    expect(runs()).toEqual([]);
  });

  it("★ no conversation is opened for a customer the automation may not write to (it would only be left empty)", async () => {
    H.db.conversation = []; H.db.contact = [];
    H.db.chatbotFlow = [review({ triggerConfig: { statuses: ["fulfilled"], channels: ["EMAIL"] } })];
    expect((await onOrderEvent(order())).outcome).toBe("no_reachable_customer");
    expect(H.db.conversation).toEqual([]);
    // With WhatsApp allowed (or no channel limit), one is opened by phone.
    H.db.automationRun = [];
    H.db.chatbotFlow = [review()];
    await onOrderEvent(order({ orderId: "5009" }));
    expect(H.db.conversation).toEqual([expect.objectContaining({ channel: "WHATSAPP", channelAccountId: "wa1" })]);
  });

  it("variables", () => {
    expect(orderVariables(order({ total: null, orderUrl: null, customer: {} }))).toEqual({
      order_number: "#1042", order_total: "", order_status: "fulfilled", order_items: "Cotton Trench Coat, Socks x2", order_url: "",
    });
  });
});
