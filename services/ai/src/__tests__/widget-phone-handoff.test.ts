/**
 * W2 (2026-11-22) "Continue on WhatsApp? Enter your phone", through the real routes:
 *   - the widget's one state, waHandoffMode: "phone" only with the option on, the number connected, its
 *     template approved under the business's WABA and no payment failure; else "code" (the wa.me link)
 *   - POST /whatsapp-phone-handoff: the BUSINESS's number sends its approved template to the visitor,
 *     the code in the button, the consent line kept with the send; refused for a bad number, no consent,
 *     over a limit; the wa.me link instead when the mode is not "phone" or the visitor opted out
 * Meta is never reached: the send is a queue double.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  kv: new Map<string, any>(),
  counters: new Map<string, number>(),
  accounts: [] as any[],
  numbers: [] as any[],
  conversations: [] as any[],
  templates: [] as any[],
  contacts: [] as any[],
  created: [] as any[],
  queued: [] as any[],
  settings: new Map<string, string>(),
  locale: "he",
}));

vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any): boolean => Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((x) => match(r, x));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(r[k]);
    return r[k] === v;
  });
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    readDurableSetting: async (_t: string, k: string) => H.settings.get(k) ?? null,
    writeDurableSetting: async (_t: string, k: string, v: string | null) => { if (v === null) H.settings.delete(k); else H.settings.set(k, v); },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _r: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _r: any, n: any) => n(),
    requirePermission: () => (_q: any, _r: any, n: any) => n(),
    outgoingMessageQueue: { add: async (_n: string, d: any) => { H.queued.push(d); } },
    getRedis: () => ({
      get: async (k: string) => H.kv.get(k) ?? null,
      set: async (k: string, v: string, ...a: any[]) => { if (a.includes("NX") && H.kv.has(k)) return null; H.kv.set(k, v); return "OK"; },
      incr: async (k: string) => { const n = (H.counters.get(k) ?? 0) + 1; H.counters.set(k, n); return n; },
      expire: async () => 1,
    }),
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.accounts.filter((r) => match(r, a.where)),
        update: async (a: any) => Object.assign(H.accounts.find((x) => x.id === a.where.id), a.data),
      },
      whatsAppNumber: { findMany: async (a: any) => H.numbers.filter((r) => match(r, a.where)) },
      messageTemplate: { findMany: async (a: any) => H.templates.filter((r) => match(r, a.where)) },
      contact: { findFirst: async (a: any) => H.contacts.find((r) => match(r, a.where)) ?? null },
      conversation: { findUnique: async (a: any) => H.conversations.find((c) => c.id === a.where.id) ?? null },
      message: { create: async (a: any) => { const m = { id: `m${H.created.length + 1}`, ...a.data }; H.created.push(m); return m; } },
      flowCanvas: { findUnique: async () => null },
      businessProfile: { findUnique: async () => null },
      tenant: { findUnique: async (a: any) => (a.where.id === "T" ? { name: "Workspace T", defaultLocale: H.locale } : null) },
      shopifyChatInstallation: { findMany: async () => [] },
      $executeRaw: async () => 1,
    },
  };
});
vi.mock("@chatcenter/shared/src/lib/notifications/inbound-push", async (importOriginal) => ({ ...(await importOriginal<any>()), emitInboundMessage: () => false }));

import { normalizeWebchatConfig, handoffConversationKey, handoffPendingKey, paymentBlockKey } from "@chatcenter/shared";
import chat from "../routes/embedded-chat";
import widget from "../routes/website-widget";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", chat); a.use("/api/website-widget", widget); return a; };
const HE_BODY = "שלום, תודה שפניתם אלינו באתר. אפשר להמשיך כאן את השיחה בוואטסאפ: כתבו לנו, ונשמח לעזור מאותה נקודה.";
const CONSENT = "בשליחה אתם מסכימים לקבל מ-Workspace T הודעה בוואטסאפ על השיחה הזו.";
const web = (wa: any = {}) => ({
  id: "ca_web", tenantId: "T", channel: "WEBCHAT", externalId: "widget-1", connectionStatus: "CONNECTED", platformMeta: null, lastHealthCheck: new Date(),
  credentials: normalizeWebchatConfig({ appearance: { language: "he" }, ux: { whatsapp: { enabled: true, channelAccountId: "wa_1", phoneHandoff: true, ...wa } } }),
});
const approved = (o: any = {}) => ({ id: "tpl1", tenantId: "T", channel: "WHATSAPP", channelAccountId: "wa_1", name: "website_chat_handoff", language: "he", status: "APPROVED", body: HE_BODY, ...o });
const send = (body: any = {}) => request(app()).post("/api/embedded-chat/whatsapp-phone-handoff")
  .send({ sessionId: "conv_web", sessionToken: "sess_abc", phone: "054-123-4567", consent: true, consentText: CONSENT, ...body });
const boot = async () => (await request(app()).post("/api/embedded-chat/bootstrap").send({ widgetId: "widget-1" })).body.data.widget;

beforeEach(() => {
  H.kv.clear(); H.counters.clear(); H.settings.clear(); H.created = []; H.queued = []; H.contacts = []; H.locale = "he";
  H.accounts = [web(), { id: "wa_1", tenantId: "T", channel: "WHATSAPP", displayName: "WA", connectionStatus: "CONNECTED", isActive: true }];
  H.numbers = [{ tenantId: "T", channelAccountId: "wa_1", displayPhoneNumber: "+972 52-555-1234" }];
  H.templates = [approved()];
  H.conversations = [{ id: "conv_web", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_abc" }];
});

describe("the widget's one state", () => {
  it("★ phone: option on, number connected, template approved, no payment failure", async () => {
    expect((await boot()).features).toMatchObject({ whatsappHandoff: true, waHandoffMode: "phone" });
  });
  it("code while the template is not approved, or after a payment failure, or with the option off", async () => {
    for (const status of ["PENDING_APPROVAL", "REJECTED", "DRAFT"]) {
      H.templates = [approved({ status })];
      expect((await boot()).features.waHandoffMode).toBe("code");
    }
    H.templates = [];
    expect((await boot()).features.waHandoffMode).toBe("code");
    H.templates = [approved()];
    H.settings.set(paymentBlockKey("wa_1"), JSON.stringify({ at: new Date().toISOString(), code: 131042 }));
    expect((await boot()).features.waHandoffMode).toBe("code");
    H.settings.clear();
    H.accounts[0] = web({ phoneHandoff: false });
    expect((await boot()).features.waHandoffMode).toBe("code");
  });
  it("a template in another language than the workspace's is not this one", async () => {
    H.locale = "en";
    expect((await boot()).features.waHandoffMode).toBe("code");
  });
  it("off with no WhatsApp handoff at all", async () => {
    H.accounts[0] = web({ enabled: false });
    expect((await boot()).features.waHandoffMode).toBe("off");
  });
});

describe("POST /whatsapp-phone-handoff", () => {
  it("★ the business's own number sends its approved template, the code in the button, no WhatsApp conversation yet", async () => {
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { sent: true } });
    const ref = H.kv.get(handoffConversationKey("conv_web"));
    expect(ref).toMatch(/^[A-Z2-9]{6}$/);
    expect(H.queued).toHaveLength(1);
    expect(H.queued[0]).toMatchObject({
      tenantId: "T", conversationId: null, channel: "WHATSAPP", channelAccountId: "wa_1", recipientExternalId: "972541234567",
      messageType: "template", templateName: "website_chat_handoff", templateLanguage: "he", body: HE_BODY,
      templateComponents: [{ type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `wah_${ref}` }] }],
    });
    const row = H.created.find((m) => m.messageType === "template");
    expect(row).toMatchObject({ conversationId: null, direction: "OUTBOUND", status: "PENDING", metadata: { source: "website_phone_handoff", template: { name: "website_chat_handoff", language: "he" }, handoff: { websiteConversationId: "conv_web", ref, channelAccountId: "wa_1", consent: { text: CONSENT } } } });
    expect(JSON.parse(H.kv.get(handoffPendingKey("wa_1", "972541234567")))).toEqual({ ref, messageId: row.id, websiteConversationId: "conv_web" });
  });

  it("the same web chat keeps its one code for the link and the send", async () => {
    await request(app()).post("/api/embedded-chat/whatsapp-handoff").send({ sessionId: "conv_web", sessionToken: "sess_abc" });
    const ref = H.kv.get(handoffConversationKey("conv_web"));
    await send();
    expect(H.queued[0].templateComponents[0].parameters[0].payload).toBe(`wah_${ref}`);
  });

  it("★ consent is required and the line shown is what is kept (cut at 300)", async () => {
    expect((await send({ consent: false })).body).toEqual({ error: "consent_required" });
    expect((await send({ consentText: "" })).status).toBe(400);
    await send({ consentText: "x".repeat(400) });
    expect(H.created.find((m) => m.messageType === "template").metadata.handoff.consent.text).toHaveLength(300);
  });

  it("a number that is not one: 400 invalid_phone, nothing sent", async () => {
    for (const phone of ["", "12", "abc", null]) expect((await send({ phone })).body).toEqual({ error: "invalid_phone" });
    expect(H.queued).toEqual([]);
  });

  it("★ not phone now (template pending): 409 with the wa.me link instead, nothing sent", async () => {
    H.templates = [approved({ status: "PENDING_APPROVAL" })];
    const r = await send();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_available");
    expect(r.body.data.url).toMatch(/^https:\/\/wa\.me\/972525551234\?text=/);
    expect(H.queued).toEqual([]);
  });

  it("★ a payment failure recorded (template approved): the link instead, nothing sent", async () => {
    H.settings.set(paymentBlockKey("wa_1"), JSON.stringify({ at: new Date().toISOString(), code: 131042 }));
    const r = await send();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_available");
    expect(H.queued).toEqual([]);
  });

  it("★ a visitor number that opted out of this business's WhatsApp: the link instead, nothing sent", async () => {
    H.contacts = [{ tenantId: "T", channel: "WHATSAPP", externalId: "972541234567", optOutChannels: ["WHATSAPP"] }];
    expect((await send()).status).toBe(409);
    expect(H.queued).toEqual([]);
  });

  it("★ one per visitor number per business number a day", async () => {
    expect((await send()).status).toBe(200);
    expect((await send()).body).toEqual({ error: "rate_limited" });
    expect(H.queued).toHaveLength(1);
  });

  it("two per web chat a day, whatever the numbers", async () => {
    expect((await send({ phone: "0541111111" })).status).toBe(200);
    expect((await send({ phone: "0542222222" })).status).toBe(200);
    expect((await send({ phone: "0543333333" })).status).toBe(429);
  });

  it("a wrong session or no WhatsApp handoff: 404", async () => {
    expect((await send({ sessionToken: "nope" })).status).toBe(404);
    H.accounts[0] = web({ enabled: false });
    expect((await send()).status).toBe(404);
  });
});

describe("settings", () => {
  it("each number says whether it can send the template, and the widget's mode", async () => {
    const d = (await request(app()).get("/api/website-widget")).body.data;
    expect(d.whatsappNumbers[0].phoneHandoff).toEqual({ template: "approved", templateReason: null, paymentBlocked: false, ready: true });
    expect(d.waHandoffMode).toBe("phone");
  });
  it("switching the option on forgets an old payment failure", async () => {
    H.accounts[0] = web({ phoneHandoff: false });
    H.settings.set(paymentBlockKey("wa_1"), JSON.stringify({ at: new Date().toISOString(), code: 131042 }));
    const r = await request(app()).put("/api/website-widget").send({ ux: { whatsapp: { enabled: true, channelAccountId: "wa_1", phoneHandoff: true } } });
    expect(r.status).toBe(200);
    expect(H.settings.has(paymentBlockKey("wa_1"))).toBe(false);
  });
});
