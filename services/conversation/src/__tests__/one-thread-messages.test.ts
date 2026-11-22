/**
 * One thread across the website chat and WhatsApp: the message list.
 *
 * A visitor chats on the website, presses "Continue on WhatsApp" and writes
 * from WhatsApp with the code. The team then works ONE thread: opening the
 * WhatsApp conversation shows the website chat's messages too, oldest first,
 * then the divider, then WhatsApp.
 *
 * What these exist to prevent, worst first:
 *   1. Another conversation's messages inside a thread. The merge follows a
 *      pointer stored in a message row, so a pointer that is not confirmed
 *      from the other side, or that names another organization's or another
 *      kind of conversation, must merge nothing.
 *   2. A thread that looks complete and is not: pages that skip or repeat a
 *      row, or a total that counts only one side.
 *   3. An unlinked conversation read differently than before.
 *
 * The fake applies the WHERE the service built, row by row, and throws on any
 * condition it does not know: a filter the service forgot cannot pass here by
 * the fake returning the right rows anyway.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => {
  const state = {
    conversations: [] as any[],
    messages: [] as any[],
    reads: [] as any[],
    counts: [] as any[],
    failLinkRead: false,
  };
  const at = (o: any, path: string[]) => path.reduce((v, k) => (v == null ? undefined : v[k]), o);
  const value = (actual: any, cond: any): boolean => {
    if (cond === null || typeof cond !== "object") return actual === cond;
    if ("in" in cond) return cond.in.includes(actual);
    if ("not" in cond) return cond.not === null ? actual != null : actual !== cond.not;
    if ("path" in cond) return at(actual, cond.path) === cond.equals;
    throw new Error(`fake db: unknown condition ${JSON.stringify(cond)}`);
  };
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, cond]: [string, any]) => {
      if (cond === undefined) return true;
      if (k === "OR") return cond.some((w: any) => matches(row, w));
      if (k === "conversation") {
        const c = state.conversations.find((x) => x.id === row.conversationId);
        return !!c && matches(c, cond);
      }
      return value(row[k], cond);
    });
  return { state, matches };
});

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    message: {
      findMany: async (args: any) => {
        DB.state.reads.push(args.where);
        if (DB.state.failLinkRead && args.where?.messageType === "system") throw new Error("link read down");
        let rows = DB.state.messages.filter((m) => DB.matches(m, args.where));
        // Ordered the way the QUERY asked. With no orderBy the rows come back
        // in the (scrambled) order they were stored.
        const dir = args.orderBy?.createdAt;
        if (dir) rows = [...rows].sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * (dir === "desc" ? -1 : 1));
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map((r) => ({ ...r }));
      },
      count: async (args: any) => {
        DB.state.counts.push(args.where);
        return DB.state.messages.filter((m) => DB.matches(m, args.where)).length;
      },
    },
  },
  publishEvent: async () => undefined,
  withHistoricalRecords: (fn: any) => fn(),
  currentRequestContext: () => undefined,
}));
vi.mock("../lib/socket", () => ({ getIO: () => { throw new Error("no io in tests"); } }));

import { listByConversation } from "../services/message.service";
import { continuedFromFor, MAX_LINKED_WEB_CHATS } from "../lib/merged-thread";

const T = "t1";
const day = (clock: string) => new Date(`2026-11-22T${clock}Z`);
const msg = (id: string, conversationId: string, clock: string, o: any = {}) => ({
  id, tenantId: T, conversationId, direction: "INBOUND", body: id, messageType: "text", metadata: null, mediaUrl: null,
  createdAt: day(clock), ...o,
});
const arrived = (id: string, wa: string, from: string | null, clock: string, o: any = {}) =>
  msg(id, wa, clock, { body: "", messageType: "system", metadata: { systemEvent: "continued_from_website", fromConversationId: from, ref: "K7Q2MX" }, ...o });
const left = (id: string, web: string, to: string, clock: string, o: any = {}) =>
  msg(id, web, clock, { body: "", messageType: "system", metadata: { systemEvent: "continued_on_whatsapp", toConversationId: to, ref: "K7Q2MX" }, ...o });

const IMAGE = "/api/uploads/0f8fad5b-d9cb-469f-a165-70867728950e.png";

/**
 * The real flow: a website chat with a bot answer and a picture, the visitor's
 * note typed into the handoff form, then the WhatsApp message with the code.
 * The WhatsApp conversation already held a message from a week before.
 * Stored out of order on purpose.
 */
function handoff() {
  DB.state.conversations = [
    { id: "wa1", tenantId: T, channel: "WHATSAPP" },
    { id: "web1", tenantId: T, channel: "WEBCHAT" },
    { id: "plain1", tenantId: T, channel: "WHATSAPP" },
  ];
  DB.state.messages = [
    msg("wa-out", "wa1", "10:05:04.000", { direction: "OUTBOUND" }),
    left("web-left", "web1", "wa1", "10:05:00.450"),
    msg("web-3", "web1", "10:02:00.000", { metadata: { source: "whatsapp_handoff" } }),
    msg("wa-in", "wa1", "10:05:00.200"),
    msg("web-1", "web1", "10:00:00.000"),
    arrived("wa-divider", "wa1", "web1", "10:05:00.199"),
    msg("web-assigned", "web1", "10:00:30.000", { body: "", messageType: "system", metadata: { systemEvent: "assigned" } }),
    msg("web-pic", "web1", "10:01:00.000", { messageType: "image", mediaUrl: IMAGE }),
    msg("wa-old", "wa1", "10:00:00.000", { createdAt: new Date("2026-11-15T08:00:00Z") }),
    msg("web-2", "web1", "10:00:20.000", { direction: "OUTBOUND" }),
    msg("plain-1", "plain1", "09:00:00.000"),
  ];
}

const ids = (r: { data: any[] }) => r.data.map((m) => m.id);
const MERGED = ["wa-old", "web-1", "web-2", "web-pic", "web-3", "wa-divider", "wa-in", "wa-out"];

beforeEach(() => {
  handoff();
  DB.state.reads = [];
  DB.state.counts = [];
  DB.state.failLinkRead = false;
});

describe("★ the WhatsApp conversation shows the website chat too", () => {
  it("★ website messages, the divider, then WhatsApp, each at its own time", async () => {
    const r = await listByConversation(T, "wa1");
    expect(ids(r)).toEqual(MERGED);
  });

  it("the total counts both sides, and matches the rows", async () => {
    const r = await listByConversation(T, "wa1");
    expect(r.meta).toEqual({ page: 1, limit: 50, total: MERGED.length, totalPages: 1 });
    // One WHERE for the rows and for the count: they cannot disagree.
    expect(DB.state.counts).toHaveLength(1);
    expect(DB.state.counts[0]).toEqual(DB.state.reads[DB.state.reads.length - 1]);
  });

  it("★ a website row says where it came from and keeps its own conversation", async () => {
    const r = await listByConversation(T, "wa1");
    const by = Object.fromEntries(r.data.map((m: any) => [m.id, m]));
    for (const id of ["web-1", "web-2", "web-pic", "web-3"]) {
      expect(by[id].originChannel, id).toBe("WEBCHAT");
      expect(by[id].conversationId, id).toBe("web1");
    }
    for (const id of ["wa-old", "wa-divider", "wa-in", "wa-out"]) {
      expect("originChannel" in by[id], id).toBe(false);
      expect(by[id].conversationId, id).toBe("wa1");
    }
  });

  it("the website chat's own system rows stay out; this thread's divider stays in", async () => {
    const r = await listByConversation(T, "wa1");
    expect(ids(r)).not.toContain("web-left");
    expect(ids(r)).not.toContain("web-assigned");
    expect(ids(r)).toContain("wa-divider");
  });

  it("a website picture is served through the website chat's own media route", async () => {
    const r = await listByConversation(T, "wa1");
    const pic: any = r.data.find((m: any) => m.id === "web-pic");
    expect(pic.mediaUrl).toBe("/api/conversations/web1/messages/web-pic/media/0f8fad5b-d9cb-469f-a165-70867728950e.png");
  });

  it("★ paged: every row once, in order, with one total", async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await listByConversation(T, "wa1", { page, limit: 3 });
      expect(r.meta.total).toBe(MERGED.length);
      expect(r.meta.totalPages).toBe(3);
      seen.push(...ids(r));
    }
    expect(seen).toEqual(MERGED);
  });
});

describe("★ what is NOT merged", () => {
  it("★ a conversation with no link is read exactly as before", async () => {
    const r = await listByConversation(T, "plain1");
    expect(ids(r)).toEqual(["plain-1"]);
    expect(DB.state.reads[DB.state.reads.length - 1]).toEqual({ tenantId: T, conversationId: "plain1" });
    expect(DB.state.counts[0]).toEqual({ tenantId: T, conversationId: "plain1" });
    // One read for the link and none for the other side: nothing pointed anywhere.
    expect(DB.state.reads).toHaveLength(2);
  });

  it("the website chat, opened by itself, shows only its own rows", async () => {
    const r = await listByConversation(T, "web1");
    expect(ids(r)).toEqual(["web-1", "web-2", "web-assigned", "web-pic", "web-3", "web-left"]);
    expect(r.data.some((m: any) => "originChannel" in m)).toBe(false);
  });

  it("★ a pointer the website chat does not confirm merges nothing", async () => {
    DB.state.messages = DB.state.messages.filter((m) => m.id !== "web-left");
    const r = await listByConversation(T, "wa1");
    expect(ids(r)).toEqual(["wa-old", "wa-divider", "wa-in", "wa-out"]);
    expect(r.meta.total).toBe(4);
  });

  it("★ a website chat that left for ANOTHER WhatsApp conversation merges nothing here", async () => {
    DB.state.messages.find((m) => m.id === "web-left").metadata.toConversationId = "wa2";
    expect(ids(await listByConversation(T, "wa1"))).toEqual(["wa-old", "wa-divider", "wa-in", "wa-out"]);
  });

  it("★ another organization's website chat is never read, confirmed or not", async () => {
    DB.state.conversations.find((c) => c.id === "web1").tenantId = "t2";
    for (const m of DB.state.messages) if (m.conversationId === "web1") m.tenantId = "t2";
    const r = await listByConversation(T, "wa1");
    expect(ids(r)).toEqual(["wa-old", "wa-divider", "wa-in", "wa-out"]);
    expect(r.meta.total).toBe(4);
  });

  it("★ a website chat that BELONGS to another organization, whatever its rows say", async () => {
    // The rows carry this organization's id; the conversation does not.
    DB.state.conversations.find((c) => c.id === "web1").tenantId = "t2";
    const r = await listByConversation(T, "wa1");
    expect(ids(r)).toEqual(["wa-old", "wa-divider", "wa-in", "wa-out"]);
    expect(r.meta.total).toBe(4);
  });

  it("★ rows of another organization inside a linked website chat stay out", async () => {
    DB.state.messages.push(msg("foreign", "web1", "10:00:10.000", { tenantId: "t2" }));
    expect(ids(await listByConversation(T, "wa1"))).toEqual(MERGED);
  });

  it("★ a pointer at a conversation that is not a website chat merges nothing", async () => {
    DB.state.conversations.find((c) => c.id === "web1").channel = "INSTAGRAM";
    expect(ids(await listByConversation(T, "wa1"))).toEqual(["wa-old", "wa-divider", "wa-in", "wa-out"]);
  });

  it("a conversation pointing at itself merges nothing", async () => {
    DB.state.messages.push(arrived("self", "plain1", "plain1", "09:00:01.000"), left("self-back", "plain1", "plain1", "09:00:02.000"));
    DB.state.conversations.find((c) => c.id === "plain1").channel = "WEBCHAT";
    expect((await continuedFromFor(T, ["plain1"])).size).toBe(0);
  });

  it("the page-only event (the WhatsApp kind of widget, no website chat) merges nothing", async () => {
    DB.state.messages = [arrived("page-only", "wa1", null, "10:05:00.199"), msg("wa-in", "wa1", "10:05:00.200")];
    const r = await listByConversation(T, "wa1");
    expect(ids(r)).toEqual(["page-only", "wa-in"]);
    expect(DB.state.reads[DB.state.reads.length - 1]).toEqual({ tenantId: T, conversationId: "wa1" });
  });

  it("★ the link cannot be read: the conversation's own messages are served, not an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    DB.state.failLinkRead = true;
    const r = await listByConversation(T, "wa1");
    expect(ids(r)).toEqual(["wa-old", "wa-divider", "wa-in", "wa-out"]);
    expect(r.meta.total).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("the links themselves", () => {
  it("names the website chat and the divider's time", async () => {
    const links = await continuedFromFor(T, ["wa1", "plain1"]);
    expect([...links.keys()]).toEqual(["wa1"]);
    expect(links.get("wa1")).toEqual([{ channel: "WEBCHAT", conversationId: "web1", at: "2026-11-22T10:05:00.199Z" }]);
  });

  it("no conversations asked about: no read at all", async () => {
    expect((await continuedFromFor(T, [])).size).toBe(0);
    expect(DB.state.reads).toHaveLength(0);
  });

  it("the same website chat linked twice counts once, at its latest arrival", async () => {
    DB.state.messages.push(arrived("wa-divider-2", "wa1", "web1", "11:00:00.000"));
    expect((await continuedFromFor(T, ["wa1"])).get("wa1")).toEqual([{ channel: "WEBCHAT", conversationId: "web1", at: "2026-11-22T11:00:00.000Z" }]);
  });

  it("★ several website chats: most recent first, and no more than the limit in the thread", async () => {
    expect(MAX_LINKED_WEB_CHATS).toBe(5);
    DB.state.messages = [msg("wa-in", "wa1", "12:00:00.000")];
    for (let n = 1; n <= 7; n++) {
      DB.state.conversations.push({ id: `w${n}`, tenantId: T, channel: "WEBCHAT" });
      DB.state.messages.push(
        msg(`w${n}-said`, `w${n}`, `09:0${n}:00.000`),
        arrived(`a${n}`, "wa1", `w${n}`, `09:0${n}:30.000`),
        left(`l${n}`, `w${n}`, "wa1", `09:0${n}:31.000`),
      );
    }
    const links = (await continuedFromFor(T, ["wa1"])).get("wa1")!;
    expect(links.map((l) => l.conversationId)).toEqual(["w7", "w6", "w5", "w4", "w3"]);

    const r = await listByConversation(T, "wa1", { limit: 100 });
    const said = ids(r).filter((id) => id.endsWith("-said"));
    expect(said).toEqual(["w3-said", "w4-said", "w5-said", "w6-said", "w7-said"]);
    // All seven dividers are this conversation's own rows and stay.
    expect(ids(r).filter((id) => /^a\d$/.test(id))).toHaveLength(7);
  });

  it("one read serves a whole page of conversations, each with its own links", async () => {
    DB.state.conversations.push({ id: "wa2", tenantId: T, channel: "WHATSAPP" }, { id: "web2", tenantId: T, channel: "WEBCHAT" });
    DB.state.messages.push(arrived("d2", "wa2", "web2", "11:00:00.000"), left("l2", "web2", "wa2", "11:00:00.300"));
    const links = await continuedFromFor(T, ["wa1", "wa2", "plain1"]);
    expect(links.get("wa1")!.map((l) => l.conversationId)).toEqual(["web1"]);
    expect(links.get("wa2")!.map((l) => l.conversationId)).toEqual(["web2"]);
    expect(links.has("plain1")).toBe(false);
    expect(DB.state.reads).toHaveLength(2);
  });
});
