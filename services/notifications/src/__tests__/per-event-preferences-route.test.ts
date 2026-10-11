/**
 * GET/PATCH /notification-preferences/me per event (G9, 2026-10-11):
 *   - eventTypes: what can reach THIS person, on which channels, from the
 *     workspace's own rules (else the built-in route)
 *   - events: a switch per event and channel - an override, else on
 *   - PATCH { events } merges, refuses an unknown event or a non-boolean
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
