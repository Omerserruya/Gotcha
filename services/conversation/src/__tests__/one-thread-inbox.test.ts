/**
 * One thread across the website chat and WhatsApp: the inbox list and the
 * conversation's detail.
 *
 * After a visitor continues on WhatsApp, the team sees ONE row: the WhatsApp
 * conversation, carrying `continuedFrom`. The website chat is still there
 * (never deleted, reachable by its id) and is left out of the list.
 *
 * What these exist to prevent, worst first:
 *   1. A conversation hidden that nobody merged: a website chat closed by a
 *      person, archived by a person, or opened again after the move.
 *   2. The visibility rule replaced by this filter (it lives in `where.OR`).
 *   3. An inbox that fails because a badge could not be read.
 *
 * The fake applies every NOT the service pushed into `where.AND`, row by row,
 * and throws on a condition it does not know.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => {
  const state = {
    conversations: [] as any[],
    messages: [] as any[],
    seenWhere: null as any,
    countWheres: [] as any[],
    linkReads: [] as any[],
    failLinkRead: false,
  };
  const at = (o: any, path: string[]) => path.reduce((v, k) => (v == null ? undefined : v[k]), o);
  const value = (actual: any, cond: any): boolean => {
    if (cond === null || typeof cond !== "object") return actual === cond;
    if ("in" in cond) return cond.in.includes(actual);
    if ("not" in cond) return cond.not === null ? actual != null : actual !== cond.not;
    if ("path" in cond) return at(actual, cond.path) === cond.equals;
    if ("startsWith" in cond) return typeof actual === "string" && actual.startsWith(cond.startsWith);
    throw new Error(`fake db: unknown condition ${JSON.stringify(cond)}`);
  };
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, cond]: [string, any]) => {
      if (cond === undefined) return true;
      if (k === "NOT") return !matches(row, cond);
      if (k === "messages") return state.messages.some((m) => m.conversationId === row.id && matches(m, cond.some));
      if (k === "conversation") {
        const c = state.conversations.find((x) => x.id === row.conversationId);
        return !!c && matches(c, cond);
      }
      return value(row[k], cond);
    });
  /** Every `{ NOT: ... }` in where.AND, as the database would apply it. */
  const listed = (where: any) =>
    state.conversations.filter((c) => c.tenantId === where.tenantId && (where.AND ?? []).every((clause: any) => !("NOT" in clause) || matches(c, clause)));
  return { state, matches, listed };
});

vi.mock("@chatcenter/shared", () => ({
  getInternalServiceKey: () => "test-key",
  readDurableSetting: async () => null,
  recordHandover: async () => undefined,
  publishEvent: async () => undefined,
  outgoingMessageQueue: { add: async () => undefined },
  notificationsQueue: { add: async () => undefined },
  withHistoricalRecords: (fn: any) => fn(),
  replyWindowsFor: async () => new Map(),
  waitingForPersonClause: () => ({ status: { not: "CLOSED" }, AND: [{ OR: [{ handledBy: null }] }] }),
  prisma: {
    $queryRaw: async () => [],
    contact: { findMany: async () => [] },
    channelAccount: { groupBy: async () => [] },
    conversation: {
      findMany: async (args: any) => {
        DB.state.seenWhere = args.where;
        return DB.listed(args.where).map((c) => ({ ...c, messages: [] }));
      },
      count: async (args: any) => {
        DB.state.countWheres.push(args.where);
        return DB.listed(args.where).length;
      },
      findFirst: async (args: any) => {
        const c = DB.state.conversations.find((x) => x.id === args.where.id && x.tenantId === args.where.tenantId);
        if (!c) return null;
        const own = DB.state.messages.filter((m) => m.conversationId === c.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { ...c, assignedAgent: null, department: null, channelAccount: null, messages: own };
      },
    },
    message: {
      findMany: async (args: any) => {
        DB.state.linkReads.push(args.where);
        if (DB.state.failLinkRead) throw new Error("link read down");
        const rows = DB.state.messages.filter((m) => DB.matches(m, args.where));
        const dir = args.orderBy?.createdAt;
        return dir ? [...rows].sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * (dir === "desc" ? -1 : 1)) : rows;
      },
    },
  },
}));
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({}));

import { list, listWhere, getById } from "../services/conversation.service";
import { mergedAwayWhere } from "../lib/merged-thread";

const T = "t1";
const ADMIN = { userRole: "ADMIN", userId: "u1" };
const AGENT = { userRole: "AGENT", userId: "u1", userDepartmentId: "d1" };
const day = (clock: string) => new Date(`2026-11-22T${clock}Z`);
const conv = (id: string, channel: string, o: any = {}) => ({
  id, tenantId: T, channel, status: "OPEN", archivedAt: null, customerExternalId: `cust_${id}`, customerName: null,
  lastMessageAt: day("10:05:04.000"), ...o,
});
const sys = (id: string, conversationId: string, clock: string, metadata: any) => ({
  id, tenantId: T, conversationId, direction: "INBOUND", body: "", messageType: "system", metadata, createdAt: day(clock),
});
const arrived = (id: string, wa: string, from: string | null, clock: string) => sys(id, wa, clock, { systemEvent: "continued_from_website", fromConversationId: from });
const left = (id: string, web: string, to: string, clock: string) => sys(id, web, clock, { systemEvent: "continued_on_whatsapp", toConversationId: to });
const said = (id: string, conversationId: string, clock: string) => ({
  id, tenantId: T, conversationId, direction: "INBOUND", body: id, messageType: "text", metadata: null, createdAt: day(clock),
});
const MOVED = { status: "CLOSED", archivedAt: day("10:05:00.400"), closedAt: day("10:05:00.400") };

/** The real flow, after the link: web1 moved into wa1. */
function handoff() {
  DB.state.conversations = [conv("wa1", "WHATSAPP"), conv("web1", "WEBCHAT", MOVED)];
  DB.state.messages = [
    said("web-1", "web1", "10:00:00.000"),
    left("web-left", "web1", "wa1", "10:05:00.450"),
    arrived("wa-divider", "wa1", "web1", "10:05:00.199"),
    said("wa-in", "wa1", "10:05:00.200"),
  ];
}

const listedIds = async (filters: any = {}) => ((await list(T, { ...ADMIN, cursor: "", ...filters })) as any).data.map((c: any) => c.id);

beforeEach(() => {
  handoff();
  DB.state.seenWhere = null;
  DB.state.countWheres = [];
  DB.state.linkReads = [];
  DB.state.failLinkRead = false;
});

describe("★ the inbox shows one row for the customer", () => {
  it("★ the website chat that moved is left out; the WhatsApp conversation stays", async () => {
    expect(await listedIds()).toEqual(["wa1"]);
  });

  it("the clause is in AND, whatever the view", async () => {
    for (const view of [undefined, "queue", "open", "irrelevant", "all", "resolved", "mine"]) {
      const where = await listWhere(T, { ...ADMIN, view } as any);
      expect(where.AND, String(view)).toContainEqual({ NOT: mergedAwayWhere() });
      expect(where.NOT, String(view)).toBeUndefined();
    }
  });

  it("★ the visibility rule is still the top-level OR", async () => {
    const where = await listWhere(T, { ...AGENT } as any);
    expect(where.OR).toEqual([
      { departmentId: "d1", assignedAgentId: null },
      { departmentId: null, assignedAgentId: null },
      { assignedAgentId: "u1" },
    ]);
    expect(where.AND).toContainEqual({ NOT: mergedAwayWhere() });
  });

  it("the legacy page's total leaves it out too", async () => {
    const r: any = await list(T, { ...ADMIN });
    expect(r.data.map((c: any) => c.id)).toEqual(["wa1"]);
    expect(r.meta.total).toBe(1);
  });
});

describe("★ what must NOT be hidden", () => {
  it("★ a website chat opened again after the move is back in the list", async () => {
    Object.assign(DB.state.conversations[1], { status: "OPEN" });
    expect(await listedIds()).toEqual(["wa1", "web1"]);
    Object.assign(DB.state.conversations[1], { status: "WAITING" });
    expect(await listedIds()).toEqual(["wa1", "web1"]);
  });

  it("★ a website chat a person closed and archived, which never moved", async () => {
    DB.state.messages = DB.state.messages.filter((m) => m.id !== "web-left");
    expect(await listedIds()).toEqual(["wa1", "web1"]);
  });

  it("a linked pair from before archiving was written (closed, not archived) stays listed", async () => {
    Object.assign(DB.state.conversations[1], { archivedAt: null });
    expect(await listedIds()).toEqual(["wa1", "web1"]);
  });

  it("★ a closed, archived conversation of another channel carrying the same event", async () => {
    Object.assign(DB.state.conversations[1], { channel: "INSTAGRAM" });
    expect(await listedIds()).toEqual(["wa1", "web1"]);
  });

  it("a closed, archived website chat whose only system rows are other events", async () => {
    DB.state.messages = [sys("web-assigned", "web1", "10:00:30.000", { systemEvent: "assigned" }), said("web-note", "web1", "10:00:40.000")];
    expect(await listedIds()).toEqual(["wa1", "web1"]);
  });

  it("an ordinary message whose metadata happens to carry the event's name", async () => {
    DB.state.messages = [{ ...said("web-odd", "web1", "10:00:00.000"), metadata: { systemEvent: "continued_on_whatsapp" } }];
    expect(await listedIds()).toEqual(["wa1", "web1"]);
  });

  it("every part of the clause is a yes or a no, so the NOT drops nothing else", () => {
    // NOT over a NULL comparison is NULL in SQL and silently drops the row.
    // `archivedAt: { not: null }` is IS NOT NULL, and the rest are non-null columns.
    expect(mergedAwayWhere()).toEqual({
      channel: "WEBCHAT",
      status: "CLOSED",
      archivedAt: { not: null },
      messages: { some: { messageType: "system", metadata: { path: ["systemEvent"], equals: "continued_on_whatsapp" } } },
    });
  });
});

describe("★ continuedFrom: the badge on the WhatsApp row", () => {
  const rows = async (filters: any = {}) => Object.fromEntries(((await list(T, { ...ADMIN, cursor: "", ...filters })) as any).data.map((c: any) => [c.id, c]));

  it("★ names the website chat and when the customer arrived", async () => {
    expect((await rows()).wa1.continuedFrom).toEqual({ channel: "WEBCHAT", conversationId: "web1", at: "2026-11-22T10:05:00.199Z" });
  });

  it("null, present, on a row that continued from nowhere", async () => {
    DB.state.conversations.push(conv("wa2", "WHATSAPP"), conv("web9", "WEBCHAT"));
    const r = await rows();
    expect(r.wa2.continuedFrom).toBeNull();
    expect(r.web9.continuedFrom).toBeNull();
    expect("continuedFrom" in r.wa2).toBe(true);
  });

  it("only WhatsApp rows are asked about", async () => {
    DB.state.conversations.push(conv("web9", "WEBCHAT"), conv("ig1", "INSTAGRAM"));
    await rows();
    expect(DB.state.linkReads[0].conversationId).toEqual({ in: ["wa1"] });
  });

  it("no WhatsApp row on the page: nothing is read", async () => {
    DB.state.conversations = [conv("web9", "WEBCHAT"), conv("ig1", "INSTAGRAM")];
    await rows();
    expect(DB.state.linkReads).toHaveLength(0);
  });

  it("two website chats: the most recent one", async () => {
    DB.state.conversations.push(conv("web2", "WEBCHAT", MOVED));
    DB.state.messages.push(arrived("wa-divider-2", "wa1", "web2", "11:30:00.000"), left("web2-left", "web2", "wa1", "11:30:00.300"));
    expect((await rows()).wa1.continuedFrom).toEqual({ channel: "WEBCHAT", conversationId: "web2", at: "2026-11-22T11:30:00.000Z" });
  });

  it("a pointer the website chat does not confirm: no badge", async () => {
    DB.state.messages = DB.state.messages.filter((m) => m.id !== "web-left");
    expect((await rows()).wa1.continuedFrom).toBeNull();
  });

  it("★ the badge cannot be read: the inbox still loads, without it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    DB.state.failLinkRead = true;
    const r = await rows();
    expect(Object.keys(r)).toEqual(["wa1"]);
    expect(r.wa1.continuedFrom).toBeNull();
    warn.mockRestore();
  });
});

describe("the conversation's detail", () => {
  it("★ carries continuedFrom, and its own messages only", async () => {
    const c: any = await getById(T, "wa1");
    expect(c.continuedFrom).toEqual({ channel: "WEBCHAT", conversationId: "web1", at: "2026-11-22T10:05:00.199Z" });
    // The merged thread is GET /:id/messages; this field is the conversation's own rows.
    expect(c.messages.map((m: any) => m.id)).toEqual(["wa-divider", "wa-in"]);
  });

  it("the website chat is still reachable by its id, with no badge of its own", async () => {
    const c: any = await getById(T, "web1");
    expect(c.id).toBe("web1");
    expect(c.continuedFrom).toBeNull();
    expect(c.messages.map((m: any) => m.id)).toEqual(["web-1", "web-left"]);
  });

  it("the badge cannot be read: the detail still opens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    DB.state.failLinkRead = true;
    const c: any = await getById(T, "wa1");
    expect(c.id).toBe("wa1");
    expect(c.continuedFrom).toBeNull();
    warn.mockRestore();
  });

  it("another organization's conversation is not found", async () => {
    expect(await getById("t2", "wa1")).toBeNull();
  });
});
