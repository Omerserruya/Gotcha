/**
 * The inbox row says WHAT KIND the last message was (2026-10-09).
 *
 * The preview showed the adapter's filler ("[Image]", "[Voice message]",
 * "[Shared location: ...]") because the last message was selected as only
 * {direction, body, createdAt}. The row now carries `lastMessageType`, taken
 * from the SAME last-message select (no second query per row), so a client
 * can say "Photo" instead of printing the bracket.
 *
 * The prisma double applies the include's where/orderBy/take AND its select:
 * a field the query did not ask for is absent here exactly as it would be from
 * Postgres. A double that returned whole rows would pass with the select
 * unchanged, which is the defect this test exists to catch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  conversations: [] as any[],
  messages: [] as any[],
  findManyArgs: [] as any[],
  messageQueries: 0,
}));

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
          _count: { messages: H.messages.filter((m) => m.conversationId === c.id).length },
          messages: lastMessages(c.id, a.include.messages),
        }));
      },
      count: async (a: any) => H.conversations.filter((c) => c.tenantId === a.where.tenantId).length,
    },
  },
}));

vi.mock("../lib/socket", () => ({ getIO: () => null }));

import router from "../routes/conversations";

const app = express();
app.use("/api/conversations", router);

const conv = (id: string, minutesAgo: number, tenantId = "T") => ({
  id, tenantId, channel: "WHATSAPP", customerExternalId: `ext-${id}`, status: "OPEN",
  lastMessageAt: new Date(Date.now() - minutesAgo * 60_000),
});
let seq = 0;
const msg = (conversationId: string, minutesAgo: number, o: any = {}) => ({
  id: `m${++seq}`, conversationId, direction: "INBOUND", body: "hi", messageType: "text", status: "DELIVERED",
  createdAt: new Date(Date.now() - minutesAgo * 60_000),
  metadata: null,
  ...o,
});

/** Both shapes the inbox reads: keyset (`cursor=`) and legacy offset. */
const PATHS = ["/api/conversations?cursor=", "/api/conversations"];

beforeEach(() => {
  H.conversations = [];
  H.messages = [];
  H.findManyArgs = [];
  H.messageQueries = 0;
});

describe("GET /api/conversations - lastMessageType", () => {
  it("★ an image, a voice note and a shared location each say their type, on both paging shapes", async () => {
    H.conversations = [conv("c1", 1), conv("c2", 2), conv("c3", 3), conv("c4", 4)];
    H.messages = [
      msg("c1", 1, { body: "[Image]", messageType: "image" }),
      msg("c2", 2, { body: "[Voice message]", messageType: "audio" }),
      msg("c3", 3, {
        body: "[Shared location: Eilat Port (29.55, 34.95)]",
        messageType: "location",
        metadata: { location: { latitude: 29.55, longitude: 34.95, name: "Eilat Port" } },
      }),
      msg("c4", 4, { body: "are you open today?", direction: "OUTBOUND" }),
    ];
    for (const path of PATHS) {
      const r = await request(app).get(path);
      expect(r.status).toBe(200);
      const byId = Object.fromEntries(r.body.data.map((c: any) => [c.id, c]));
      expect(byId.c1.lastMessageType).toBe("image");
      expect(byId.c2.lastMessageType).toBe("audio");
      expect(byId.c3.lastMessageType).toBe("location");
      expect(byId.c4.lastMessageType).toBe("text");
    }
  });

  it("★ existing fields are unchanged: body stays raw, direction stays, nothing renamed", async () => {
    H.conversations = [conv("c1", 1)];
    H.messages = [msg("c1", 1, { body: "[Image]", messageType: "image", direction: "INBOUND" })];
    const r = await request(app).get("/api/conversations?cursor=");
    expect(r.body.data[0]).toMatchObject({
      id: "c1",
      lastMessageBody: "[Image]",
      lastMessageDirection: "INBOUND",
      lastMessageType: "image",
      contactId: null,
    });
    // The raw relation still does not travel.
    expect(r.body.data[0]).not.toHaveProperty("messages");
  });

  it("★ the type comes from the SAME message as the body: the newest one the customer received", async () => {
    // A FAILED voice note is newer, but it never reached the customer; the
    // preview is the delivered photo, and its type must be the photo's too.
    H.conversations = [conv("c1", 1)];
    H.messages = [
      msg("c1", 10, { body: "[Image]", messageType: "image" }),
      msg("c1", 1, { body: "[Voice message]", messageType: "audio", direction: "OUTBOUND", status: "FAILED" }),
    ];
    const r = await request(app).get("/api/conversations?cursor=");
    expect(r.body.data[0].lastMessageBody).toBe("[Image]");
    expect(r.body.data[0].lastMessageType).toBe("image");
  });

  it("a conversation with no last message is null, not \"text\"", async () => {
    H.conversations = [conv("c1", 1)];
    for (const path of PATHS) {
      const r = await request(app).get(path);
      expect(r.body.data[0]).toHaveProperty("lastMessageType", null);
      expect(r.body.data[0].lastMessageBody).toBeNull();
    }
  });

  it("★ one list query, no per-row message lookup, and the select grew by messageType only", async () => {
    H.conversations = Array.from({ length: 20 }, (_, i) => conv(`c${i}`, i + 1));
    H.messages = H.conversations.map((c, i) => msg(c.id, i + 1, { messageType: "image", body: "[Image]" }));
    const r = await request(app).get("/api/conversations?cursor=&limit=20");
    expect(r.body.data).toHaveLength(20);
    expect(H.findManyArgs).toHaveLength(1);
    expect(H.messageQueries).toBe(0);
    // metadata stays unselected: the nested take is applied in memory, so
    // selecting it would read the JSON of every message on the page.
    expect(H.findManyArgs[0].include.messages.select).toEqual({
      direction: true, body: true, createdAt: true, messageType: true,
    });
    expect(r.body.data[0]).not.toHaveProperty("lastMessageLocationName");
  });
});
