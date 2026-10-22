import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────
//
// Vitest needs vi.mock() factories to be top-level and self-contained.
// We use vi.hoisted() to share the prismaMock + queueMock instances between
// the factory and the test bodies.

const { prismaMock, redisMock, emailQueueMock, publishEventMock } = vi.hoisted(() => {
  const inAppRows: any[] = [];
  return {
    prismaMock: {
      notificationPreference: {
        findMany: vi.fn(),
      },
      // Personal settings (design 15): none saved = the defaults.
      userNotificationPreference: {
        findMany: vi.fn(async () => []),
      },
      user: {
        findMany: vi.fn(),
      },
      departmentMember: {
        findMany: vi.fn(),
      },
      inAppNotification: {
        create: vi.fn(async ({ data }: { data: any }) => {
          const row = { id: `notif-${inAppRows.length + 1}`, createdAt: new Date(), read: false, ...data };
          inAppRows.push(row);
          return row;
        }),
      },
      __inAppRows: inAppRows,
    },
    redisMock: {
      // SET key value EX ttl NX → returns "OK" first time, null afterwards.
      _store: new Set<string>(),
      set: vi.fn(async function (this: any, key: string, _val: string, _ex: string, _ttl: number, mode: string) {
        if (mode === "NX") {
          if (this._store.has(key)) return null;
          this._store.add(key);
          return "OK";
        }
        return "OK";
      }),
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      ttl: vi.fn(async () => 60),
    },
    emailQueueMock: {
      add: vi.fn(async () => ({ id: "job-email-1" })),
    },
    publishEventMock: vi.fn(async () => undefined),
  };
});

vi.mock("@chatcenter/shared", async () => ({
  // The real (pure, import-free) category/target rules: an exhaustive mock that
  // omitted them made every in-app delivery throw inside deliverChannel's
  // catch, so these tests failed while the code worked.
  ...(await import("@chatcenter/shared/src/lib/notification-category")),
  prisma: prismaMock,
  publishEvent: publishEventMock,
  getRedis: () => redisMock,
  readDurableSetting: async () => null,
  parseBusinessHours: () => null,
  // The queue name is declared in shared now that billing fills this queue too.
  // queues.ts imports it from there, so the mock has to carry it.
  NOTIFICATIONS_EMAIL_QUEUE_NAME: "notifications-email",
}));

vi.mock("../services/queues", async () => {
  const actual = await vi.importActual<any>("../services/queues");
  return {
    ...actual,
    getNotificationsQueue: () => ({ add: vi.fn(async () => ({ id: "job-1" })) }),
    getNotificationsEmailQueue: () => emailQueueMock,
  };
});

// ─── Imports AFTER mocks are registered ────────────────────

import { processEvent, evaluateConditions } from "../services/notification-engine.service";
import type { SystemEvent } from "../services/event-emitter.service";

beforeEach(() => {
  prismaMock.notificationPreference.findMany.mockReset();
  prismaMock.user.findMany.mockReset();
  prismaMock.departmentMember.findMany.mockReset();
  prismaMock.inAppNotification.create.mockClear();
  (prismaMock as any).__inAppRows.length = 0;
  emailQueueMock.add.mockClear();
  publishEventMock.mockClear();
  (redisMock as any)._store = new Set<string>();
});

// ─── Conditions DSL ────────────────────────────────────────

describe("evaluateConditions", () => {
  it("passes when no conditions are set", () => {
    expect(evaluateConditions(undefined, { x: 1 })).toBe(true);
    expect(evaluateConditions(null, { x: 1 })).toBe(true);
    expect(evaluateConditions([], { x: 1 })).toBe(true);
  });

  it("supports eq / gt / contains", () => {
    const data = { valueEstimate: 25_000, name: "Acme Corp", tags: ["vip", "lead"] };
    expect(evaluateConditions([{ field: "valueEstimate", op: "gt", value: 10_000 }], data)).toBe(true);
    expect(evaluateConditions([{ field: "valueEstimate", op: "gt", value: 30_000 }], data)).toBe(false);
    expect(evaluateConditions([{ field: "name", op: "contains", value: "Acme" }], data)).toBe(true);
    expect(evaluateConditions([{ field: "tags", op: "contains", value: "vip" }], data)).toBe(true);
    expect(evaluateConditions([{ field: "tags", op: "contains", value: "ghost" }], data)).toBe(false);
  });

  it("ANDs multiple conditions - fails fast on first mismatch", () => {
    const data = { v: 10, kind: "lead" };
    expect(
      evaluateConditions(
        [
          { field: "v", op: "gte", value: 5 },
          { field: "kind", op: "eq", value: "lead" },
        ],
        data,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        [
          { field: "v", op: "gte", value: 5 },
          { field: "kind", op: "eq", value: "deal" },
        ],
        data,
      ),
    ).toBe(false);
  });
});

// ─── processEvent end-to-end (with mocked queue + prisma) ──

describe("processEvent", () => {
  function makeEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
    return {
      id: "evt-1",
      type: "lead.created",
      tenantId: "tenant-A",
      data: { name: "Acme Corp", valueEstimate: 25_000 },
      metadata: { timestamp: new Date().toISOString() },
      ...overrides,
    } as SystemEvent;
  }

  it("creates an InAppNotification row AND enqueues an email job for tenant_owner recipient", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      {
        id: "pref-1",
        tenantId: "tenant-A",
        departmentId: null,
        eventType: "lead.created",
        enabled: true,
        conditions: null,
        recipients: { type: "tenant_owner" },
        channels: ["email", "in_app"],
        priority: "HIGH",
      },
    ]);
    prismaMock.user.findMany.mockResolvedValueOnce([
      {
        id: "user-admin",
        tenantId: "tenant-A",
        email: "admin@acme.test",
        name: "Admin",
        notificationSoundEnabled: true,
      },
    ]);

    await processEvent(makeEvent());

    // In-app row was created
    expect(prismaMock.inAppNotification.create).toHaveBeenCalledTimes(1);
    const createCall = (prismaMock.inAppNotification.create.mock.calls as any[])[0] as any[];
    expect(createCall[0].data.userId).toBe("user-admin");
    expect(createCall[0].data.eventType).toBe("lead.created");

    // Email job was enqueued
    expect(emailQueueMock.add).toHaveBeenCalledTimes(1);
    const call = (emailQueueMock.add.mock.calls as any[])[0] as any[];
    const jobName = call[0];
    const payload = call[1];
    expect(jobName).toBe("send-email");
    expect(payload.to).toBe("admin@acme.test");
    expect(payload.tenantId).toBe("tenant-A");
    expect(payload.subject).toContain("Acme Corp");

    // Real-time pub/sub fired for the in-app notification
    expect(publishEventMock).toHaveBeenCalled();
    const pubArgs = (publishEventMock.mock.calls as any[])[0] as any[];
    expect(pubArgs[0].event).toBe("notification:created");
  });

  it("skips when conditions don't match", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      {
        id: "pref-2",
        tenantId: "tenant-A",
        departmentId: null,
        eventType: "lead.created",
        enabled: true,
        conditions: [{ field: "valueEstimate", op: "gt", value: 100_000 }],
        recipients: { type: "tenant_owner" },
        channels: ["email"],
        priority: "MEDIUM",
      },
    ]);

    await processEvent(makeEvent({ data: { valueEstimate: 25_000 } }));

    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
    expect(emailQueueMock.add).not.toHaveBeenCalled();
    expect(prismaMock.inAppNotification.create).not.toHaveBeenCalled();
  });

  it("dedupes identical events within the TTL window", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([
      {
        id: "pref-3",
        tenantId: "tenant-A",
        departmentId: null,
        eventType: "lead.created",
        enabled: true,
        conditions: null,
        recipients: { type: "tenant_owner" },
        channels: ["in_app"],
        priority: "MEDIUM",
      },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-admin", tenantId: "tenant-A", email: "a@x.test", name: "A", notificationSoundEnabled: true },
    ]);

    const ev1 = makeEvent({ id: "evt-A", data: { name: "Same", valueEstimate: 1 } });
    const ev2 = makeEvent({ id: "evt-B", data: { name: "Same", valueEstimate: 1 } });

    await processEvent(ev1);
    await processEvent(ev2);

    // Only the first event delivers; the second is deduped at the Redis layer.
    expect(prismaMock.inAppNotification.create).toHaveBeenCalledTimes(1);
  });

  it("prefers department-scoped preference over tenant-default when both match", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      // Department-scoped (more specific)
      {
        id: "pref-dept",
        tenantId: "tenant-A",
        departmentId: "dept-1",
        eventType: "lead.created",
        enabled: true,
        conditions: null,
        recipients: { type: "users", userIds: ["user-dept"] },
        channels: ["in_app"],
        priority: "HIGH",
      },
      // Tenant-default (should be dropped)
      {
        id: "pref-tenant",
        tenantId: "tenant-A",
        departmentId: null,
        eventType: "lead.created",
        enabled: true,
        conditions: null,
        recipients: { type: "tenant_owner" },
        channels: ["in_app"],
        priority: "MEDIUM",
      },
    ]);
    prismaMock.user.findMany.mockResolvedValueOnce([
      { id: "user-dept", tenantId: "tenant-A", email: "d@x.test", name: "D", notificationSoundEnabled: true },
    ]);

    await processEvent(makeEvent({ departmentId: "dept-1" }));

    // Only the department-scoped recipient was used.
    expect(prismaMock.inAppNotification.create).toHaveBeenCalledTimes(1);
    const createCall2 = (prismaMock.inAppNotification.create.mock.calls as any[])[0] as any[];
    expect(createCall2[0].data.userId).toBe("user-dept");
  });
});

// ─── An automation's "Notify team" (direct-addressed, no preferences) ──

describe("★ automation.notify_team", () => {
  const ev = (data: any) => ({ id: `evt-auto-${Math.random()}`, type: "automation.notify_team", tenantId: "tenant-A", data, metadata: { timestamp: new Date().toISOString() } }) as any;
  const user = (id: string) => ({ id, tenantId: "tenant-A", email: `${id}@x.test`, name: id, notificationSoundEnabled: true });

  beforeEach(() => {
    prismaMock.inAppNotification.create.mockClear();
    prismaMock.notificationPreference.findMany.mockClear();
    prismaMock.user.findMany.mockReset();
    prismaMock.departmentMember.findMany.mockReset();
  });

  it("reaches the chosen people in-app, tenant-scoped, without consulting preferences", async () => {
    prismaMock.user.findMany.mockResolvedValueOnce([user("u1")]);
    await processEvent(ev({ message: "Call back Dana", userIds: ["u1", "foreign"], conversationId: "c1" }));
    expect(prismaMock.notificationPreference.findMany).not.toHaveBeenCalled();
    expect((prismaMock.user.findMany.mock.calls as any[])[0][0].where).toMatchObject({ tenantId: "tenant-A", id: { in: ["u1", "foreign"] }, isActive: true });
    const rows = (prismaMock.inAppNotification.create.mock.calls as any[]).map((c) => c[0].data);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u1", title: "Automation", body: "Call back Dana", link: "/inbox?c=c1" });
  });

  it("a department reaches its active members; nobody chosen reaches the admins", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValueOnce([{ user: { ...user("d1"), isActive: true } }, { user: { ...user("d2"), isActive: false } }]);
    await processEvent(ev({ message: "New lead", departmentId: "sales" }));
    expect((prismaMock.inAppNotification.create.mock.calls as any[]).map((c) => c[0].data.userId)).toEqual(["d1"]);

    prismaMock.inAppNotification.create.mockClear();
    prismaMock.user.findMany.mockResolvedValueOnce([user("admin")]);
    await processEvent(ev({ message: "Daily report" }));
    expect((prismaMock.user.findMany.mock.calls as any[]).at(-1)[0].where).toMatchObject({ role: "ADMIN" });
    expect((prismaMock.inAppNotification.create.mock.calls as any[]).map((c) => c[0].data.userId)).toEqual(["admin"]);
  });

  it("an empty message notifies no one", async () => {
    await processEvent(ev({ message: "  ", userIds: ["u1"] }));
    expect(prismaMock.inAppNotification.create).not.toHaveBeenCalled();
  });
});
