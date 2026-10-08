/**
 * Cart left behind, end to end over the real runner and walker:
 *   - ★ abandonment → one run, the cart's variables in the message
 *   - ★ a purchase before the delay → no run
 *   - ★ no prior contact and no consent (or opted out) → a SKIPPED run with the
 *     reason, nothing sent; prior contact is enough (opt-out model, §6)
 *   - ★ every message of a cart run carries the removal line
 *   - ★ the same check twice → one run; a newer update makes the older check stale
 *   - ★ a run waiting to send a second reminder stops when the customer buys
 *   - store consent (Shopify) counts on the phone channel; each live cart
 *     automation gets its own delayed check
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

import { onCartEvent, onCartCheck, cartVariables, type CartCheckJob } from "../services/cart.service";
import { resumeAutomationRun } from "../services/automation-runner.service";
import type { CartEventJob } from "@chatcenter/shared";

const T = "T";
const flow = (id: string, nodes: any[], edges: any[], config: any = {}) => ({
  id, tenantId: T, isActive: true, triggerType: "cart_abandoned", triggerConfig: config, activatedAt: new Date(0), nodes, edges,
});
const trig = { id: "t", type: "automation_trigger", data: {} };
const e = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });
const reminder = () => flow("cart1", [trig, { id: "s", type: "send_message_text", data: { text: "Hi {{first_name}}, your {{cart_items}} ({{cart_total}}) are waiting: {{cart_url}}" } }], [e("t", "s")], { channels: ["WEBCHAT"], delayMinutes: 60 });

const event = (o: Partial<CartEventJob> = {}): CartEventJob => ({
  tenantId: T, source: "test", checkoutId: "chk1", completed: false, updatedAt: "2026-10-07T10:00:00.000Z",
  customer: { email: "dana@test.local", phone: null, firstName: "Dana Levi" },
  items: [{ title: "Cotton Trench Coat", quantity: 1, price: 590 }], total: 590, currency: "ILS",
  cartUrl: "https://shop.test/cart/recover/abc", marketingConsent: null, ...o,
});
const checkJob = (o: Partial<CartCheckJob> = {}): CartCheckJob => ({ tenantId: T, checkoutId: "chk1", flowId: "cart1", updatedAt: "2026-10-07T10:00:00.000Z", ...o });
const runs = () => H.db.automationRun;

beforeEach(() => {
  H.seq = 0; H.redis = new Map(); H.queued = []; H.sent = [];
  H.db = {
    chatbotFlow: [reminder()],
    contact: [{ id: "k1", tenantId: T, channel: "WEBCHAT", externalId: "visitor-1", email: "dana@test.local", optOutChannels: [] }],
    conversation: [{ id: "c1", tenantId: T, channel: "WEBCHAT", customerExternalId: "visitor-1", handledBy: null, status: "OPEN", assignedAgentId: null, isHandedOver: false, automationRunId: null, flowVariables: null, createdAt: new Date(1) }],
    consentRecord: [{ id: "cr1", tenantId: T, subjectType: "contact", subjectId: "k1", purpose: "marketing_webchat", granted: true, createdAt: new Date(1) }],
    tenant: [{ id: T, name: "Urban Supply" }],
    channelAccount: [], automationRun: [], automationRunStep: [], message: [], flowCanvas: [],
  };
});

describe("★ cart left behind", () => {
  it("each live cart automation gets ONE delayed check, after its own delay", async () => {
    expect(await onCartEvent(event())).toEqual({ scheduled: 1 });
    expect(H.queued[0]).toMatchObject({ name: "cart-check", data: checkJob(), opts: { delay: 60 * 60_000 } });
  });

  it("★ abandonment → one run, with the cart's variables", async () => {
    await onCartEvent(event());
    expect(await onCartCheck(checkJob())).toEqual({ outcome: "completed" });
    expect(H.sent).toEqual(["Hi Dana, your Cotton Trench Coat (590.00 ILS) are waiting: https://shop.test/cart/recover/abc\n\nReply STOP to unsubscribe"]);
    expect(runs()[0]).toMatchObject({ triggerType: "cart_abandoned", eventKey: "cart:chk1", status: "completed", conversationId: "c1" });
  });

  it("★ a purchase before the delay → no run", async () => {
    await onCartEvent(event());
    await onCartEvent(event({ completed: true, updatedAt: "2026-10-07T10:20:00.000Z" }));
    expect(await onCartCheck(checkJob())).toEqual({ outcome: "purchased" });
    expect(runs()).toEqual([]);
    expect(H.sent).toEqual([]);
  });

  it("★ no prior contact and no consent → a SKIPPED run with the reason, nothing sent; an opt-out wins over consent", async () => {
    H.db.consentRecord = [];
    await onCartEvent(event());
    expect(await onCartCheck(checkJob())).toEqual({ outcome: "no_prior_contact_or_consent" });
    expect(runs()[0]).toMatchObject({ status: "skipped", error: "no_prior_contact_or_consent", eventKey: "cart:chk1" });
    expect(H.sent).toEqual([]);

    H.db.automationRun = [];
    H.db.consentRecord = [{ id: "cr1", tenantId: T, subjectType: "contact", subjectId: "k1", purpose: "marketing_webchat", granted: true, createdAt: new Date(1) }];
    H.db.contact[0].optOutChannels = ["WEBCHAT"];
    expect(await onCartCheck(checkJob())).toEqual({ outcome: "opted_out" });
    expect(H.sent).toEqual([]);
  });

  it("★ the same check twice → one run; a newer update makes the older check stale", async () => {
    await onCartEvent(event());
    await onCartCheck(checkJob());
    expect(await onCartCheck(checkJob())).toEqual({ outcome: "duplicate" });
    expect(runs()).toHaveLength(1);
    expect(H.sent).toHaveLength(1);

    await onCartEvent(event({ checkoutId: "chk2" }));
    await onCartEvent(event({ checkoutId: "chk2", updatedAt: "2026-10-07T11:00:00.000Z" }));
    expect(await onCartCheck(checkJob({ checkoutId: "chk2" }))).toEqual({ outcome: "stale" });
  });

  it("★ prior contact is enough (opt-out model); an opt-out still wins over it", async () => {
    H.db.consentRecord = [];
    H.db.message = [{ id: "m0", tenantId: T, conversationId: "c1", direction: "INBOUND", body: "hi", createdAt: new Date(1) }];
    await onCartEvent(event());
    expect((await onCartCheck(checkJob())).outcome).toBe("completed");
    expect(H.sent).toHaveLength(1);

    H.db.automationRun = []; H.sent = [];
    H.db.contact[0].optOutChannels = ["webchat"]; // any case
    expect(await onCartCheck(checkJob())).toEqual({ outcome: "opted_out" });
    expect(H.sent).toEqual([]);
  });

  it("the store's own consent counts on the phone channel (Shopify accepts SMS marketing)", async () => {
    H.db.consentRecord = [];
    H.db.contact[0].channel = "WHATSAPP";
    H.db.conversation[0].channel = "WHATSAPP";
    H.db.chatbotFlow = [flow("cart1", [trig, { id: "s", type: "send_message_text", data: { text: "hi" } }], [e("t", "s")], {})];
    await onCartEvent(event({ marketingConsent: { email: false, sms: true } }));
    expect((await onCartCheck(checkJob())).outcome).toBe("completed");
  });

  it("★ \"הסר\" between two reminders wins: the second is not sent", async () => {
    H.db.chatbotFlow = [flow("cart1", [
      trig, { id: "s1", type: "send_message_text", data: { text: "first reminder" } },
      { id: "w", type: "wait", data: { durationMs: 86_400_000 } }, { id: "s2", type: "send_message_text", data: { text: "second reminder" } },
    ], [e("t", "s1"), e("s1", "w"), e("w", "s2")], { channels: ["WEBCHAT"] })];
    await onCartEvent(event());
    await onCartCheck(checkJob());
    expect(H.sent).toHaveLength(1);
    H.db.contact[0].optOutChannels = ["WEBCHAT"];
    await resumeAutomationRun({ tenantId: T, conversationId: "c1", runId: runs()[0].id, message: "", channel: "webchat", fromTimer: true });
    expect(H.sent).toHaveLength(1);
    expect(H.db.automationRunStep.find((s: any) => s.nodeId === "s2")).toMatchObject({ status: "skipped", output: { action: "skipped_opted_out" } });
  });

  it("★ a run waiting to send a second reminder stops when the customer buys", async () => {
    H.db.chatbotFlow = [flow("cart1", [
      trig, { id: "s1", type: "send_message_text", data: { text: "first reminder" } },
      { id: "w", type: "wait", data: { durationMs: 86_400_000 } }, { id: "s2", type: "send_message_text", data: { text: "second reminder" } },
    ], [e("t", "s1"), e("s1", "w"), e("w", "s2")], { channels: ["WEBCHAT"] })];
    await onCartEvent(event());
    await onCartCheck(checkJob());
    expect(runs()[0].status).toBe("waiting");
    await onCartEvent(event({ completed: true }));
    await resumeAutomationRun({ tenantId: T, conversationId: "c1", runId: runs()[0].id, message: "", channel: "webchat", fromTimer: true });
    expect(H.sent).toEqual(["first reminder\n\nReply STOP to unsubscribe"]);
    expect(runs()[0]).toMatchObject({ status: "completed", error: "stopped: purchased" });
    expect(H.db.conversation[0]).toMatchObject({ automationRunId: null, chatbotNodeId: null });
  });

  it("★ a call's own conversation (VOICE) is never written to: a phone-only customer gets a WhatsApp conversation", async () => {
    const { resolveCartTarget } = await import("../services/cart.service");
    H.db.contact = [{ id: "kv", tenantId: T, channel: "VOICE", externalId: "+972501234567", phone: "+972501234567", optOutChannels: [] }];
    H.db.conversation = [{ id: "cv", tenantId: T, channel: "VOICE", customerExternalId: "+972501234567", status: "OPEN", createdAt: new Date(1) }];
    H.db.channelAccount = [{ id: "wa1", tenantId: T, channel: "WHATSAPP", isActive: true }];
    const t = await resolveCartTarget(T, { phone: "+972501234567" });
    expect(t!.conversation).toMatchObject({ channel: "WHATSAPP", customerExternalId: "972501234567" });
  });

  it("variables: items with quantities, total with currency, first name only", () => {
    expect(cartVariables(event({ items: [{ title: "Coat", quantity: 2 }, { title: "Scarf", quantity: 1 }], total: 100, currency: "USD" })))
      .toEqual({ cart_url: "https://shop.test/cart/recover/abc", cart_total: "100.00 USD", cart_items: "Coat x2, Scarf", first_name: "Dana" });
  });
});
