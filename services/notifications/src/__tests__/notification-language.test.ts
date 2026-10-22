/**
 * ★ A notification is in ONE language: the recipient's (their own, else the
 * workspace's). Every template glued English and Hebrew into one body with a
 * "- Hebrew -" divider under an English-only title (seen in the v2 panel,
 * 2026-10-08).
 *   - every event renders in each language with nothing of the other
 *   - through processEvent: a Hebrew reader's row and email are Hebrew, an
 *     English reader's English, for the same event
 *   - GOTCHA is feminine ("העבירה"); a person is "העביר/ה"; "Unknown" is no name
 *   - rows written before the fix are served in the reader's language
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ users: [] as any[], locales: {} as Record<string, string>, inApp: [] as any[], emails: [] as any[], dedup: new Set<string>(), viewer: "dana" }));

vi.mock("@chatcenter/shared", async () => ({
  ...(await import("@chatcenter/shared/src/lib/notification-category")),
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: H.viewer }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  resolveEffectiveLocale: async ({ userId }: any) => ({ effective: H.locales[userId] ?? "en" }),
  prisma: {
    notificationPreference: { findMany: async () => [] },
    user: { findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && (a.where.role ? u.role === a.where.role : true) && (a.where.id?.in ? a.where.id.in.includes(u.id) : true)) },
    departmentMember: { findMany: async () => [] },
    userNotificationPreference: { findMany: async () => [] },
    inAppNotification: {
      create: async ({ data }: any) => { const row = { id: `n${H.inApp.length}`, createdAt: new Date(), read: false, ...data }; H.inApp.push(row); return row; },
      findMany: async (a: any) => H.inApp.filter((r) => r.tenantId === a.where.tenantId && r.userId === a.where.userId),
    },
  },
  publishEvent: async () => undefined,
  getRedis: () => ({
    set: async (key: string, _v: string, _ex: string, _ttl: number, mode: string) => {
      if (mode !== "NX") return "OK";
      if (H.dedup.has(key)) return null;
      H.dedup.add(key);
      return "OK";
    },
    incr: async () => 1, expire: async () => 1, ttl: async () => 60,
  }),
  readDurableSetting: async () => null,
  parseBusinessHours: () => null,
  NOTIFICATIONS_EMAIL_QUEUE_NAME: "notifications-email",
}));

vi.mock("../services/queues", async () => {
  const actual = await vi.importActual<any>("../services/queues");
  return {
    ...actual,
    getNotificationsQueue: () => ({ add: async () => ({ id: "j" }) }),
    getNotificationsEmailQueue: () => ({ add: async (_n: string, p: any) => { H.emails.push(p); return { id: "e" }; } }),
  };
});

import { renderTemplate, oneLanguage } from "../services/templates";
import { processEvent } from "../services/notification-engine.service";
import { EVENT_CATALOGUE } from "../services/event-catalogue";
import router from "../routes/notifications";
import type { SystemEvent } from "../services/event-emitter.service";

const HEBREW = /[֐-׿]/;
const DIVIDER = /- Hebrew -/;
let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
  ({ id: `e${++seq}`, type, tenantId: "T", data: { n: seq, ...data }, metadata: { timestamp: new Date().toISOString(), ...metadata } }) as unknown as SystemEvent;
// Fields a template might print, filled so no branch hides behind a fallback.
const FULL = { tool: "refund_order", summary: "Customer asked", name: "Acme", valueEstimate: "5000", startAt: "2026-10-09 10:00", amount: "120", percent: "10",
  sentCount: 10, failedCount: 2, assignedByName: "Dana", departmentName: "Sales", customerName: "Omer Serruya", channel: "WHATSAPP", displayName: "HubSpot", reason: "401", kind: "refund", message: "boom",
  trialEndsAt: "2026-10-20", planKey: "pro", to: "pro", when: "period_end", effectiveAt: "2026-11-01", last4: "4242", pct: 80, units: 500, ceiling: "200" };

beforeEach(() => {
  H.inApp = []; H.emails = []; H.dedup = new Set(); H.viewer = "dana";
  H.users = [
    { id: "dana", tenantId: "T", role: "ADMIN", isActive: true, email: "dana@x.test", name: "Dana", notificationSoundEnabled: true },
    { id: "john", tenantId: "T", role: "ADMIN", isActive: true, email: "john@x.test", name: "John", notificationSoundEnabled: true },
  ];
  H.locales = { dana: "he", john: "en" };
});

describe("★ every template, one language at a time", () => {
  const types = [...new Set(EVENT_CATALOGUE.map((c) => c.key))];
  it.each(types)("%s: Hebrew has no English divider and a Hebrew title; English has no Hebrew", (type) => {
    for (const data of [FULL, {}]) {
      const he = renderTemplate(ev(type, data), "he");
      const en = renderTemplate(ev(type, data), "en");
      for (const t of [he, en]) expect(`${t.title}\n${t.body}`).not.toMatch(DIVIDER);
      expect(he.title).toMatch(HEBREW);
      // A body may be empty when the title says it all, never with full data.
      if (data === FULL && type === "conversation.assigned") expect(he.body).not.toBe("");
      if (he.body) expect(he.body).toMatch(HEBREW);
      expect(`${en.title}\n${en.body}`).not.toMatch(HEBREW);
      // A body never repeats its title.
      for (const t of [he, en]) expect(t.body.replace(/\.$/, "")).not.toBe(t.title);
    }
  });

  it("an unknown event type is still one language", () => {
    expect(renderTemplate(ev("made.up"), "he").title).toBe("התראה חדשה");
    expect(renderTemplate(ev("made.up"), "en").body).not.toMatch(HEBREW);
  });
});

describe("★ who moved the conversation", () => {
  const he = (by: unknown) => renderTemplate(ev("conversation.assigned", { assignedByName: by }), "he");
  it("a person: העביר/ה; GOTCHA: העבירה; 'Unknown' or nothing: no name at all", () => {
    expect(he("Dana").title).toBe("Dana העביר/ה אליך שיחה");
    expect(he("GOTCHA").title).toBe("GOTCHA העבירה אליך שיחה");
    expect(he("Unknown").title).toBe("שיחה הועברה אליך");
    expect(renderTemplate(ev("conversation.assigned", { assignedByName: "Unknown" }), "en").title).toBe("A conversation was assigned to you");
  });
});

describe("★ the body says which conversation, never the title again", () => {
  const as = (data: any, locale: "he" | "en") => renderTemplate(ev("conversation.assigned", { assignedByName: "Dana", ...data }), locale).body;
  it("the customer and the channel, in each language", () => {
    expect(as({ customerName: "Omer Serruya", channel: "WHATSAPP" }, "he")).toBe("השיחה עם Omer Serruya בוואטסאפ.");
    expect(as({ customerName: "Omer Serruya", channel: "WHATSAPP" }, "en")).toBe("The conversation with Omer Serruya on WhatsApp.");
    expect(as({ customerName: "Noa", channel: "GMAIL" }, "he")).toBe("השיחה עם Noa ב-Gmail.");
    expect(as({ customerName: "Shopper on acme.myshopify.com", channel: "SHOPIFY_LIVE_CHAT" }, "he")).toBe("השיחה עם קונה באתר בצ'אט של Shopify.");
    expect(as({ customerName: "Noa" }, "he")).toBe("השיחה עם Noa.");
  });

  it("neither named: an empty body, and the email says the title instead", async () => {
    expect(as({}, "he")).toBe("");
    expect(as({ channel: "SOMETHING_NEW" }, "en")).toBe("");
    // An assignment rule that emails, so the email body is visible.
    const prefs = await import("@chatcenter/shared");
    (prefs as any).prisma.notificationPreference.findMany = async () => [{ id: "r", tenantId: "T", departmentId: null, eventType: "conversation.assigned", enabled: true, conditions: null, recipients: { type: "users", userIds: ["john"] }, channels: ["email"], priority: "MEDIUM" }];
    try {
      await processEvent(ev("conversation.assigned", { assignedByName: "Dana" }, { userId: "john" }));
    } finally {
      (prefs as any).prisma.notificationPreference.findMany = async () => [];
    }
    expect(H.emails).toHaveLength(1);
    expect(H.emails[0]).toMatchObject({ subject: "Dana assigned you a conversation", body: "Dana assigned you a conversation" });
  });
});

describe("★ through the fan-out: each recipient in their own language", () => {
  it("one approval event: Dana (he) gets Hebrew, John (en) gets English", async () => {
    await processEvent(ev("tool.approval_required", { tool: "refund_order" }));
    const row = (id: string) => H.inApp.find((r) => r.userId === id);
    expect(row("dana")).toMatchObject({ title: "נדרש אישור" });
    expect(row("dana").body).toMatch(HEBREW);
    expect(row("dana").body).not.toMatch(/approval/i);
    expect(row("john")).toMatchObject({ title: "Approval needed" });
    expect(row("john").body).not.toMatch(HEBREW);
    // Never the tool's raw name.
    expect(JSON.stringify([row("dana"), row("john")])).not.toMatch(/refund_order/);
  });

  it("a locale lookup that fails is English, never a lost notification", async () => {
    H.locales = new Proxy({}, { get: () => { throw new Error("db down"); } }) as any;
    await processEvent(ev("tool.approval_required", { tool: "x" }));
    expect(H.inApp.map((r) => r.title)).toEqual(["Approval needed", "Approval needed"]);
  });
});

describe("★ rows written before the fix", () => {
  const OLD = "Dev check transferred a conversation to you.\n\n- Hebrew -\nDev check העביר/ה אליך שיחה.";
  const app = express();
  app.use(router);

  it("are served in the reader's language", async () => {
    H.inApp = [{ id: "old", tenantId: "T", userId: "dana", eventType: "conversation.assigned", title: "t", body: OLD }];
    expect((await request(app).get("/notifications")).body.data[0].body).toBe("Dev check העביר/ה אליך שיחה.");
    H.inApp = [{ id: "old", tenantId: "T", userId: "john", eventType: "conversation.assigned", title: "t", body: OLD }];
    H.viewer = "john";
    expect((await request(app).get("/notifications")).body.data[0].body).toBe("Dev check transferred a conversation to you.");
  });

  it("a one-language body is left as it is", () => {
    expect(oneLanguage("שיחה הועברה אליך.", "en")).toBe("שיחה הועברה אליך.");
    expect(oneLanguage("A conversation was transferred to you.", "he")).toBe("A conversation was transferred to you.");
    // The single-newline form some templates wrote.
    expect(oneLanguage("A new lead was created.\n\n- Hebrew -\nנוצר ליד חדש.", "he")).toBe("נוצר ליד חדש.");
    expect(oneLanguage("Approval needed.\nReason: x\n\n- Hebrew -\nנדרש אישור.", "en")).toBe("Approval needed.\nReason: x");
  });
});
