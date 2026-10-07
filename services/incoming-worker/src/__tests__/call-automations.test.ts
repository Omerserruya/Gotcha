/**
 * "Call missed" / "Call answered" over the real runner and walker:
 *   - ★ a missed inbound call → one run on the caller's WhatsApp conversation,
 *     with the call's variables; the same call again → still one run
 *   - lines: an automation on another line does not run
 *   - ★ no WhatsApp conversation yet → a new one on the workspace's number;
 *     no number / no caller number → a SKIPPED run with the reason
 *   - ★ opted out of WhatsApp, or a person owns the chat → SKIPPED, nothing sent
 *   - a call's own VOICE conversation is never the target
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

import { onCallEvent, formatDuration, onLine } from "../services/call-automation.service";

const T = "T";
const trig = { id: "t", type: "automation_trigger", data: {} };
const e = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });
// The validator allows only a template here; a text step lets the test read the variables.
const missed = (o: any = {}) => ({
  id: "f_missed", tenantId: T, isActive: true, triggerType: "call_missed", triggerConfig: {}, activatedAt: new Date(0),
  nodes: [trig, { id: "s", type: "send_message_text", data: { text: "Hi {{first_name}}, we missed your call to {{line_name}} from {{caller_number}}" } }],
  edges: [e("t", "s")], ...o,
});
const call = (o: any = {}) => ({
  id: "vs1", tenantId: T, direction: "inbound", customerNumber: "+972501234567", channelId: "line1",
  answeredAt: null, endedAt: new Date(), durationMs: null, recordingUrl: null, recordingStatus: null, ...o,
});
const runs = () => H.db.automationRun;

beforeEach(() => {
  H.seq = 0; H.redis = new Map(); H.queued = []; H.sent = [];
  H.db = {
    chatbotFlow: [missed()],
    voiceCallSession: [call()],
    line: [{ id: "line1", friendlyName: "Main line" }],
    contact: [
      { id: "k_voice", tenantId: T, channel: "VOICE", externalId: "+972501234567", phone: "+972501234567", displayName: "Dana Levi", optOutChannels: [] },
      { id: "k_wa", tenantId: T, channel: "WHATSAPP", externalId: "972501234567", phone: "972501234567", displayName: "Dana Levi", optOutChannels: [] },
    ],
    conversation: [
      { id: "c_voice", tenantId: T, channel: "VOICE", customerExternalId: "+972501234567", status: "OPEN", assignedAgentId: null, isHandedOver: false, automationRunId: null, handledBy: null, flowVariables: null, createdAt: new Date(5) },
      { id: "c_wa", tenantId: T, channel: "WHATSAPP", customerExternalId: "972501234567", customerName: "Dana Levi", status: "OPEN", assignedAgentId: null, isHandedOver: false, automationRunId: null, handledBy: null, flowVariables: null, createdAt: new Date(1) },
    ],
    channelAccount: [{ id: "wa1", tenantId: T, channel: "WHATSAPP", isActive: true }],
    tenant: [{ id: T, name: "Urban Supply" }],
    consentRecord: [], automationRun: [], automationRunStep: [], message: [], flowCanvas: [],
  };
});

describe("★ call missed", () => {
  it("one run on the caller's WhatsApp conversation (never the call's own), with the call's variables", async () => {
    expect((await onCallEvent({ tenantId: T, type: "call_missed", sessionId: "vs1" })).outcome).toBe("completed");
    expect(H.sent).toEqual(["Hi Dana, we missed your call to Main line from +972501234567"]);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ flowId: "f_missed", triggerType: "call_missed", eventKey: "call:vs1", conversationId: "c_wa", contactId: "k_wa" });
    // The same call again (a redelivered job): no second run.
    expect((await onCallEvent({ tenantId: T, type: "call_missed", sessionId: "vs1" })).outcome).toBe("duplicate");
    expect(H.sent).toHaveLength(1);
  });

  it("an automation on another line does not run; an outbound call never does", async () => {
    H.db.chatbotFlow = [missed({ triggerConfig: { lines: ["line2"] } })];
    expect((await onCallEvent({ tenantId: T, type: "call_missed", sessionId: "vs1" })).outcome).toBe("no_automation");
    expect(onLine([{ id: "a", triggerConfig: { lines: ["line1"] } }, { id: "b", triggerConfig: {} }, { id: "c", triggerConfig: { lines: ["x"] } }], "line1")).toEqual(["a", "b"]);
    H.db.chatbotFlow = [missed()];
    H.db.voiceCallSession = [call({ direction: "outbound" })];
    expect((await onCallEvent({ tenantId: T, type: "call_missed", sessionId: "vs1" })).outcome).toBe("no_session");
    expect(runs()).toEqual([]);
  });

  it("★ no WhatsApp conversation yet → a new one on the workspace's number", async () => {
    H.db.conversation = H.db.conversation.filter((c) => c.channel !== "WHATSAPP");
    H.db.contact = H.db.contact.filter((c) => c.channel !== "WHATSAPP");
    await onCallEvent({ tenantId: T, type: "call_missed", sessionId: "vs1" });
    const created = H.db.conversation.find((c) => c.channel === "WHATSAPP");
    expect(created).toMatchObject({ channelAccountId: "wa1", customerExternalId: "972501234567" });
    expect(runs()[0]).toMatchObject({ conversationId: created.id, status: "completed" });
    expect(H.sent).toHaveLength(1);
  });

  it("★ only WhatsApp: a web chat with the same phone is not where a caller is answered", async () => {
    H.db.conversation = H.db.conversation.filter((c) => c.channel !== "WHATSAPP");
    H.db.contact = H.db.contact.filter((c) => c.channel !== "WHATSAPP");
    H.db.contact.push({ id: "k_web", tenantId: T, channel: "WEBCHAT", externalId: "visitor-9", phone: "+972501234567", optOutChannels: [] });
    H.db.conversation.push({ id: "c_web", tenantId: T, channel: "WEBCHAT", customerExternalId: "visitor-9", status: "OPEN", assignedAgentId: null, isHandedOver: false, automationRunId: null, createdAt: new Date(9) });
    await onCallEvent({ tenantId: T, type: "call_missed", sessionId: "vs1" });
    expect(runs()[0].conversationId).not.toBe("c_web");
    expect(H.db.conversation.find((c) => c.id === runs()[0].conversationId)).toMatchObject({ channel: "WHATSAPP" });
  });

  it("★ nobody reachable, opted out, or a person owns the chat → a SKIPPED run with the reason, nothing sent", async () => {
    const cases: Array<[string, () => void]> = [
      ["no_reachable_customer", () => { H.db.channelAccount = []; H.db.conversation = []; H.db.contact = []; }],
      ["no_reachable_customer", () => { H.db.voiceCallSession = [call({ customerNumber: "anonymous" })]; }],
      ["opted_out", () => { H.db.contact[1].optOutChannels = ["WHATSAPP"]; }],
      ["conversation_busy", () => { H.db.conversation[1].assignedAgentId = "agent1"; }],
    ];
    for (const [reason, setup] of cases) {
      const saved = JSON.parse(JSON.stringify(H.db), (k, v) => (k === "createdAt" || k === "endedAt" || k === "startedAt") && v ? new Date(v) : v);
      setup();
      expect((await onCallEvent({ tenantId: T, type: "call_missed", sessionId: "vs1" })).outcome).toBe(reason);
      expect(runs()).toEqual([expect.objectContaining({ status: "skipped", error: reason, eventKey: "call:vs1" })]);
      expect(H.sent).toEqual([]);
      H.db = saved;
    }
  });
});

describe("call answered", () => {
  it("duration and the recording (only when it is ready)", async () => {
    H.db.chatbotFlow = [missed({ id: "f_ans", triggerType: "call_answered", nodes: [trig, { id: "s", type: "send_message_text", data: { text: "Thanks for the {{call_duration}} call.{{call_recording_url}}" } }] })];
    H.db.voiceCallSession = [call({ answeredAt: new Date(0), durationMs: 187_000, recordingUrl: "https://rec/1", recordingStatus: "pending" })];
    await onCallEvent({ tenantId: T, type: "call_answered", sessionId: "vs1" });
    expect(H.sent).toEqual(["Thanks for the 3:07 call."]);
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(59_400)).toBe("0:59");
  });
});
