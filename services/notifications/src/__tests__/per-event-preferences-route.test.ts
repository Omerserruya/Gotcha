/**
 * GET/PATCH /notification-preferences/me per event (G9, 2026-10-11):
 *   - eventTypes: what can reach THIS person, on which channels, from the
 *     workspace's own rules (else the built-in route)
 *   - events: a switch per event and channel - an override, else on
 *   - PATCH { events } merges, refuses an unknown event or a non-boolean
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  me: { userId: "dana", role: "ADMIN" } as any,
  rules: [] as any[],
  users: [] as any[],
  settings: [] as any[],
  personal: null as any,
}));

vi.mock("@chatcenter/shared", async () => ({
  ...(await import("@chatcenter/shared/src/lib/notification-category")),
  ...(await import("./helpers/platform-sender-double")).platformSenderDouble,
  normalizeWhatsappPhone: (await import("@chatcenter/shared/src/lib/shopify-chat-ux")).normalizeWhatsappPhone,
  authenticate: (req: any, _r: any, n: any) => { req.user = H.me; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  prisma: {
    notificationPreference: { findMany: async (a: any) => H.rules.filter((r) => r.tenantId === a.where.tenantId && r.enabled) },
    user: {
      findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && u.isActive
        && (a.where.role ? u.role === a.where.role : true)
        && (a.where.id?.in ? a.where.id.in.includes(u.id) : true)),
    },
    departmentMember: { findMany: async () => [] },
    userNotificationPreference: {
      findUnique: async () => H.personal,
      upsert: async (a: any) => (H.personal = { ...(H.personal ?? {}), ...a.update, ...(H.personal ? {} : a.create) }),
    },
    tenantSetting: {
      findFirst: async (a: any) => H.settings.find((s) => s.tenantId === a.where.tenantId && s.key === a.where.key) ?? null,
      upsert: async (a: any) => {
        const s = H.settings.find((x) => x.tenantId === a.where.tenantId_key.tenantId && x.key === a.where.tenantId_key.key);
        if (s) { Object.assign(s, a.update); return s; }
        H.settings.push({ ...a.create }); return a.create;
      },
    },
  },
  publishEvent: async () => undefined,
  getRedis: () => ({ set: async () => "OK" }),
  readDurableSetting: async () => null,
  parseBusinessHours: (v: any) => v,
  NOTIFICATIONS_EMAIL_QUEUE_NAME: "notifications-email",
}));

import router from "../routes/notification-preferences-me";
const app = express();
app.use(express.json());
app.use("/api", router);

const rule = (eventType: string, channels: string[], recipients: any = { type: "tenant_owner" }) =>
  ({ id: `r-${eventType}`, tenantId: "T", departmentId: null, eventType, enabled: true, conditions: null, recipients, channels, priority: "MEDIUM" });

beforeEach(() => {
  H.me = { userId: "dana", role: "ADMIN" };
  const u = (id: string, role: string) => ({ id, tenantId: "T", role, isActive: true, email: `${id}@x.test`, name: id, notificationSoundEnabled: true });
  H.users = [u("dana", "ADMIN"), u("matan", "AGENT")];
  H.rules = [rule("conversation.escalated", ["email", "in_app"]), rule("tool.approval_required", ["in_app"])];
  H.settings = []; H.personal = null;
});

describe("GET: the matrix for this person", () => {
  it("lists what can reach them, on which channels, every switch on by default", async () => {
    const r = await request(app).get("/api/notification-preferences/me");
    expect(r.status).toBe(200);
    const types = Object.fromEntries(r.body.data.eventTypes.map((t: any) => [t.type, t.channels]));
    expect(types["conversation.escalated"]).toEqual(["email", "in_app"]);
    expect(types["tool.approval_required"]).toEqual(["in_app"]);
    expect(r.body.data.events["conversation.escalated"]).toEqual({ email: true, inApp: true });
    expect(r.body.data.events["tool.approval_required"]).toEqual({ inApp: true });
    expect(r.body.data.email).toBe(true); // the global switches are still there
  });

  it("an event routed only to the admins is not offered to an agent", async () => {
    H.me = { userId: "matan", role: "AGENT" };
    const r = await request(app).get("/api/notification-preferences/me");
    const types = r.body.data.eventTypes.map((t: any) => t.type);
    expect(types).not.toContain("conversation.escalated");
    expect(types).toContain("conversation.assigned"); // the built-in route reaches whoever is assigned
  });
});

describe("GET with no workspace rules: the built-in routes (D2, 2026-10-12)", () => {
  it("the five act-on-it events offer email too; others stay in-app", async () => {
    H.rules = [];
    const r = await request(app).get("/api/notification-preferences/me");
    const types = Object.fromEntries(r.body.data.eventTypes.map((t: any) => [t.type, t.channels]));
    for (const t of ["tool.approval_required", "tool.action_failed", "integration.check_failed", "conversation.escalated", "conversation.assigned"]) {
      expect(types[t], t).toEqual(["email", "in_app"]);
    }
    expect(types["broadcast.completed"]).toEqual(["in_app"]);
    // No push provider set up: push is not offered, and an inbound message has nothing else.
    expect(types["message.inbound"]).toBeUndefined();
  });

  it("an agent is offered the assignment by email, and not the admins' events", async () => {
    H.rules = [];
    H.me = { userId: "matan", role: "AGENT" };
    const r = await request(app).get("/api/notification-preferences/me");
    const types = Object.fromEntries(r.body.data.eventTypes.map((t: any) => [t.type, t.channels]));
    expect(types["conversation.assigned"]).toEqual(["email", "in_app"]);
    expect(types["tool.approval_required"]).toBeUndefined();
  });
});

describe("PATCH { events }", () => {
  it("turns one event's email off, keeps the rest, and merges a later change", async () => {
    let r = await request(app).patch("/api/notification-preferences/me").send({ events: { "conversation.escalated": { email: false } } });
    expect(r.status).toBe(200);
    expect(r.body.data.events["conversation.escalated"]).toEqual({ email: false, inApp: true });
    r = await request(app).patch("/api/notification-preferences/me").send({ events: { "conversation.escalated": { inApp: false } } });
    expect(r.body.data.events["conversation.escalated"]).toEqual({ email: false, inApp: false });
    expect(H.settings).toEqual([expect.objectContaining({ tenantId: "T", key: "notify:events:dana", value: { events: { "conversation.escalated": { email: false, inApp: false } } } })]);
    expect(H.personal).toBeNull(); // the global row was not touched
  });

  it("an unknown event, or a value that is not a boolean: 400, nothing stored", async () => {
    expect((await request(app).patch("/api/notification-preferences/me").send({ events: { "made.up": { email: false } } })).body.code).toBe("UNKNOWN_EVENT");
    expect((await request(app).patch("/api/notification-preferences/me").send({ events: { "conversation.escalated": { email: "no" } } })).status).toBe(400);
    expect(H.settings).toHaveLength(0);
  });

  it("is per person: an internal service call has no 'me'", async () => {
    H.me = { userId: "system", role: "ADMIN", isInternal: true };
    expect((await request(app).patch("/api/notification-preferences/me").send({ events: {} })).status).toBe(403);
  });
});

describe("★ WhatsApp on the personal preferences (2026-11-02)", () => {
  beforeEach(() => { H.personal = null; delete process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID; delete process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN; });

  it("GET says whether WhatsApp can be offered, and the confirmed number", async () => {
    const r = await request(app).get("/api/notification-preferences/me");
    expect(r.body.data).toMatchObject({ whatsapp: false, whatsappAvailable: false, whatsappPhone: null, whatsappOptedInAt: null });
  });

  it("WhatsApp cannot be switched on without a number confirmed by code: 422 whatsapp_phone_required", async () => {
    const r = await request(app).patch("/api/notification-preferences/me").send({ whatsapp: true });
    expect([r.status, r.body.code]).toEqual([422, "whatsapp_phone_required"]);
  });

  it("with a confirmed number it can; whatsappPhone: null removes it and turns WhatsApp off", async () => {
    H.personal = { userId: "dana", whatsapp: false, whatsappPhone: "+972521234567", whatsappOptedInAt: new Date() };
    expect((await request(app).patch("/api/notification-preferences/me").send({ whatsapp: true })).status).toBe(200);
    const off = await request(app).patch("/api/notification-preferences/me").send({ whatsappPhone: null });
    expect(off.status).toBe(200);
    expect(H.personal).toMatchObject({ whatsapp: false, whatsappPhone: null, whatsappOptedInAt: null });
  });

  it("a number cannot be set directly, only by a code: 400 whatsapp_phone_requires_code", async () => {
    const r = await request(app).patch("/api/notification-preferences/me").send({ whatsappPhone: "+972521234567" });
    expect([r.status, r.body.code]).toEqual([400, "whatsapp_phone_requires_code"]);
  });

  it("verify without GOTCHA's number: 409 whatsapp_unavailable", async () => {
    const r = await request(app).post("/api/notification-preferences/me/whatsapp/verify").send({ phone: "+972521234567" });
    expect([r.status, r.body.code]).toEqual([409, "whatsapp_unavailable"]);
  });
});

describe("push (mobile app, 2026-11-03)", () => {
  // Push is offered per event only where a provider is set up, like WhatsApp.
  beforeEach(() => { process.env.FCM_PROJECT_ID = "p"; process.env.FCM_CLIENT_EMAIL = "e"; process.env.FCM_PRIVATE_KEY = "k"; });
  afterEach(() => { delete process.env.FCM_PROJECT_ID; delete process.env.FCM_CLIENT_EMAIL; delete process.env.FCM_PRIVATE_KEY; });
  it("the master switch: on by default, PATCH turns it off on the row", async () => {
    expect((await request(app).get("/api/notification-preferences/me")).body.data.push).toBe(true);
    const r = await request(app).patch("/api/notification-preferences/me").send({ push: false });
    expect(r.status).toBe(200);
    expect(r.body.data.push).toBe(false);
    expect(H.personal).toEqual(expect.objectContaining({ push: false, userId: "dana" }));
    expect((await request(app).patch("/api/notification-preferences/me").send({ push: "no" })).status).toBe(400);
  });

  it("offered on the events that push, to whoever they reach; an inbound message is push only", async () => {
    H.rules = [];
    let r = await request(app).get("/api/notification-preferences/me");
    let types = Object.fromEntries(r.body.data.eventTypes.map((t: any) => [t.type, t.channels]));
    for (const t of ["tool.approval_required", "conversation.escalated", "conversation.assigned", "conversation.waiting"]) {
      expect(types[t], t).toEqual(["email", "in_app", "push"]);
    }
    expect(types["tool.action_failed"]).toEqual(["email", "in_app"]);
    expect(types["message.inbound"]).toEqual(["push"]);
    // An agent: their assignments and messages, not the admins' events.
    H.me = { userId: "matan", role: "AGENT" };
    r = await request(app).get("/api/notification-preferences/me");
    types = Object.fromEntries(r.body.data.eventTypes.map((t: any) => [t.type, t.channels]));
    expect(types["conversation.assigned"]).toEqual(["email", "in_app", "push"]);
    expect(types["message.inbound"]).toEqual(["push"]);
    expect(types["tool.approval_required"]).toBeUndefined();
  });

  it("APNs alone (an iOS-only setup) is enough to offer push", async () => {
    delete process.env.FCM_PROJECT_ID;
    process.env.APNS_KEY_ID = "k"; process.env.APNS_TEAM_ID = "t"; process.env.APNS_PRIVATE_KEY = "p";
    try {
      const r = await request(app).get("/api/notification-preferences/me");
      const types = Object.fromEntries(r.body.data.eventTypes.map((t: any) => [t.type, t.channels]));
      expect(types["message.inbound"]).toEqual(["push"]);
    } finally {
      delete process.env.APNS_KEY_ID; delete process.env.APNS_TEAM_ID; delete process.env.APNS_PRIVATE_KEY;
    }
  });

  it("a workspace rule's channels do not decide push: it is personal", async () => {
    H.rules = [rule("conversation.escalated", ["in_app"])];
    const r = await request(app).get("/api/notification-preferences/me");
    const types = Object.fromEntries(r.body.data.eventTypes.map((t: any) => [t.type, t.channels]));
    expect(types["conversation.escalated"]).toEqual(["in_app", "push"]);
  });

  it("per event: a push switch where push can arrive, stored beside email and inApp", async () => {
    H.rules = [];
    H.me = { userId: "dana", role: "ADMIN" };
    let r = await request(app).get("/api/notification-preferences/me");
    expect(r.body.data.events["conversation.escalated"]).toEqual({ email: true, inApp: true, push: true });
    expect(r.body.data.events["tool.action_failed"]).toEqual({ email: true, inApp: true });
    expect(r.body.data.events["message.inbound"]).toEqual({ push: true });
    r = await request(app).patch("/api/notification-preferences/me").send({ events: { "message.inbound": { push: false } } });
    expect(r.body.data.events["message.inbound"]).toEqual({ push: false });
    expect(H.settings[0].value).toEqual({ events: { "message.inbound": { push: false } } });
    expect((await request(app).patch("/api/notification-preferences/me").send({ events: { "message.inbound": { push: 1 } } })).status).toBe(400);
  });
});
