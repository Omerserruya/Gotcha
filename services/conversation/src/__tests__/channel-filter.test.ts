/**
 * ★ The list's `channel` filter takes a list (`channel=WHATSAPP,INSTAGRAM`) for
 * the phone's multi-select. Every value is checked against the schema's enum:
 * an unknown one is a 400 by name (it reached Postgres and came back a 500),
 * one value keeps today's exact match, several become `{ in }`. And the
 * phone's `excludeClosed` leaves resolved conversations out of "mine" - its
 * list and its count (`mine_open`) - without touching any other caller.
 */
import { describe, it, expect, vi } from "vitest";

const S = vi.hoisted(() => ({ rows: [] as any[] }));

function ok(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return (v as any[]).every((x) => ok(row, x));
    if (k === "OR") return (v as any[]).some((x) => ok(row, x));
    if (k === "NOT") return !ok(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async () => {
  const queue: any = await vi.importActual("@chatcenter/shared/src/lib/conversation-queue");
  return {
    waitingForPersonClause: queue.waitingForPersonClause,
    getInternalServiceKey: () => "k",
    readDurableSetting: async () => null,
    recordHandover: async () => undefined,
    publishEvent: async () => undefined,
    outgoingMessageQueue: { add: async () => undefined },
    notificationsQueue: { add: async () => undefined },
    withHistoricalRecords: (fn: any) => fn(),
    prisma: {
      conversation: {
        findMany: async (a: any) => S.rows.filter((r) => ok(r, a.where)).map((r) => ({ ...r, messages: [] })),
        count: async (a: any) => S.rows.filter((r) => ok(r, a.where)).length,
      },
      contact: { findMany: async () => [] },
    },
  };
});
vi.mock("../lib/unread-state", () => ({ unreadStates: async () => new Map() }));
// socket.io is not installed in every checkout; nothing here emits.
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({ create: vi.fn() }));

import { parseChannelList, channelWhere } from "../lib/channel-filter";
import { list, listWhere, unreadCounts } from "../services/conversation.service";

const c = (id: string, o: any = {}) => ({
  id, tenantId: "T", customerExternalId: "9725", status: "OPEN", assignedAgentId: null,
  handledBy: null, isHandedOver: false, departmentId: null, channel: "WHATSAPP", lastMessageAt: new Date(1), ...o,
});
const admin = { userRole: "ADMIN", userId: "a1" };

describe("parseChannelList", () => {
  it("absent or empty is no filter", () => {
    expect(parseChannelList(undefined)).toBeUndefined();
    expect(parseChannelList("")).toBeUndefined();
    expect(parseChannelList(" , ")).toBeUndefined();
  });

  it("one value, a comma list, repeated params and channel[] all read the same way", () => {
    expect(parseChannelList("WHATSAPP")).toEqual(["WHATSAPP"]);
    expect(parseChannelList("WHATSAPP, INSTAGRAM,WHATSAPP")).toEqual(["WHATSAPP", "INSTAGRAM"]);
    expect(parseChannelList(["WEBCHAT", "SHOPIFY_LIVE_CHAT"])).toEqual(["WEBCHAT", "SHOPIFY_LIVE_CHAT"]);
    expect(parseChannelList("VOICE")).toEqual(["VOICE"]);
  });

  it("★ an unknown channel is a 400 naming it, never a 500 and never silently dropped", () => {
    for (const raw of ["whatsapp", "WHATSAPP,FAX", ["EMAIL", "nope"], { a: 1 }]) {
      let err: any;
      try { parseChannelList(raw); } catch (e) { err = e; }
      expect(err?.status).toBe(400);
      expect(String(err?.message)).toMatch(/^unknown channel: /);
    }
  });

  it("★ one channel keeps the exact match; several become { in }", () => {
    expect(channelWhere(["WHATSAPP"])).toBe("WHATSAPP");
    expect(channelWhere(["WHATSAPP", "INSTAGRAM"])).toEqual({ in: ["WHATSAPP", "INSTAGRAM"] });
  });
});

describe("the list with a channel list and excludeClosed", () => {
  it("a single string channel builds exactly the WHERE it did before", async () => {
    const where = await listWhere("T", { channel: "WHATSAPP", ...admin });
    expect(where.channel).toBe("WHATSAPP");
  });

  it("several channels return the rows of any of them", async () => {
    S.rows = [c("wa"), c("ig", { channel: "INSTAGRAM" }), c("mail", { channel: "EMAIL" })];
    const r: any = await list("T", { channel: ["WHATSAPP", "INSTAGRAM"], cursor: "", ...admin });
    expect(r.data.map((x: any) => x.id).sort()).toEqual(["ig", "wa"]);
  });

  it("★ excludeClosed drops resolved rows from 'mine'; an explicit status still wins", async () => {
    S.rows = [c("open", { assignedAgentId: "a1" }), c("done", { assignedAgentId: "a1", status: "CLOSED" })];
    const mine: any = await list("T", { assignedAgentId: "a1", includeAutomated: true, excludeClosed: true, cursor: "", ...admin });
    expect(mine.data.map((x: any) => x.id)).toEqual(["open"]);
    const old: any = await list("T", { assignedAgentId: "a1", includeAutomated: true, cursor: "", ...admin });
    expect(old.data.map((x: any) => x.id).sort()).toEqual(["done", "open"]);
    const closed: any = await list("T", { status: "CLOSED", excludeClosed: true, includeAutomated: true, cursor: "", ...admin });
    expect(closed.data.map((x: any) => x.id)).toEqual(["done"]);
  });

  it("★ the count's mine_open is that same set, beside mine as it was", async () => {
    S.rows = [c("open", { assignedAgentId: "a1" }), c("done", { assignedAgentId: "a1", status: "CLOSED" })];
    const { totals } = await unreadCounts("T", { userId: "a1", role: "ADMIN" }, ["mine", "mine_open"]);
    expect(totals).toEqual({ mine: 2, mine_open: 1 });
  });
});
