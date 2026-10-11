/**
 * The READ side of per-person unread (2026-10-11): 7b69c714 wrote
 * ConversationReadState and nothing read it.
 *
 *   - every list row carries the VIEWER's unread, unreadCount, lastReadAt
 *   - GET /unread-counts counts exactly the list's rows (same filters and
 *     visibility: the where is captured from both doors and compared)
 *   - opening (DELETE /:id/unread) and marking (POST) tell the viewer's own
 *     other tabs, and nobody else
 *
 * The unread rule itself is SQL (lib/unread-state.ts); it was checked against
 * the real dev Postgres inside a rolled-back transaction, since a JS double of
 * SQL proves nothing about the SQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "u1", role: "AGENT", departmentId: "d1" } as any,
  rows: [] as any[],
  findManyWhere: [] as any[],
  states: new Map<string, any>(),
  statesCalls: [] as any[],
  emits: [] as Array<{ room: string; event: string; data: any }>,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: {
        findMany: vi.fn(async (a: any) => { H.findManyWhere.push(a.where); return a.select ? H.rows.map((r) => ({ id: r.id })) : H.rows.map((r) => ({ ...r, messages: [] })); }),
        count: vi.fn(async () => H.rows.length),
        findFirst: vi.fn(async (a: any) => H.rows.find((r) => r.id === a.where.id && r.tenantId === a.where.tenantId) ?? null),
      },
      conversationReadState: {
        upsert: vi.fn(async (a: any) => ({ ...a.create, ...a.update })),
      },
    },
    readDurableSetting: async () => null,
    authenticate: (req: any, _r: any, n: any) => { req.user = H.viewer; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../lib/require-visible-conversation", () => ({ requireVisibleConversation: (_q: any, _s: any, n: any) => n() }));
vi.mock("../lib/conversation-contact", () => ({ contactIdsFor: async () => new Map(), contactIdOf: () => null }));
vi.mock("../lib/unread-state", () => ({
  unreadStates: vi.fn(async (tenantId: string, userId: string, ids: string[]) => {
    H.statesCalls.push({ tenantId, userId, ids });
    return new Map(ids.filter((id) => H.states.has(id)).map((id) => [id, H.states.get(id)]));
  }),
}));
vi.mock("../lib/socket", () => ({
  getIO: () => ({ to: (room: string) => ({ emit: (event: string, data: any) => { H.emits.push({ room, event, data }); return true; } }) }),
}));

import conversationsRouter from "../routes/conversations";

const app = express();
app.use(express.json());
app.use("/conversations", conversationsRouter);

beforeEach(() => {
  H.viewer = { userId: "u1", role: "AGENT", departmentId: "d1" };
  H.rows = [
    { id: "c1", tenantId: "t1", lastMessageAt: new Date("2026-10-11T10:00:00Z") },
    { id: "c2", tenantId: "t1", lastMessageAt: new Date("2026-10-11T09:00:00Z") },
    { id: "c3", tenantId: "t1", lastMessageAt: new Date("2026-10-11T08:00:00Z") },
  ];
  H.findManyWhere = [];
  H.statesCalls = [];
  H.emits = [];
  H.states = new Map([
    ["c1", { unread: true, unreadCount: 3, lastReadAt: "2026-10-11T09:30:00.000Z" }],
    ["c2", { unread: false, unreadCount: 0, lastReadAt: "2026-10-11T09:10:00.000Z" }],
    ["c3", { unread: true, unreadCount: 0, lastReadAt: null }],
  ]);
});

describe("list rows carry the viewer's unread", () => {
  it("unread, unreadCount and lastReadAt on every row, from ONE batched read for the page", async () => {
    const res = await request(app).get("/conversations?cursor=&view=queue");

    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => [r.id, r.unread, r.unreadCount, r.lastReadAt])).toEqual([
      ["c1", true, 3, "2026-10-11T09:30:00.000Z"],
      ["c2", false, 0, "2026-10-11T09:10:00.000Z"],
      ["c3", true, 0, null],
    ]);
    expect(H.statesCalls).toEqual([{ tenantId: "t1", userId: "u1", ids: ["c1", "c2", "c3"] }]);
  });

  it("a row with no state is read, count 0", async () => {
    H.states = new Map();
    const res = await request(app).get("/conversations?cursor=");
    expect(res.body.data[0]).toMatchObject({ unread: false, unreadCount: 0, lastReadAt: null });
  });
});

describe("GET /unread-counts", () => {
  // The list query each v2 view sends (frontend-v2 inbox-views.ts viewQuery).
  const LIST_QUERY: Record<string, string> = {
    queue: "view=queue",
    mine: "assignedAgentId=u1&includeAutomated=true",
    active: "status=OPEN",
    gotcha: "automatedOnly=true",
    all: "includeAutomated=true",
  };

  it("counts the unread among exactly the rows the list returns, view by view", async () => {
    for (const [view, q] of Object.entries(LIST_QUERY)) {
      H.findManyWhere = [];
      await request(app).get(`/conversations?cursor=&${q}`);
      const listWhere = H.findManyWhere[0];
      H.findManyWhere = [];
      const res = await request(app).get(`/conversations/unread-counts?views=${view}`);
      expect(res.status, view).toBe(200);
      // Same filters, same visibility. The list adds only its cursor, and an
      // empty cursor adds nothing.
      expect(H.findManyWhere[0], view).toEqual(listWhere);
      expect(res.body.data, view).toEqual({ [view]: 2, totals: { [view]: 3 } });
    }
  });

  it("several views in one call, one unread read for all their rows", async () => {
    const res = await request(app).get("/conversations/unread-counts?views=queue,mine,active");
    expect(res.body.data).toEqual({ queue: 2, mine: 2, active: 2, totals: { queue: 3, mine: 3, active: 3 } });
    expect(H.statesCalls).toHaveLength(1);
  });

  it("is not swallowed by /:id, and refuses an unknown view", async () => {
    const res = await request(app).get("/conversations/unread-counts?views=queue,bogus");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("bogus");
  });

  it("is the viewer's: another person's id is never asked about", async () => {
    H.viewer = { userId: "u2", role: "AGENT", departmentId: "d1" };
    await request(app).get("/conversations/unread-counts?views=mine");
    expect(H.statesCalls[0].userId).toBe("u2");
    expect(JSON.stringify(H.findManyWhere[0])).toContain("\"assignedAgentId\":\"u2\"");
  });
});

describe("GET /unread-counts totals", () => {
  // Each view's total is what its list reports as viewTotal: the same where.
  const LIST_QUERY: Record<string, string> = {
    queue: "view=queue",
    mine: "assignedAgentId=u1&includeAutomated=true",
    active: "status=OPEN",
    gotcha: "automatedOnly=true",
    all: "includeAutomated=true",
  };

  it("totals[view] == the list's viewTotal, counted on the same where", async () => {
    const { prisma } = await import("@chatcenter/shared");
    for (const [view, q] of Object.entries(LIST_QUERY)) {
      // A different size per view, so a total taken from the wrong view shows.
      H.rows = H.rows.slice(0, 1 + (Object.keys(LIST_QUERY).indexOf(view) % 3));
      (prisma.conversation.count as any).mockClear();
      const list = await request(app).get(`/conversations?cursor=&total=1&${q}`);
      const countWhere = (prisma.conversation.count as any).mock.calls.map((c: any[]) => c[0].where).find((w: any) => !("lastMessageAt" in w));
      H.findManyWhere = [];
      const counts = await request(app).get(`/conversations/unread-counts?views=${view}`);
      expect(counts.body.data.totals[view], view).toBe(list.body.viewTotal);
      expect(H.findManyWhere[0], view).toEqual(countWhere);
      H.rows = [
        { id: "c1", tenantId: "t1", lastMessageAt: new Date("2026-10-11T10:00:00Z") },
        { id: "c2", tenantId: "t1", lastMessageAt: new Date("2026-10-11T09:00:00Z") },
        { id: "c3", tenantId: "t1", lastMessageAt: new Date("2026-10-11T08:00:00Z") },
      ];
    }
  });
});

describe("GET /unread-counts totals, several views at once", () => {
  it("each view's total is its own, not another view's", async () => {
    const { prisma } = await import("@chatcenter/shared");
    // "active" (status OPEN) holds one conversation; the others hold three.
    (prisma.conversation.findMany as any).mockImplementation(async (a: any) => {
      H.findManyWhere.push(a.where);
      const rows = JSON.stringify(a.where).includes('"status":"OPEN"') ? H.rows.slice(0, 1) : H.rows;
      return a.select ? rows.map((r) => ({ id: r.id })) : rows.map((r) => ({ ...r, messages: [] }));
    });
    const res = await request(app).get("/conversations/unread-counts?views=active,all");
    expect(res.body.data.totals).toEqual({ active: 1, all: 3 });
    expect(res.body.data).toMatchObject({ active: 1, all: 2 });
  });
});

describe("opening and marking tell the viewer's other tabs, and nobody else", () => {
  it("DELETE /:id/unread (opened = read): conversation:updated to user:<viewer> only", async () => {
    H.states.set("c1", { unread: false, unreadCount: 0, lastReadAt: "2026-10-11T11:00:00.000Z" });
    const res = await request(app).delete("/conversations/c1/unread");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ markedUnread: false });
    expect(res.body.data.lastReadAt).toBeTruthy();
    expect(H.emits).toEqual([{
      room: "user:u1",
      event: "conversation:updated",
      data: { id: "c1", conversationId: "c1", tenantId: "t1", unread: false, unreadCount: 0, lastReadAt: "2026-10-11T11:00:00.000Z", markedUnread: false },
    }]);
  });

  it("POST /:id/unread: the same push, unread", async () => {
    H.states.set("c2", { unread: true, unreadCount: 0, lastReadAt: "2026-10-11T09:10:00.000Z" });
    await request(app).post("/conversations/c2/unread");
    expect(H.emits).toEqual([expect.objectContaining({ room: "user:u1", data: expect.objectContaining({ id: "c2", unread: true, markedUnread: true }) })]);
  });
});

describe("unread is decoration", () => {
  it("if the unread read fails, the list still loads and its rows are read", async () => {
    const { unreadStates } = await import("../lib/unread-state");
    (unreadStates as any).mockRejectedValueOnce(new Error("db blip"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).get("/conversations?cursor=");

    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => r.unread)).toEqual([false, false, false]);
  });
});
