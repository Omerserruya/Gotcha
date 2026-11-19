/**
 * The SLA settings are readable by whoever answers conversations (2026-10-12).
 * The inbox's SLA warning is for the agent; the two GETs were ADMIN-only, so an
 * agent got 403 and never saw it. Reading needs conversation:messages:read;
 * writing stays ADMIN (Owner). Values are read under the caller's tenant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ locale: "en", user: null as any, reads: [] as string[][], writes: [] as any[], settings: new Map<string, string>() }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const refuse = (res: any) => res.status(403).json({ error: "forbidden" });
  return {
    ...actual,
    prisma: { tenant: { findUnique: async () => ({ defaultLocale: H.locale }) }, department: { findFirst: async (a: any) => (a.where.tenantId === "t1" && a.where.id === "dep1" ? { id: "dep1" } : null) } },
    authenticate: (q: any, _s: any, n: any) => { q.user = H.user; n(); },
    resolveTenant: (q: any, _s: any, n: any) => { q.tenantId = H.user.tenantId; n(); },
    enforceMfaEnrollment: () => (_q: any, _s: any, n: any) => n(),
    requireRole: (role: string) => (q: any, s: any, n: any) => (q.user.role === role ? n() : refuse(s)),
    requirePermissionOrRole: (key: string, role: string) => (q: any, s: any, n: any) =>
      (q.user.role === role || q.user.perms.includes(key) ? n() : refuse(s)),
    readDurableSetting: async (t: string, k: string) => { H.reads.push([t, k]); return H.settings.get(`${t}:${k}`) ?? null; },
    writeDurableSetting: async (t: string, k: string, v: string) => { H.writes.push([t, k, v]); },
  };
});

import agentsRouter from "../routes/agents";
const app = express();
app.use(express.json());
app.use("/api/agents", agentsRouter);

const AGENT = { userId: "u-agent", tenantId: "t1", role: "AGENT", perms: ["conversation:messages:read"] };
const NO_INBOX = { userId: "u-x", tenantId: "t1", role: "AGENT", perms: [] };
const OWNER = { userId: "u-owner", tenantId: "t1", role: "ADMIN", perms: [] };

beforeEach(() => {
  H.reads = []; H.writes = [];
  H.settings = new Map([
    ["t1:sla", JSON.stringify({ enabled: true, slaMinutes: 15, warningThreshold: 80 })],
    ["t1:department:dep1:sla", JSON.stringify({ enabled: true, slaMinutes: 5, warningThreshold: 50 })],
    ["t2:sla", JSON.stringify({ enabled: true, slaMinutes: 999, warningThreshold: 1 })],
  ]);
});

describe("SLA settings: an agent reads, only an Owner writes", () => {
  it("★ an agent who reads conversations gets the workspace and department SLA", async () => {
    H.user = AGENT;
    const ws = await request(app).get("/api/agents/settings/sla");
    expect(ws.status).toBe(200);
    expect(ws.body).toEqual({ enabled: true, slaMinutes: 15, warningThreshold: 80 });
    const dep = await request(app).get("/api/agents/settings/sla/department/dep1");
    expect(dep.status).toBe(200);
    expect(dep.body.slaMinutes).toBe(5);
  });

  it("reads are under the caller's tenant only", async () => {
    H.user = AGENT;
    await request(app).get("/api/agents/settings/sla");
    expect(H.reads).toEqual([["t1", "sla"]]);
  });

  it("someone without conversation access is refused", async () => {
    H.user = NO_INBOX;
    expect((await request(app).get("/api/agents/settings/sla")).status).toBe(403);
    expect((await request(app).get("/api/agents/settings/sla/department/dep1")).status).toBe(403);
    expect(H.reads).toHaveLength(0);
  });

  it("★ an agent cannot write either level", async () => {
    H.user = AGENT;
    const body = { enabled: false, slaMinutes: 60 };
    expect((await request(app).put("/api/agents/settings/sla").send(body)).status).toBe(403);
    expect((await request(app).put("/api/agents/settings/sla/department/dep1").send(body)).status).toBe(403);
    expect(H.writes).toHaveLength(0);
  });

  it("the Owner reads and writes", async () => {
    H.user = OWNER;
    expect((await request(app).get("/api/agents/settings/sla")).status).toBe(200);
    expect((await request(app).put("/api/agents/settings/sla").send({ enabled: true, slaMinutes: 20 })).status).toBe(200);
    expect(H.writes[0].slice(0, 2)).toEqual(["t1", "sla"]);
  });
});

describe("idle automation settings are durable (B8, 2026-10-12)", () => {
  const body = { reminderEnabled: true, reminderDelayMinutes: 90, reminderMessage: "Still there?", autoCloseEnabled: false, autoCloseDelayMinutes: 1440, autoCloseMessage: "" };

  it("PUT writes the durable setting under the tenant, by this person", async () => {
    H.user = OWNER;
    const r = await request(app).put("/api/agents/settings/idle-automation").send(body);
    expect(r.status).toBe(200);
    expect(H.writes).toEqual([["t1", "idleAutomation", JSON.stringify(body)]]);
  });

  it("GET reads it durably, else the defaults", async () => {
    H.user = OWNER;
    expect((await request(app).get("/api/agents/settings/idle-automation")).body.reminderEnabled).toBe(false);
    H.settings.set("t1:idleAutomation", JSON.stringify(body));
    expect((await request(app).get("/api/agents/settings/idle-automation")).body).toEqual(body);
    expect(H.reads).toContainEqual(["t1", "idleAutomation"]);
  });
});

describe("idle automation defaults follow the workspace language (2026-10-13)", () => {
  it("★ a Hebrew workspace with nothing stored gets Hebrew texts", async () => {
    H.user = OWNER; H.locale = "he";
    const b = (await request(app).get("/api/agents/settings/idle-automation")).body;
    expect(b).toMatchObject({ defaultsLanguage: "he", reminderEnabled: false });
    expect(b.reminderMessage).toMatch(/^היי/);
    expect(b.autoCloseMessage).toMatch(/השיחה נסגרה/);
  });
  it("an English workspace gets English", async () => {
    H.user = OWNER; H.locale = "en";
    expect((await request(app).get("/api/agents/settings/idle-automation")).body.reminderMessage).toMatch(/^Hi!/);
  });
});

describe("bot idle settings, per group (2026-11-19): only an Owner, validated, under the caller's tenant", () => {
  const URL = "/api/agents/settings/bot-idle-automation";
  const FLAT = { reminderEnabled: true, reminderDelayMinutes: 10, reminderMessage: "היי, עדיין כאן?", autoCloseEnabled: true, autoCloseDelayMinutes: 10, autoCloseMessage: "סוגרת את השיחה בינתיים.", channels: ["WEBCHAT"] };
  const live = { enabled: true, reminderAfterMinutes: 5, closeAfterReminderMinutes: 7, reminderText: "עוד כאן?", closeText: "נסגר בינתיים." };
  const messaging = { enabled: true, reminderAfterMinutes: 45, closeAfterReminderMinutes: 20, reminderText: "Still with us?", closeText: "" };
  const stored = () => JSON.parse(H.writes.at(-1)[2]);
  beforeEach(() => { H.user = OWNER; H.locale = "en"; delete process.env.BOT_IDLE_DEFAULT_ON; });
  afterEach(() => { delete process.env.BOT_IDLE_DEFAULT_ON; });

  it("★ nothing saved: both groups come back as the platform's default, off while the switch is unset, in the workspace's language", async () => {
    const off = await request(app).get(URL);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({
      liveChat: { enabled: false, reminderAfterMinutes: 10, closeAfterReminderMinutes: 10, reminderText: "Still here? You can pick this up any time.", closeText: "We've closed this chat for now. You can write here again any time.", source: "default" },
      messaging: { enabled: false, reminderAfterMinutes: 30, closeAfterReminderMinutes: 15, reminderText: "Still here? You can pick this up any time.", closeText: "We've closed this chat for now. You can write here again any time.", source: "default" },
    });
    process.env.BOT_IDLE_DEFAULT_ON = "on"; H.locale = "he";
    const on = (await request(app).get(URL)).body;
    expect(on.liveChat).toMatchObject({ enabled: true, reminderAfterMinutes: 10, closeAfterReminderMinutes: 10, reminderText: "עדיין כאן? אפשר להמשיך מכאן בכל רגע.", closeText: "סגרנו את השיחה בינתיים. אפשר לכתוב כאן שוב בכל רגע.", source: "default" });
    expect(on.messaging).toMatchObject({ enabled: true, reminderAfterMinutes: 30, closeAfterReminderMinutes: 15, source: "default" });
    // A read writes nothing.
    expect(H.writes).toHaveLength(0);
    expect(H.reads).toEqual([["t1", "botIdleAutomation"], ["t1", "botIdleAutomation"]]);
  });

  it("★ the row from before the groups (WEBCHAT only): it shows as the live chat group, the business's own; messaging is the default", async () => {
    process.env.BOT_IDLE_DEFAULT_ON = "on";
    H.settings.set("t1:botIdleAutomation", JSON.stringify(FLAT));
    const b = (await request(app).get(URL)).body;
    expect(b.liveChat).toEqual({ enabled: true, reminderAfterMinutes: 10, closeAfterReminderMinutes: 10, reminderText: FLAT.reminderMessage, closeText: FLAT.autoCloseMessage, source: "custom" });
    expect(b.messaging.source).toBe("default");
  });

  it("★ one group saved: only it is written, as sent; the other group and the old row's own fields stay", async () => {
    H.settings.set("t1:botIdleAutomation", JSON.stringify(FLAT));
    const r = await request(app).put(URL).send({ messaging });
    expect(r.status).toBe(200);
    expect(H.writes).toHaveLength(1);
    expect(H.writes[0].slice(0, 2)).toEqual(["t1", "botIdleAutomation"]);
    expect(stored()).toEqual({ ...FLAT, groups: { messaging } });
    expect(r.body.messaging).toEqual({ ...messaging, source: "custom" });
    expect(r.body.liveChat).toMatchObject({ reminderText: FLAT.reminderMessage, source: "custom" });
    // Then the other one: the first is kept.
    H.settings.set("t1:botIdleAutomation", H.writes[0][2]);
    const r2 = await request(app).put(URL).send({ liveChat: live });
    expect(stored()).toEqual({ ...FLAT, groups: { messaging, liveChat: live } });
    expect(r2.body).toEqual({ liveChat: { ...live, source: "custom" }, messaging: { ...messaging, source: "custom" } });
    H.settings.set("t1:botIdleAutomation", H.writes[1][2]);
    expect((await request(app).get(URL)).body).toEqual(r2.body);
  });

  it("★ both groups in one save; texts are trimmed; a group switched off is stored as off", async () => {
    const r = await request(app).put(URL).send({ liveChat: { ...live, reminderText: "  עוד כאן?  " }, messaging: { ...messaging, enabled: false } });
    expect(r.status).toBe(200);
    expect(stored()).toEqual({ groups: { liveChat: live, messaging: { ...messaging, enabled: false } } });
    expect(r.body.messaging).toMatchObject({ enabled: false, source: "custom" });
  });

  it("★ the close text may be empty (close with no message); the reminder text may be empty only while the group is off", async () => {
    expect((await request(app).put(URL).send({ liveChat: { ...live, closeText: "" } })).status).toBe(200);
    expect((await request(app).put(URL).send({ liveChat: { ...live, enabled: false, reminderText: "" } })).status).toBe(200);
    H.writes = [];
    for (const reminderText of ["", "   "]) {
      const r = await request(app).put(URL).send({ liveChat: { ...live, reminderText } });
      expect(r.status).toBe(422);
    }
    // One bad group refuses the whole save.
    expect((await request(app).put(URL).send({ liveChat: live, messaging: { ...messaging, reminderText: "" } })).status).toBe(422);
    expect(H.writes).toHaveLength(0);
  });

  it("★ refused with 400: no group, an unknown group or field, the old flat body, a missing field, a delay outside 1..10080, a text over 1000", async () => {
    const { closeText: _c, ...noClose } = live;
    const bad = [
      {}, { email: live }, { liveChat: live, extra: 1 }, { liveChat: { ...live, source: "custom" } }, { liveChat: { ...live, channels: ["WEBCHAT"] } },
      FLAT, { liveChat: noClose },
      { liveChat: { ...live, reminderAfterMinutes: 0 } }, { liveChat: { ...live, reminderAfterMinutes: 10081 } }, { liveChat: { ...live, reminderAfterMinutes: 1.5 } },
      { messaging: { ...messaging, closeAfterReminderMinutes: 0 } }, { messaging: { ...messaging, closeAfterReminderMinutes: 10081 } }, { messaging: { ...messaging, closeAfterReminderMinutes: "15" } },
      { liveChat: { ...live, reminderText: "x".repeat(1001) } }, { liveChat: { ...live, closeText: "x".repeat(1001) } }, { liveChat: { ...live, enabled: "yes" } },
    ];
    for (const body of bad) {
      const r = await request(app).put(URL).send(body);
      expect([JSON.stringify(body).slice(0, 60), r.status]).toEqual([JSON.stringify(body).slice(0, 60), 400]);
    }
    expect(H.writes).toHaveLength(0);
    // The edges are inside.
    expect((await request(app).put(URL).send({ liveChat: { ...live, reminderAfterMinutes: 1, closeAfterReminderMinutes: 10080, reminderText: "x".repeat(1000) } })).status).toBe(200);
  });

  it("★ an agent neither reads nor writes it; the write is by this person, under the caller's tenant", async () => {
    H.user = AGENT;
    expect((await request(app).put(URL).send({ liveChat: live })).status).toBe(403);
    expect((await request(app).get(URL)).status).toBe(403);
    expect(H.writes).toHaveLength(0);
    expect(H.reads).toHaveLength(0);
    H.user = OWNER;
    H.settings.set("t2:botIdleAutomation", JSON.stringify({ groups: { liveChat: { ...live, reminderText: "another business" } } }));
    expect((await request(app).get(URL)).body.liveChat.source).toBe("default");
  });
});
