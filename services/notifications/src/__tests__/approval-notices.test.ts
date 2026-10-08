/**
 * ★ Approval notices (2026-10-08, six "נדרש אישור" rows for plans already
 * rejected, each saying "GOTCHA asks to run propose_plan"):
 *   - never a tool's raw name: a request is said by its summary; a plan by
 *     who asked, where, and its steps in the reader's words ("you" when it
 *     assigns to them)
 *   - the person who proposed a plan in Home is not told of it
 *   - the row is typed to its request, and opens /approvals?id=...
 *   - when the request is approved, rejected or expires, its notices are read
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ users: [] as any[], inApp: [] as any[], approvals: [] as any[], dedup: new Set<string>(), onEvent: null as null | ((e: any) => void) }));

vi.mock("@chatcenter/shared", async () => ({
  ...(await import("@chatcenter/shared/src/lib/notification-category")),
  resolveEffectiveLocale: async () => ({ effective: "he" }),
  prisma: {
    notificationPreference: { findMany: async () => [] },
    user: { findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && (a.where.role ? u.role === a.where.role : true)) },
    departmentMember: { findMany: async () => [] },
    userNotificationPreference: { findMany: async () => [] },
    approvalRequest: { findFirst: async (a: any) => H.approvals.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId) ?? null },
    inAppNotification: {
      create: async ({ data }: any) => { const row = { id: `n${H.inApp.length}`, createdAt: new Date(), read: false, ...data }; H.inApp.push(row); return row; },
      updateMany: async (a: any) => {
        const hit = H.inApp.filter((r) => r.tenantId === a.where.tenantId && r.targetType === a.where.targetType && r.targetId === a.where.targetId && r.read === a.where.read);
        hit.forEach((r) => Object.assign(r, a.data));
        return { count: hit.length };
      },
    },
  },
  publishEvent: async () => undefined,
  subscribeToEvents: (fn: any) => { H.onEvent = fn; return { quit: async () => undefined }; },
  reportOperationalFailure: () => undefined,
  ERROR_CODES: {},
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
  return { ...actual, getNotificationsQueue: () => ({ add: async () => ({ id: "j" }) }), getNotificationsEmailQueue: () => ({ add: async () => ({ id: "e" }) }) };
});
vi.mock("../services/whatsapp-approval.service", () => ({ notifyManagerOfApproval: async () => undefined }));

import { processEvent } from "../services/notification-engine.service";
import { planOf, resolveApprovalNotices, startNotificationEventBridge } from "../services/event-bridge";
import type { SystemEvent } from "../services/event-emitter.service";

const NEUTRAL = "לשייך ל-Noa את השיחה של Omer Serruya (וואטסאפ)";
const TO_YOU = "לשייך אליך את השיחה של Omer Serruya (וואטסאפ)";
let seq = 0;
const approvalEvent = async (id: string, extra: Record<string, unknown> = {}) => {
  const a = H.approvals.find((r) => r.id === id)!;
  const plan = await planOf("T", id, a.tool);
  return { id: `e${++seq}`, type: "tool.approval_required", tenantId: "T", data: { approvalRequestId: id, tool: a.tool, summary: a.summary, requestedBy: a.requestedBy, ...(plan ? { plan } : {}), ...extra }, metadata: { timestamp: new Date().toISOString(), conversationId: "c1" } } as unknown as SystemEvent;
};
const rowOf = (userId: string) => H.inApp.find((r) => r.userId === userId);

beforeEach(() => {
  H.inApp = []; H.dedup = new Set();
  const u = (id: string, name: string) => ({ id, tenantId: "T", role: "ADMIN", isActive: true, email: `${id}@x.test`, name, notificationSoundEnabled: true });
  H.users = [u("matan", "Matan"), u("noa", "Noa"), u("boss", "Boss")];
  H.approvals = [
    { id: "plan", tenantId: "T", tool: "propose_plan", summary: NEUTRAL, requestedBy: "user:matan",
      params: { steps: [{ tool: "assign_conversation", target: { conversationId: "c1", assigneeId: "noa" }, summary: NEUTRAL, summaryForAssignee: TO_YOU }], requester: { userId: "matan", name: "Matan" }, source: "home_assistant" } },
    { id: "refund", tenantId: "T", tool: "shopify.refund_order", summary: "Refund order #1016 (₪250)", requestedBy: "ai-agent:a1", params: { amount: 250 } },
    { id: "flowed", tenantId: "T", tool: "send_message", summary: "Send Dana the price list", requestedBy: "flow:f1", params: {} },
  ];
});

describe("★ a plan from Home", () => {
  it("the requester is not told; another approver reads who asked and the steps; the assignee reads 'you'", async () => {
    await processEvent(await approvalEvent("plan"));
    expect(rowOf("matan")).toBeUndefined();
    expect(rowOf("boss")).toMatchObject({ title: "נדרש אישור", body: `Matan ביקש/ה מ-GOTCHA ב-Home: ${NEUTRAL}` });
    expect(rowOf("noa")!.body).toBe(`Matan ביקש/ה מ-GOTCHA ב-Home: ${TO_YOU}`);
    expect(JSON.stringify(H.inApp)).not.toMatch(/propose_plan/);
  });

  it("from the command bar, it says so", async () => {
    H.approvals[0].params.source = "command_bar";
    await processEvent(await approvalEvent("plan"));
    expect(rowOf("boss")!.body).toBe(`Matan ביקש/ה מ-GOTCHA בשורת הפקודה: ${NEUTRAL}`);
    expect(rowOf("matan")).toBeUndefined();
  });

  it("a plan proposed elsewhere (no Home source) tells everyone, the requester as 'you asked'", async () => {
    H.approvals[0].params.source = null;
    await processEvent(await approvalEvent("plan"));
    expect(rowOf("matan")!.body).toBe(`ביקשת מ-GOTCHA ב-Home: ${NEUTRAL}`);
  });
});

describe("★ any request: never a raw tool name", () => {
  it("GOTCHA's request by its summary; an automation's as an automation's", async () => {
    await processEvent(await approvalEvent("refund"));
    expect(rowOf("boss")).toMatchObject({ title: "נדרש אישור", body: "GOTCHA מבקשת אישור: Refund order #1016 (₪250)" });
    H.inApp = [];
    await processEvent(await approvalEvent("flowed"));
    expect(rowOf("boss")!.body).toBe("אוטומציה מבקשת אישור: Send Dana the price list");
    expect(JSON.stringify(H.inApp)).not.toMatch(/refund_order|send_message/);
  });
});

describe("★ the notice belongs to its request", () => {
  it("typed to the request and opening it; read when the request is decided or expires, and no other", async () => {
    await processEvent(await approvalEvent("refund"));
    await processEvent(await approvalEvent("flowed"));
    const refundRows = H.inApp.filter((r) => r.targetId === "refund");
    expect(refundRows).toHaveLength(3);
    expect(refundRows[0]).toMatchObject({ targetType: "approval", targetId: "refund", link: "/approvals?id=refund", read: false });
    expect(await resolveApprovalNotices("T", "refund")).toBe(3);
    expect(H.inApp.filter((r) => r.targetId === "refund").every((r) => r.read)).toBe(true);
    // The other request's notices are untouched; another workspace's id resolves nothing.
    expect(H.inApp.filter((r) => r.targetId === "flowed").every((r) => !r.read)).toBe(true);
    expect(await resolveApprovalNotices("OTHER", "flowed")).toBe(0);
  });

  it("planOf reads a plan's steps, who asked and where; anything else is not a plan", async () => {
    expect(await planOf("T", "plan", "propose_plan")).toMatchObject({ requester: { userId: "matan" }, source: "home_assistant" });
    expect(await planOf("T", "refund", "shopify.refund_order")).toBeNull();
    expect(await planOf("OTHER", "plan", "propose_plan")).toEqual({ steps: [], requester: null, source: null });
  });
});

describe("★ the bridge", () => {
  it("approved, rejected or expired: that request's notices are read; created: nothing is resolved", async () => {
    startNotificationEventBridge();
    const notice = (id: string, user: string) => H.inApp.push({ id: `${id}-${user}`, tenantId: "T", userId: user, targetType: "approval", targetId: id, read: false });
    for (const id of ["a1", "a2", "a3", "a4"]) notice(id, "boss");
    const flush = () => new Promise((r) => setTimeout(r, 10));
    H.onEvent!({ event: "approval:approved", tenantId: "T", data: { approvalId: "a1" } });
    H.onEvent!({ event: "approval:rejected", tenantId: "T", data: { approvalId: "a2" } });
    H.onEvent!({ event: "approval:expired", tenantId: "T", data: { approvalId: "a3" } });
    H.onEvent!({ event: "approval:created", tenantId: "T", data: { id: "a4", tool: "x", summary: "y" } });
    await flush();
    expect(H.inApp.filter((r) => r.id.startsWith("a")).map((r) => [r.targetId, r.read])).toEqual([["a1", true], ["a2", true], ["a3", true], ["a4", false]]);
  });
});
