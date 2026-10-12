/**
 * Every list row says since when the customer has waited for a reply
 * (2026-10-12), for the inbox's SLA dot: one batched read for the page, null
 * when nobody is waiting, and the list still loads if the read fails.
 *
 * The rule itself is SQL (lib/waiting-since.ts); it was checked against the
 * real dev Postgres, every conversation compared with the same rule computed
 * from its messages, since a JS double of SQL proves nothing about the SQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  rows: [] as any[],
  waiting: new Map<string, string | null>(),
  calls: [] as any[],
  fail: false,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: {
        findMany: vi.fn(async (a: any) => (a.select ? H.rows.map((r) => ({ id: r.id })) : H.rows.map((r) => ({ ...r, messages: [] })))),
        count: vi.fn(async () => H.rows.length),
      },
    },
    readDurableSetting: async () => null,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "AGENT", departmentId: "d1" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../lib/require-visible-conversation", () => ({ requireVisibleConversation: (_q: any, _s: any, n: any) => n() }));
vi.mock("../lib/conversation-contact", () => ({ contactIdsFor: async () => new Map(), contactIdOf: () => null }));
vi.mock("../lib/unread-state", () => ({ unreadStates: async () => new Map() }));
vi.mock("../lib/waiting-since", () => ({
  waitingSinceFor: vi.fn(async (tenantId: string, ids: string[]) => {
    H.calls.push({ tenantId, ids });
    if (H.fail) throw new Error("db down");
    return new Map(ids.filter((id) => H.waiting.has(id)).map((id) => [id, H.waiting.get(id)!]));
  }),
}));

import conversationsRouter from "../routes/conversations";
const app = express();
app.use(express.json());
app.use("/conversations", conversationsRouter);

beforeEach(() => {
  H.rows = [
    { id: "c1", tenantId: "t1", lastMessageAt: new Date("2026-10-12T10:00:00Z") },
    { id: "c2", tenantId: "t1", lastMessageAt: new Date("2026-10-12T09:00:00Z") },
    { id: "c3", tenantId: "t1", lastMessageAt: new Date("2026-10-12T08:00:00Z") },
  ];
  H.waiting = new Map([["c1", "2026-10-12T09:41:00.000Z"], ["c2", null]]);
  H.calls = [];
  H.fail = false;
});

describe("list rows carry waitingSince", () => {
  it("on every row, from ONE batched read for the page, under the tenant", async () => {
    const res = await request(app).get("/conversations?cursor=&view=queue");
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => [r.id, r.waitingSince])).toEqual([
      ["c1", "2026-10-12T09:41:00.000Z"],
      ["c2", null],
      ["c3", null],
    ]);
    expect(H.calls).toEqual([{ tenantId: "t1", ids: ["c1", "c2", "c3"] }]);
  });

  it("the offset list carries it too", async () => {
    const res = await request(app).get("/conversations?page=1&limit=20");
    expect(res.status).toBe(200);
    expect(res.body.data[0].waitingSince).toBe("2026-10-12T09:41:00.000Z");
  });

  it("decoration: if the read fails, the list loads and nobody is shown waiting", async () => {
    H.fail = true;
    const res = await request(app).get("/conversations?cursor=&view=queue");
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.waitingSince === null)).toBe(true);
  });
});
