/**
 * ★ A customer's card (design 01a item 5): what their customer page shows,
 * by the same rules.
 *   - profile, tags, what GOTCHA learned, the team's notes, their
 *     conversations on every channel, their latest orders
 *   - notes from the service that owns them, with the caller's own token
 *     (it hides another person's private notes); none without a token
 *   - orders only with customer:commerce:read
 *   - only a customer the caller may see: the contacts permission or a
 *     conversation they can see; never a private number
 *   - one source (their conversations), cited by the card and the rows
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ convs: [] as any[], contacts: [] as any[], rules: [] as any[], fetches: [] as any[], notesStatus: 200, ordersCalls: 0 }));

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
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
const tm = (d: any) => (d instanceof Date ? d.getTime() : -Infinity);

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      conversation: { findMany: async (a: any) => H.convs.filter((c) => test(c, a.where)).sort((x, y) => tm(y.lastMessageAt) - tm(x.lastMessageAt)).slice(0, a.take ?? 1e9) },
      contact: { findMany: async (a: any) => H.contacts.filter((c) => test(c, a.where)) },
      message: { findMany: async () => [] },
      inboundExclusion: { findMany: async () => H.rules },
    },
  };
});
vi.mock("../services/customer-memory.service", () => ({
  getCustomerMemory: async (_t: string, conversationId: string) => ({ conversationId, facts: [{ key: "size", value: "M", confidence: 0.9, source: null, observedAt: null }, { key: "prefers", value: "WhatsApp", confidence: 0.8, source: null, observedAt: null }], historical: null }),
}));
vi.mock("../services/customer-orders.service", () => ({
  getCustomerOrders: async () => {
    H.ordersCalls++;
    return { source: "woocommerce", orders: [{ orderNumber: "#1016", total: { amount: "250.00", currency: "ILS" }, financial: { label: "שולם" }, fulfillment: { label: "נשלח" }, createdAt: "2026-09-20T10:00:00Z" }] };
  },
}));

import { dispatchSystemToolCall } from "../services/system-tools.service";

const D = (iso: string) => new Date(iso);
const ADMIN = { userId: "boss", role: "ADMIN" };
const SALES = { userId: "agent1", role: "AGENT", departmentId: "sales" };
const ctx = (o: any = {}) => ({ tenantId: "T", userId: "boss", locale: "en", viewer: ADMIN, canReadContacts: true, canReadCommerce: true, authToken: "caller-token", ...o });
const card = async (args: any, c: any = ctx()) => {
  const r = await dispatchSystemToolCall({ id: "t", function: { name: "system_customer_card", arguments: JSON.stringify(args) } }, c);
  return { out: JSON.parse(r.content), artifacts: r.artifacts as any };
};

beforeEach(() => {
  H.rules = []; H.fetches = []; H.notesStatus = 200; H.ordersCalls = 0;
  H.contacts = [
    { id: "omer", tenantId: "T", channel: "WHATSAPP", externalId: "972525401686", displayName: "Omer Serruya", email: "omerts58@gmail.com", phone: "+972525401686", personId: "person_omer", mergedIntoId: null, tags: ["vip"], updatedAt: D("2026-10-08") },
    { id: "omer_web", tenantId: "T", channel: "WEBCHAT", externalId: "wc_omer", displayName: "Omer S", email: null, phone: null, personId: "person_omer", mergedIntoId: null, tags: ["returning"], updatedAt: D("2026-10-02") },
    { id: "dana", tenantId: "T", channel: "WHATSAPP", externalId: "972541111111", displayName: "Dana Cohen", email: null, phone: null, personId: null, mergedIntoId: null, tags: [], updatedAt: D("2026-09-01") },
  ];
  const base = { tenantId: "T", isTest: false, channelAccountId: "acc", handledBy: "ai_agent", isHandedOver: false, departmentId: null, assignedAgentId: null, assignedAgent: null, createdAt: D("2026-08-25T10:00:00Z") };
  H.convs = [
    { ...base, id: "wa_omer", channel: "WHATSAPP", customerExternalId: "972525401686", customerName: "Omer Serruya", status: "OPEN", lastMessageAt: D("2026-08-25T13:48:00Z") },
    { ...base, id: "web_omer", channel: "WEBCHAT", customerExternalId: "wc_omer", customerName: "Omer S", status: "CLOSED", lastMessageAt: D("2026-10-02T10:00:00Z") },
    { ...base, id: "dana_c", channel: "WHATSAPP", customerExternalId: "972541111111", customerName: "Dana Cohen", status: "OPEN", departmentId: "support", lastMessageAt: D("2026-09-01T10:00:00Z") },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    H.fetches.push({ url, auth: init?.headers?.Authorization });
    return { ok: H.notesStatus === 200, status: H.notesStatus, json: async () => ({ notes: [{ body: "Prefers evening calls", authorName: "Noa", createdAt: "2026-09-10T10:00:00Z", visibility: "TEAM" }] }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("★ the customer's card", () => {
  it("profile, tags, learned, notes, orders; their conversations on every channel; one source cited by both cards", async () => {
    const { out, artifacts } = await card({ customerId: "omer" });
    expect(out).toMatchObject({ ok: true, name: "Omer Serruya", channels: ["WhatsApp", "Web chat"], tags: ["vip", "returning"], openConversations: 1, conversations: 2 });
    expect(out.learned).toEqual(["size: M", "prefers: WhatsApp"]);
    const { RECORD_SHOWN_AS } = await import("../services/assistant-query.service");
    expect(out.shownAs).toBe(RECORD_SHOWN_AS);
    expect(out.notes).toEqual([{ text: "Prefers evening calls", by: "Noa", when: "10 September" }]);
    expect(out.orders).toEqual([{ number: "#1016", total: "₪250.00", state: "שולם · נשלח", when: "20 September" }]);
    const [profile, rows] = artifacts.blocks;
    expect(profile).toMatchObject({ type: "record", kind: "customer", title: "Omer Serruya", deepLink: "/customers/omer?tab=everything" });
    expect(profile.fields.map((f: any) => f.key)).toEqual(["channels", "phone", "email", "tags", "open", "last", "learned", "notes", "orders"]);
    expect(rows).toMatchObject({ type: "record_list", kind: "conversation" });
    expect(rows.items.map((i: any) => i.id).sort()).toEqual(["wa_omer", "web_omer"]);
    expect(profile.sourceId).toBe(artifacts.source.id);
    expect(rows.sourceId).toBe(artifacts.source.id);
    expect(artifacts.source.query.params).toMatchObject({ now: true, customerIds: ["omer", "omer_web"], list: true });
  });

  it("★ notes are read from the service that owns them, with the caller's own token; none without one", async () => {
    await card({ customerId: "omer" });
    expect(H.fetches).toEqual([{ url: "http://conversation:4002/api/identity/omer/notes", auth: "Bearer caller-token" }]);
    H.fetches = [];
    const { out } = await card({ customerId: "omer" }, ctx({ authToken: undefined }));
    expect(H.fetches).toEqual([]);
    expect(out.notes).toBeNull();
  });

  it("★ orders only with the right to read them", async () => {
    const { out } = await card({ customerId: "omer" }, ctx({ canReadCommerce: false }));
    expect(H.ordersCalls).toBe(0);
    expect(out).not.toHaveProperty("orders");
  });

  it("in Hebrew: the card's labels", async () => {
    const { artifacts } = await card({ customerId: "omer" }, ctx({ locale: "he" }));
    expect(artifacts.blocks[0].fields.map((f: any) => f.label)).toEqual(["ערוצים", "טלפון", "אימייל", "תגיות", "שיחות פתוחות", "קשר אחרון", "מה GOTCHA למדה", "הערות", "הזמנות"]);
  });
});

describe("★ only a customer the caller may see", () => {
  it("without the contacts permission, a customer with no conversation the caller can see does not exist", async () => {
    const c = ctx({ viewer: SALES, userId: "agent1", canReadContacts: false });
    expect((await card({ customerId: "dana" }, c)).out).toEqual({ ok: false, error: "customer not found" });
    expect(H.fetches).toEqual([]);
    // With it, Dana is there, without the support department's conversation.
    const w = await card({ customerId: "dana" }, ctx({ viewer: SALES, userId: "agent1" }));
    expect(w.out).toMatchObject({ ok: true, conversations: 0, conversationRows: [] });
  });

  it("a private number, another workspace's id: not found", async () => {
    H.rules = [{ channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972541111111" }];
    expect((await card({ customerId: "dana" })).out).toEqual({ ok: false, error: "customer not found" });
    expect((await card({ customerId: "nobody" })).out).toEqual({ ok: false, error: "customer not found" });
  });

  it("by name: one match opens the card; several are listed to choose from", async () => {
    expect((await card({ customer: ["עומר צרויה", "Omer Serruya"] })).out.name).toBe("Omer Serruya");
    H.contacts.push({ id: "omer_b", tenantId: "T", channel: "WHATSAPP", externalId: "972500000002", displayName: "Omer Ben David", email: null, phone: null, personId: null, mergedIntoId: null, tags: [], updatedAt: D("2026-09-01") });
    const { out } = await card({ customer: ["Omer"] });
    expect(out.chooseOne.map((c: any) => c.name).sort()).toEqual(["Omer Ben David", "Omer Serruya"]);
  });
});
