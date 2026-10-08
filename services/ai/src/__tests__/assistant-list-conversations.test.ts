/**
 * ★ Listing conversations (Omer's thread, 2026-10-08: "list the 17", "the 2
 * WhatsApp ones", "is there an open conversation with Omer Serruya" had no
 * tool):
 *   - without a period: the current state (open now, whenever they started),
 *     latest activity first; the list's total is the open count Home shows
 *   - a customer's conversations on every channel of the person
 *   - who has it: me / GOTCHA / unassigned; waiting for a person = the shared
 *     queue rule
 *   - rows: customer, channel, state, who has it, last message, a link
 *   - only what the caller sees: visibility; private numbers never listed
 *     nor counted (the count still agrees with the list)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ convs: [] as any[], contacts: [] as any[], messages: [] as any[], rules: [] as any[] }));

function test(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return v.every((x: any) => test(row, x));
    if (k === "OR") return v.some((x: any) => test(row, x));
    if (k === "NOT") return !test(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      if ("contains" in v) return String(row[k] ?? "").toLowerCase().includes(String(v.contains).toLowerCase());
      if ("gte" in v || "lt" in v) return (!v.gte || row[k] >= v.gte) && (!v.lt || row[k] < v.lt);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
const sortBy = (rows: any[], orderBy: any[]) => [...rows].sort((a, b) => {
  for (const o of orderBy) {
    const [k, spec] = Object.entries(o)[0] as [string, any];
    const dir = typeof spec === "string" ? spec : spec.sort;
    const v = (r: any) => (r[k] instanceof Date ? r[k].getTime() : (r[k] ?? null));
    const x = v(a), y = v(b);
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x > y ? 1 : -1) * (dir === "desc" ? -1 : 1);
  }
  return 0;
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      conversation: {
        findMany: async (a: any) => {
          let rows = sortBy(H.convs.filter((c) => test(c, a.where)), Array.isArray(a.orderBy) ? a.orderBy : [a.orderBy ?? { createdAt: "desc" }]);
          if (a.cursor) rows = rows.slice(rows.findIndex((r) => r.id === a.cursor.id) + (a.skip ?? 0));
          return rows.slice(0, a.take ?? 1e9);
        },
        count: async (a: any) => H.convs.filter((c) => test(c, a.where)).length,
      },
      contact: { findMany: async (a: any) => H.contacts.filter((c) => test(c, a.where)) },
      message: {
        findMany: async (a: any) => {
          const rows = sortBy(H.messages.filter((m) => test(m, a.where)), [{ createdAt: "desc" }]);
          const seen = new Set();
          return rows.filter((m) => (seen.has(m.conversationId) ? false : (seen.add(m.conversationId), true)));
        },
      },
      inboundExclusion: { findMany: async () => H.rules },
    },
  };
});

import { dispatchSystemToolCall } from "../services/system-tools.service";
import { listConversationsForSource } from "../services/assistant-query.service";

const D = (iso: string) => new Date(iso);
const conv = (id: string, o: any = {}) => ({
  id, tenantId: "T", isTest: false, channel: "SHOPIFY_LIVE_CHAT", customerExternalId: `shop_${id}`, customerName: `Customer ${id}`, channelAccountId: "acc_main",
  status: "OPEN", handledBy: "ai_agent", isHandedOver: false, departmentId: null, assignedAgentId: null, assignedAgent: null,
  createdAt: D("2026-08-01T10:00:00Z"), lastMessageAt: D("2026-10-01T10:00:00Z"), ...o,
});
const AGENT = { userId: "agent1", role: "AGENT", departmentId: "sales" };
const ctx = (o: any = {}) => ({ tenantId: "T", userId: "agent1", locale: "en", ...o });
const call = async (name: string, args: any, c: any = ctx()) => {
  const r = await dispatchSystemToolCall({ id: "t", function: { name, arguments: JSON.stringify(args) } }, c);
  return { out: JSON.parse(r.content), artifacts: r.artifacts as any };
};
const list = (args: any = {}, c?: any) => call("system_list_conversations", args, c);
const openCount = async (c: any = ctx()) => (await call("system_get_metric", { metric: "open_conversations" }, c)).out.value;

beforeEach(() => {
  H.rules = [];
  H.contacts = [
    { id: "omer", tenantId: "T", channel: "WHATSAPP", externalId: "972525401686", personId: "person_omer" },
    { id: "omer_web", tenantId: "T", channel: "WEBCHAT", externalId: "wc_omer", personId: "person_omer" },
    // Another workspace's contact on a number that also writes to this one.
    { id: "foreign", tenantId: "OTHER", channel: "WHATSAPP", externalId: "972541111111", personId: null },
  ];
  H.convs = [
    // Started oldest first, active newest first: the two orders differ.
    conv("wa_omer", { channel: "WHATSAPP", customerExternalId: "972525401686", customerName: "Omer Serruya", createdAt: D("2026-08-01T10:00:00Z"), lastMessageAt: D("2026-10-08T12:00:00Z") }),
    // The AI handed it over: a person's now, not GOTCHA's.
    conv("wa_2", { channel: "WHATSAPP", customerExternalId: "972541111111", customerName: "Dana", createdAt: D("2026-08-02T10:00:00Z"), lastMessageAt: D("2026-10-07T09:00:00Z"), handledBy: "ai_agent", isHandedOver: true }),
    conv("web_omer", { channel: "WEBCHAT", customerExternalId: "wc_omer", customerName: "Omer S", status: "CLOSED", createdAt: D("2026-10-02T10:00:00Z") }),
    conv("shop_mine", { assignedAgentId: "agent1", assignedAgent: { name: "Noa" }, handledBy: "human", departmentId: "support", createdAt: D("2026-08-03T10:00:00Z"), lastMessageAt: D("2026-10-05T10:00:00Z") }),
    conv("shop_sales", { departmentId: "sales", createdAt: D("2026-08-04T10:00:00Z"), lastMessageAt: D("2026-10-04T10:00:00Z") }),
    conv("shop_support", { departmentId: "support", createdAt: D("2026-08-05T10:00:00Z"), lastMessageAt: D("2026-10-03T10:00:00Z") }),
    conv("shop_waiting", { handledBy: null, createdAt: D("2026-08-06T10:00:00Z"), lastMessageAt: null }),
    conv("shop_test", { isTest: true }),
    conv("foreign_conv", { tenantId: "OTHER", channel: "WHATSAPP", customerExternalId: "972500000000" }),
  ];
  H.messages = [
    { tenantId: "T", conversationId: "wa_omer", body: "Is my order on its way?", createdAt: D("2026-10-08T12:00:00Z") },
    { tenantId: "T", conversationId: "wa_omer", body: "Hi", createdAt: D("2026-10-08T11:00:00Z") },
  ];
});

describe("★ 'list the 17': the current state, the same total as the open count", () => {
  it("open now, latest activity first, each row with who has it, the last message and a link", async () => {
    const { out, artifacts } = await list();
    expect(out.total).toBe(6);
    expect(out.total).toBe(await openCount());
    const card = artifacts.blocks[0];
    expect(card).toMatchObject({ type: "record_list", kind: "conversation", title: "Conversations", total: 6, hasMore: false });
    expect(card.items.map((i: any) => i.id)).toEqual(["wa_omer", "wa_2", "shop_mine", "shop_sales", "shop_support", "shop_waiting"]);
    expect(card.items[0]).toMatchObject({ title: "Omer Serruya", subtitle: "WhatsApp · Open · GOTCHA", preview: "Is my order on its way?", deepLink: "/inbox?c=wa_omer" });
    expect(card.items[0].meta).toMatch(/8 October at \d\d:\d\d/);
    expect(card.items[2].subtitle).toBe("Shopify live chat · Open · Noa");
    expect(card.items[5].subtitle).toBe("Shopify live chat · Open · Waiting for a person");
    expect(out.rows[0]).toMatchObject({ conversationId: "wa_omer", customer: "Omer Serruya", lastMessage: "Is my order on its way?" });
    expect(artifacts.source.query.params).toMatchObject({ now: true, status: "OPEN", list: true });
  });

  it("'the 2 WhatsApp ones'", async () => {
    const { out } = await list({ channels: ["WHATSAPP"] });
    expect(out.rows.map((r: any) => r.conversationId)).toEqual(["wa_omer", "wa_2"]);
  });

  it("in Hebrew: a row's state is singular, and who has it in words", async () => {
    const { artifacts } = await list({}, ctx({ locale: "he" }));
    expect(artifacts.blocks[0].title).toBe("השיחות");
    expect(artifacts.blocks[0].items[0].subtitle).toBe("וואטסאפ · פתוחה · GOTCHA");
    expect(artifacts.blocks[0].items[5].subtitle).toBe("צ'אט Shopify · פתוחה · ממתינה לאדם");
  });
});

describe("★ a customer's conversations", () => {
  it("on every channel of the person, open and closed", async () => {
    const { out } = await list({ customerId: "omer" });
    expect(out.rows.map((r: any) => r.conversationId).sort()).toEqual(["wa_omer", "web_omer"]);
  });
  it("'is there an OPEN one with Omer'", async () => {
    const { out } = await list({ customerId: "omer", status: "OPEN" });
    expect(out.rows.map((r: any) => r.conversationId)).toEqual(["wa_omer"]);
  });
  it("another workspace's customer id finds nothing, even on a number that also writes here", async () => {
    const { out } = await list({ customerId: "foreign" });
    expect(out.total).toBe(0);
  });
});

describe("who has it", () => {
  it("me, GOTCHA, unassigned", async () => {
    expect((await list({ assignee: "me" })).out.rows.map((r: any) => r.conversationId)).toEqual(["shop_mine"]);
    expect((await list({ assignee: "gotcha" })).out.rows.map((r: any) => r.conversationId)).toEqual(["wa_omer", "shop_sales", "shop_support"]);
    expect((await list({ assignee: "unassigned" })).out.total).toBe(5);
  });
  it("★ waiting for a person is the shared queue rule: handed over or nobody answering, nobody assigned", async () => {
    expect((await list({ waitingForPerson: true })).out.rows.map((r: any) => r.conversationId)).toEqual(["wa_2", "shop_waiting"]);
  });
  it("closed ones need a period or a customer", async () => {
    expect((await list({ status: "CLOSED" })).out).toMatchObject({ ok: false });
  });
});

describe("★ only what the caller sees", () => {
  it("an agent of sales sees fewer rows, and the count still agrees", async () => {
    const c = ctx({ viewer: AGENT });
    const { out } = await list({}, c);
    expect(out.rows.map((r: any) => r.conversationId)).toEqual(["wa_omer", "wa_2", "shop_mine", "shop_sales", "shop_waiting"]);
    expect(out.total).toBe(await openCount(c));
  });
  it("★ a private number is never listed nor counted (on its channel, or on its number)", async () => {
    H.rules = [{ channel: "WHATSAPP", channelAccountId: "acc_main", customerExternalId: "972541111111" }];
    const { out } = await list();
    expect(out.rows.map((r: any) => r.conversationId)).not.toContain("wa_2");
    expect(out.total).toBe(5);
    expect(await openCount()).toBe(5);
    H.rules = [{ channel: "WHATSAPP", channelAccountId: "acc_other", customerExternalId: "972541111111" }];
    expect((await list()).out.total).toBe(6);
  });
});

describe("the full list behind the card", () => {
  it("replays the current state in the same order, with the same rows", async () => {
    const { artifacts } = await list();
    const page = await listConversationsForSource("T", undefined, "en", artifacts.source.query.params, null);
    expect(page.data.map((i) => i.id)).toEqual(["wa_omer", "wa_2", "shop_mine", "shop_sales", "shop_support", "shop_waiting"]);
    expect(page.data[0]).toMatchObject({ preview: "Is my order on its way?", deepLink: "/inbox?c=wa_omer" });
  });
});
