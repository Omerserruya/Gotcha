/**
 * ★ Per-event switches (G9, 2026-10-11): a person turns ONE event off on ONE
 * channel, through processEvent. Harness copied from personal-preferences.
 *
 * (Original header follows.)
 * ★ A person's own notification settings now decide what reaches them
 * (design 15, Step 0), and an event with no workspace rule still reaches
 * someone, in-app only (Step 1). Both through processEvent:
 *   - in-app / email switches, per person (another person's row is not theirs)
 *   - "approvals" off silences approval notices on every channel, nothing else
 *   - quiet hours, in the workspace's timezone: no email, the in-app row is
 *     still written; a failed money action (refund, discount) still emails
 *   - no rule: approvals and failures go to the admins, an assignment to the
 *     assignee, in-app only; an event with no built-in route reaches no one
 *   - an automation's "Notify team" respects the in-app switch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({
  rules: [] as any[],
  users: [] as any[],
  personal: [] as any[],
  timezone: null as string | null,
  inApp: [] as any[],
  emails: [] as any[],
  dedup: new Set<string>(),
  overrides: [] as any[],
  overridesFail: false,
}));

vi.mock("@chatcenter/shared", async () => ({
  ...(await import("@chatcenter/shared/src/lib/notification-category")),
  prisma: {
    notificationPreference: { findMany: async (a: any) => H.rules.filter((r) => r.tenantId === a.where.tenantId && r.eventType === a.where.eventType) },
    user: {
      findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && u.isActive
        && (a.where.role ? u.role === a.where.role : true)
        && (a.where.id?.in ? a.where.id.in.includes(u.id) : true)),
    },
    departmentMember: { findMany: async () => [] },
    userNotificationPreference: { findMany: async (a: any) => H.personal.filter((p) => a.where.userId.in.includes(p.userId)) },
    tenantSetting: {
      findMany: async (a: any) => {
        if (H.overridesFail) throw new Error("db blip");
        return H.overrides.filter((o) => o.tenantId === a.where.tenantId && a.where.key.in.includes(o.key));
      },
    },
    inAppNotification: { create: async ({ data }: any) => { const row = { id: `n${H.inApp.length}`, createdAt: new Date(), read: false, ...data }; H.inApp.push(row); return row; } },
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
  readDurableSetting: async (_t: string, key: string) => (key === "businessHours" && H.timezone ? { timezone: H.timezone } : null),
  parseBusinessHours: (v: any) => v,
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

import { processEvent, deliverAutomationNotice } from "../services/notification-engine.service";
import type { SystemEvent } from "../services/event-emitter.service";

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
  ({ id: `e${++seq}`, type, tenantId: "T", data: { conversationId: `c${seq}`, ...data }, metadata: { timestamp: new Date().toISOString(), ...metadata } }) as unknown as SystemEvent;
const rule = (eventType: string, channels = ["in_app", "email"]) =>
  ({ id: `r-${eventType}`, tenantId: "T", departmentId: null, eventType, enabled: true, conditions: null, recipients: { type: "tenant_owner" }, channels, priority: "HIGH" });
const who = (rows: any[]) => rows.map((r) => r.userId).sort();
// 12:00 UTC = 15:00 in Jerusalem (October, UTC+3).
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-08T12:00:00Z");
  H.rules = []; H.personal = []; H.timezone = null; H.inApp = []; H.emails = []; H.dedup = new Set();
  H.overrides = []; H.overridesFail = false;
  const u = (id: string, role: string, tenantId = "T") => ({ id, tenantId, role, isActive: true, email: `${id}@x.test`, name: id, notificationSoundEnabled: true });
  H.users = [u("dana", "ADMIN"), u("noa", "ADMIN"), u("matan", "AGENT"), u("theirs", "ADMIN", "OTHER")];
});
afterEach(() => vi.useRealTimers());

const off = (userId: string, events: Record<string, { email?: boolean; inApp?: boolean }>, tenantId = "T") =>
  ({ tenantId, key: `notify:events:${userId}`, value: { events } });

describe("★ one event, one channel, one person", () => {
  it("email off for escalations: Dana gets the in-app row only; Noa gets both", async () => {
    H.rules = [rule("conversation.escalated")];
    H.overrides = [off("dana", { "conversation.escalated": { email: false } })];
    await processEvent(ev("conversation.escalated"));
    expect(who(H.inApp)).toEqual(["dana", "noa"]);
    expect(H.emails.map((e) => e.to)).toEqual(["noa@x.test"]);
  });

  it("another event is untouched: Dana's switch is for escalations only", async () => {
    H.rules = [rule("tool.approval_required")];
    H.overrides = [off("dana", { "conversation.escalated": { email: false } })];
    await processEvent(ev("tool.approval_required"));
    expect(H.emails.map((e) => e.to).sort()).toEqual(["dana@x.test", "noa@x.test"]);
  });

  it("in-app off for one event: no row for Dana; her email still comes", async () => {
    H.rules = [rule("conversation.escalated")];
    H.overrides = [off("dana", { "conversation.escalated": { inApp: false } })];
    await processEvent(ev("conversation.escalated"));
    expect(who(H.inApp)).toEqual(["noa"]);
    expect(H.emails.map((e) => e.to).sort()).toEqual(["dana@x.test", "noa@x.test"]);
  });

  it("another workspace's override for the same person id changes nothing here", async () => {
    H.rules = [rule("conversation.escalated")];
    H.overrides = [off("dana", { "conversation.escalated": { email: false } }, "OTHER")];
    await processEvent(ev("conversation.escalated"));
    expect(H.emails.map((e) => e.to).sort()).toEqual(["dana@x.test", "noa@x.test"]);
  });

  it("overrides that cannot be read: delivered exactly as before, never lost", async () => {
    H.rules = [rule("conversation.escalated")];
    H.overrides = [off("dana", { "conversation.escalated": { email: false } })];
    H.overridesFail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await processEvent(ev("conversation.escalated"));
    expect(H.emails.map((e) => e.to).sort()).toEqual(["dana@x.test", "noa@x.test"]);
  });

  it("an automation's Notify team respects the per-event in-app switch", async () => {
    H.overrides = [off("dana", { "automation.notify_team": { inApp: false } })];
    await deliverAutomationNotice({ id: "a1", type: "automation.notify_team", tenantId: "T", data: { message: "hi", userIds: ["dana", "noa"] }, metadata: {} } as any);
    expect(who(H.inApp)).toEqual(["noa"]);
  });
});
