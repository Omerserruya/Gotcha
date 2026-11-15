/**
 * "A customer is waiting for a reply" (2026-11-02). The reply rules live in the
 * sweeper's SQL (checked on Postgres against fake rows: extra inbound does not
 * reset the clock, a reply ends the period, System/holding lines are not
 * replies, closed is skipped). Here: the SLA, the department override, one
 * alert per period across sweeps, a new period alerts again, the recipients,
 * the lock, and the event's route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ kv: new Map<string, string>(), settings: new Map<string, string>(), members: [] as any[], emitted: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await import("./helpers/platform-sender-double")).platformSenderDouble,
  ...(await importOriginal<any>()),
  getRedis: () => ({ set: async (k: string, v: string, ...a: any[]) => { if (a.includes("NX") && H.kv.has(k)) return null; H.kv.set(k, v); return "OK"; } }),
  readDurableSetting: async (_t: string, k: string) => H.settings.get(k) ?? null,
  withCrossTenantAccess: (fn: any) => fn(),
  prisma: { departmentMember: { findMany: async () => H.members } },
}));
vi.mock("../services/event-emitter.service", () => ({ tryEmit: (e: any) => { H.emitted.push(e); } }));

import { sweepWaiting, isOverdue, slaFor, type WaitingRow } from "../services/waiting-alert.service";
import { defaultRoute } from "../services/notification-engine.service";

const NOW = new Date("2026-11-02T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const row = (o: Partial<WaitingRow> = {}): WaitingRow => ({ id: "c1", tenantId: "T", departmentId: null, assignedAgentId: null, channel: "WEBCHAT", waitingSince: minsAgo(40), ...o });
const sweep = (rows: WaitingRow[], at = NOW) => { H.kv.delete("notify:waiting-sweep:lock"); return sweepWaiting(at, async () => rows); };

beforeEach(() => { H.kv.clear(); H.settings.clear(); H.members = []; H.emitted = []; H.settings.set("sla", JSON.stringify({ enabled: true, slaMinutes: 30 })); });

describe("the SLA", () => {
  it("past the minutes with the SLA on: overdue; before it, or off: not", () => {
    expect(isOverdue(row(), { enabled: true, slaMinutes: 30 }, NOW)).toBe(true);
    expect(isOverdue(row({ waitingSince: minsAgo(10) }), { enabled: true, slaMinutes: 30 }, NOW)).toBe(false);
    expect(isOverdue(row(), { enabled: false, slaMinutes: 30 }, NOW)).toBe(false);
    expect(isOverdue(row(), null, NOW)).toBe(false);
  });
  it("a department's own SLA wins over the workspace's", async () => {
    H.settings.set("department:d1:sla", JSON.stringify({ enabled: true, slaMinutes: 5 }));
    expect(await slaFor("T", "d1")).toEqual({ enabled: true, slaMinutes: 5 });
    expect(await slaFor("T", "d2")).toEqual({ enabled: true, slaMinutes: 30 });
  });
});

describe("the sweep", () => {
  it("ONE alert per waiting period, across sweeps", async () => {
    expect(await sweep([row()])).toBe(1);
    expect(await sweep([row()], new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(H.emitted).toHaveLength(1);
    expect(H.emitted[0]).toMatchObject({ type: "conversation.waiting", tenantId: "T", data: { conversationId: "c1", minutes: 40, channel: "WEBCHAT" }, metadata: { conversationId: "c1" } });
  });
  it("a reply then a new unanswered message is a new period: alerts again", async () => {
    await sweep([row()]);
    expect(await sweep([row({ waitingSince: minsAgo(31) })])).toBe(1);
  });
  it("the department override decides: a 5-minute department alerts at 10 minutes, the workspace's 30 does not", async () => {
    H.settings.set("department:d1:sla", JSON.stringify({ enabled: true, slaMinutes: 5 }));
    expect(await sweep([row({ id: "a", departmentId: "d1", waitingSince: minsAgo(10) }), row({ id: "b", departmentId: null, waitingSince: minsAgo(10) })])).toBe(1);
    expect(H.emitted[0].data.conversationId).toBe("a");
  });
  it("SLA off: nothing", async () => {
    H.settings.set("sla", JSON.stringify({ enabled: false, slaMinutes: 30 }));
    expect(await sweep([row()])).toBe(0);
  });
  it("recipients: the assignee; else the department's members; else none (the admins)", async () => {
    H.members = [{ userId: "m1" }, { userId: "m2" }];
    await sweep([row({ id: "x", assignedAgentId: "u7" }), row({ id: "y", departmentId: "d1" }), row({ id: "z" })]);
    expect(H.emitted.map((e) => e.data.recipientUserIds)).toEqual([["u7"], ["m1", "m2"], []]);
  });
  it("another sweeper holding the lock: this one does nothing", async () => {
    H.kv.set("notify:waiting-sweep:lock", "1");
    expect(await sweepWaiting(NOW, async () => [row()])).toBe(0);
  });
});

describe("the route", () => {
  const ev = (ids: string[]) => ({ id: "e", type: "conversation.waiting", tenantId: "T", data: { recipientUserIds: ids }, metadata: { timestamp: "" } }) as any;
  it("in-app and email to the resolved people; the admins when none", () => {
    expect(defaultRoute(ev(["u7"]))).toMatchObject({ channels: ["in_app", "email"], recipients: { type: "users", userIds: ["u7"] } });
    expect(defaultRoute(ev([]))).toMatchObject({ recipients: { type: "tenant_owner" } });
  });
});
