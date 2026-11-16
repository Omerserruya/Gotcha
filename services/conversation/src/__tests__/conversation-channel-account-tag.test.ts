/**
 * The inbox tags which number a conversation is on (prod GOTCHA 2026-11-16:
 * two WhatsApp numbers on one tenant, and nobody could tell which thread
 * belonged to which). Both the list and the single conversation carry
 * `channelAccount: { id, channel, displayName, multipleOfChannel }`, never the
 * account's credentials. The prisma double applies the include's select.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  conversations: [] as any[],
  messages: [] as any[],
  findManyArgs: [] as any[],
  messageQueries: 0,
  accounts: [] as any[],
  groupByFails: false,
}));

/** A relation include's select, applied as Prisma would (absent fields stay absent). */
function pick(row: any, select: any) {
  if (!row) return null;
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

/** The nested `messages` include, evaluated the way Prisma would. */
function lastMessages(convId: string, inc: any): any[] {
  let rows = H.messages.filter((m) => m.conversationId === convId);
  const notStatus = inc.where?.status?.not;
  if (notStatus !== undefined) rows = rows.filter((m) => m.status !== notStatus);
  if (inc.orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (inc.orderBy?.createdAt === "asc") rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (typeof inc.take === "number") rows = rows.slice(0, inc.take);
  if (!inc.select) return rows;
  return rows.map((m) => Object.fromEntries(Object.keys(inc.select).filter((k) => inc.select[k]).map((k) => [k, m[k]])));
}

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  latestHandover: async () => null,
  getInternalServiceKey: () => "k",
  readDurableSetting: async () => null,
  recordHandover: async () => undefined,
  publishEvent: async () => undefined,
  withHistoricalRecords: (x: any) => x,
  outgoingMessageQueue: { add: async () => undefined },
  notificationsQueue: { add: async () => undefined },
  prisma: {
    contact: { findMany: async () => [] },
    // A per-row lookup would land here: the list must never call it.
    message: {
      findMany: async () => { H.messageQueries++; return []; },
      findFirst: async () => { H.messageQueries++; return null; },
    },
    conversation: {
      findMany: async (a: any) => {
        H.findManyArgs.push(a);
        const rows = H.conversations
          .filter((c) => c.tenantId === a.where.tenantId)
          .sort((x, y) => (y.lastMessageAt?.getTime() ?? -Infinity) - (x.lastMessageAt?.getTime() ?? -Infinity));
        return rows.slice(0, a.take).map((c) => ({
          ...c,
          assignedAgent: null,
          department: null,
          ...(a.include?.channelAccount ? { channelAccount: pick(H.accounts.find((x) => x.id === c.channelAccountId), a.include.channelAccount.select) } : {}),
          _count: { messages: H.messages.filter((m) => m.conversationId === c.id).length },
          messages: lastMessages(c.id, a.include.messages),
        }));
      },
      count: async (a: any) => H.conversations.filter((c) => c.tenantId === a.where.tenantId).length,
      findFirst: async (a: any) => {
        const c = H.conversations.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId);
        if (!c) return null;
        return { ...c, assignedAgent: null, department: null, messages: [],
          ...(a.include?.channelAccount ? { channelAccount: pick(H.accounts.find((x) => x.id === c.channelAccountId), a.include.channelAccount.select) } : {}) };
      },
    },
    channelAccount: {
      groupBy: async (a: any) => {
        if (H.groupByFails) throw new Error("db down");
        const rows = H.accounts.filter((x) => x.tenantId === a.where.tenantId && (a.where.isActive === undefined || x.isActive === a.where.isActive));
        const by = new Map<string, number>();
        for (const r of rows) by.set(r.channel, (by.get(r.channel) ?? 0) + 1);
        return [...by].map(([channel, n]) => ({ channel, _count: { _all: n } }));
      },
    },
  },
}));

vi.mock("../lib/socket", () => ({ getIO: () => null }));

import router from "../routes/conversations";

const app = express();
app.use("/api/conversations", router);


const conv = (id: string, account: string | null) => ({
  id, tenantId: "T", channel: "WHATSAPP", customerExternalId: `ext-${id}`, status: "OPEN", channelAccountId: account, lastMessageAt: new Date(),
});
const acc = (id: string, displayName: string, o: any = {}) => ({
  id, tenantId: "T", channel: "WHATSAPP", displayName, isActive: true, externalId: `pn-${id}`, credentials: { accessToken: "SECRET-TOKEN" }, ...o,
});

beforeEach(() => {
  H.conversations = [];
  H.messages = [];
  H.findManyArgs = [];
  H.accounts = [];
  H.groupByFails = false;
});

describe("conversation rows say which number they are on", () => {
  it("★ two WhatsApp numbers: each row names its own number, multipleOfChannel true, no credentials", async () => {
    H.accounts = [acc("sales", "GOTCHA"), acc("matan", "Gotcha")];
    H.conversations = [conv("c1", "sales"), conv("c2", "matan")];
    for (const path of ["/api/conversations?cursor=", "/api/conversations"]) {
      const r = await request(app).get(path);
      expect(r.status).toBe(200);
      const byId = Object.fromEntries(r.body.data.map((c: any) => [c.id, c]));
      expect(byId.c1.channelAccount).toEqual({ id: "sales", channel: "WHATSAPP", displayName: "GOTCHA", multipleOfChannel: true });
      expect(byId.c2.channelAccount).toEqual({ id: "matan", channel: "WHATSAPP", displayName: "Gotcha", multipleOfChannel: true });
      expect(JSON.stringify(r.body)).not.toContain("SECRET-TOKEN");
    }
  });

  it("one number of the channel: the name is there, multipleOfChannel false", async () => {
    H.accounts = [acc("sales", "GOTCHA"), acc("ig", "gotcha.ig", { channel: "INSTAGRAM" }), acc("old", "Old", { isActive: false })];
    H.conversations = [conv("c1", "sales")];
    const r = await request(app).get("/api/conversations");
    expect(r.body.data[0].channelAccount).toMatchObject({ displayName: "GOTCHA", multipleOfChannel: false });
  });

  it("a detached conversation: channelAccount null, the row still loads", async () => {
    H.accounts = [acc("sales", "GOTCHA"), acc("matan", "Gotcha")];
    H.conversations = [conv("c1", null)];
    const r = await request(app).get("/api/conversations");
    expect(r.status).toBe(200);
    expect(r.body.data[0].channelAccount).toBeNull();
  });

  it("the account counts unreadable: rows still load, the flag is false", async () => {
    H.accounts = [acc("sales", "GOTCHA"), acc("matan", "Gotcha")];
    H.conversations = [conv("c1", "sales")];
    H.groupByFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await request(app).get("/api/conversations");
    warn.mockRestore();
    expect(r.status).toBe(200);
    expect(r.body.data[0].channelAccount).toMatchObject({ id: "sales", multipleOfChannel: false });
  });

  it("GET /:id carries the same tag (plus the number's provider id), never credentials", async () => {
    H.accounts = [acc("sales", "GOTCHA"), acc("matan", "Gotcha")];
    H.conversations = [conv("c2", "matan")];
    const r = await request(app).get("/api/conversations/c2");
    expect(r.status).toBe(200);
    expect(r.body.data.channelAccount).toEqual({ id: "matan", channel: "WHATSAPP", displayName: "Gotcha", multipleOfChannel: true, externalId: "pn-matan" });
    expect(JSON.stringify(r.body)).not.toContain("SECRET-TOKEN");
  });
});
