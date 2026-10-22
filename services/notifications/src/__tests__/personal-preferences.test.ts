/**
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

import { processEvent } from "../services/notification-engine.service";
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
  const u = (id: string, role: string, tenantId = "T") => ({ id, tenantId, role, isActive: true, email: `${id}@x.test`, name: id, notificationSoundEnabled: true });
  H.users = [u("dana", "ADMIN"), u("noa", "ADMIN"), u("matan", "AGENT"), u("theirs", "ADMIN", "OTHER")];
});
afterEach(() => vi.useRealTimers());

describe("★ the person's own switches", () => {
  it("email off: that person gets the in-app row only; the other admin gets both", async () => {
    H.rules = [rule("conversation.escalated")];
    H.personal = [{ userId: "dana", email: false }];
    await processEvent(ev("conversation.escalated"));
    expect(who(H.inApp)).toEqual(["dana", "noa"]);
    expect(H.emails.map((e) => e.to)).toEqual(["noa@x.test"]);
  });

  it("in-app off: no row for that person; email still comes", async () => {
    H.rules = [rule("conversation.escalated")];
    H.personal = [{ userId: "noa", inApp: false }];
    await processEvent(ev("conversation.escalated"));
    expect(who(H.inApp)).toEqual(["dana"]);
    expect(H.emails.map((e) => e.to).sort()).toEqual(["dana@x.test", "noa@x.test"]);
  });

  it("approvals off: no approval notice on any channel; other events still arrive", async () => {
    H.rules = [rule("tool.approval_required"), rule("conversation.escalated")];
    H.personal = [{ userId: "dana", approvals: false }];
    await processEvent(ev("tool.approval_required"));
    expect(who(H.inApp)).toEqual(["noa"]);
    expect(H.emails.map((e) => e.to)).toEqual(["noa@x.test"]);
    await processEvent(ev("conversation.escalated"));
    expect(who(H.inApp)).toEqual(["dana", "noa", "noa"]);
  });
});

describe("★ quiet hours, in the workspace's timezone", () => {
  beforeEach(() => {
    H.timezone = "Asia/Jerusalem";
    H.rules = [rule("conversation.escalated"), rule("tool.action_failed")];
    // 14:00 to 16:00 local; now is 15:00 local (12:00 UTC).
    H.personal = [{ userId: "dana", quietHoursFrom: "14:00", quietHoursTo: "16:00" }];
  });

  it("inside: no email, the in-app row is still written", async () => {
    await processEvent(ev("conversation.escalated"));
    expect(who(H.inApp)).toEqual(["dana", "noa"]);
    expect(H.emails.map((e) => e.to)).toEqual(["noa@x.test"]);
  });

  it("the window is the workspace's clock, not UTC: at 16:30 local the email comes", async () => {
    at("2026-10-08T13:30:00Z");
    await processEvent(ev("conversation.escalated"));
    expect(H.emails.map((e) => e.to).sort()).toEqual(["dana@x.test", "noa@x.test"]);
  });

  it("a failed refund or discount still emails inside quiet hours; any other failure does not", async () => {
    await processEvent(ev("tool.action_failed", { kind: "refund.issued" }));
    await processEvent(ev("tool.action_failed", { kind: "discount.applied" }));
    expect(H.emails.filter((e) => e.to === "dana@x.test")).toHaveLength(2);
    await processEvent(ev("tool.action_failed", { kind: "crm.update" }));
    expect(H.emails.filter((e) => e.to === "dana@x.test")).toHaveLength(2);
  });

  it("a window across midnight (22:00 to 07:00)", async () => {
    H.personal = [{ userId: "dana", quietHoursFrom: "22:00", quietHoursTo: "07:00" }];
    at("2026-10-08T21:30:00Z"); // 00:30 local
    await processEvent(ev("conversation.escalated"));
    at("2026-10-08T04:30:00Z"); // 07:30 local
    await processEvent(ev("conversation.escalated"));
    expect(H.emails.filter((e) => e.to === "dana@x.test")).toHaveLength(1);
  });
});

describe("★ no workspace rule: the built-in route", () => {
  // Was "in-app only, never by email". Since 2026-10-12 (Omer, D2) five events
  // also email by default, to the same people (per-event-preferences.test.ts).
  it("an approval request reaches this workspace's admins, never another's, in-app and by email", async () => {
    await processEvent(ev("tool.approval_required"));
    expect(who(H.inApp)).toEqual(["dana", "noa"]);
    expect(H.emails.map((e: any) => e.to).sort()).toEqual(["dana@x.test", "noa@x.test"]);
  });

  it("an assignment reaches the assignee only", async () => {
    await processEvent(ev("conversation.assigned", { assignedByName: "Dana" }, { userId: "matan" }));
    expect(who(H.inApp)).toEqual(["matan"]);
    expect(H.emails.map((e: any) => e.to)).toEqual([H.users.find((u: any) => u.id === "matan").email]);
  });

  it("an assignment naming nobody, or an event with no built-in route, reaches no one", async () => {
    await processEvent(ev("conversation.assigned"));
    await processEvent(ev("lead.created"));
    expect(H.inApp).toEqual([]);
  });

  it("a workspace rule replaces the built-in route", async () => {
    H.rules = [{ ...rule("tool.approval_required", ["in_app"]), recipients: { type: "users", userIds: ["matan"] } }];
    await processEvent(ev("tool.approval_required"));
    expect(who(H.inApp)).toEqual(["matan"]);
  });

  it("the built-in route respects the person's switches", async () => {
    H.personal = [{ userId: "noa", inApp: false }];
    await processEvent(ev("tool.approval_required"));
    expect(who(H.inApp)).toEqual(["dana"]);
  });
});

describe("★ an automation's Notify team", () => {
  it("skips a person whose in-app switch is off", async () => {
    H.personal = [{ userId: "dana", inApp: false }];
    await processEvent(ev("automation.notify_team", { message: "New VIP lead", userIds: ["dana", "matan"] }));
    expect(who(H.inApp)).toEqual(["matan"]);
  });
});
