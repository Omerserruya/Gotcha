/**
 * ★ Reading one conversation (Omer's thread, 2026-10-08: the customer was
 * found and their conversation could not be opened):
 *   - by a customer (id or name): their latest conversation the caller can
 *     see, an open one first; a name matching several people asks which
 *   - every id through the by-id rule (tenant + the inbox's visibility),
 *     failing closed without a viewer; private numbers read as not found
 *   - the card: a record linking to /inbox?c=, the messages in order, the
 *     summary when there is one
 * And from the replay of the list (same day):
 *   - a list's result asks for ONE sentence, never the rows again
 *   - an unnamed Shopify shopper is "קונה באתר", not "Shopper on <domain>"
 *   - the prompt's feminine examples cover listing and showing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => ({ convs: [] as any[], contacts: [] as any[], messages: [] as any[], intel: [] as any[], rules: [] as any[], reads: [] as string[] }));

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
const t = (d: any) => (d instanceof Date ? d.getTime() : -Infinity);

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      conversation: {
        findFirst: async (a: any) => H.convs.find((c) => test(c, a.where)) ?? null,
        findMany: async (a: any) => H.convs.filter((c) => test(c, a.where)).sort((x, y) => t(y.lastMessageAt) - t(x.lastMessageAt)).slice(0, a.take ?? 1e9),
      },
      contact: { findMany: async (a: any) => H.contacts.filter((c) => test(c, a.where)) },
      message: { findMany: async (a: any) => { H.reads.push(a.where.conversationId); return H.messages.filter((m) => test(m, a.where)).sort((x, y) => t(y.createdAt) - t(x.createdAt)).slice(0, a.take); } },
      conversationIntelligence: { findFirst: async (a: any) => H.intel.find((i) => test(i, a.where)) ?? null },
      inboundExclusion: { findMany: async () => H.rules },
    },
  };
});

import { dispatchSystemToolCall } from "../services/system-tools.service";
import { customerDisplayName, LIST_SHOWN_AS } from "../services/assistant-query.service";

const D = (iso: string) => new Date(iso);
const ADMIN = { userId: "boss", role: "ADMIN" };
const SALES = { userId: "agent1", role: "AGENT", departmentId: "sales" };
const ctx = (o: any = {}) => ({ tenantId: "T", userId: "boss", locale: "en", viewer: ADMIN, canReadContacts: true, ...o });
const read = async (args: any, c: any = ctx()) => {
  const r = await dispatchSystemToolCall({ id: "t", function: { name: "system_read_conversation", arguments: JSON.stringify(args) } }, c);
  return { out: JSON.parse(r.content), artifacts: r.artifacts as any };
};

beforeEach(() => {
  H.rules = []; H.reads = [];
  H.contacts = [
    { id: "omer", tenantId: "T", channel: "WHATSAPP", externalId: "972525401686", displayName: "Omer Serruya", personId: "person_omer", mergedIntoId: null, updatedAt: D("2026-10-08") },
    { id: "omer_web", tenantId: "T", channel: "WEBCHAT", externalId: "wc_omer", displayName: "Omer S", personId: "person_omer", mergedIntoId: null, updatedAt: D("2026-10-02") },
    { id: "omer_b", tenantId: "T", channel: "WHATSAPP", externalId: "972500000002", displayName: "Omer Ben David", personId: null, mergedIntoId: null, updatedAt: D("2026-09-01") },
  ];
  const base = { tenantId: "T", isTest: false, channelAccountId: "acc", handledBy: "ai_agent", isHandedOver: false, departmentId: null, assignedAgentId: null, assignedAgent: null, createdAt: D("2026-08-25T10:00:00Z") };
  H.convs = [
    { ...base, id: "wa_omer", channel: "WHATSAPP", customerExternalId: "972525401686", customerName: "Omer Serruya", status: "OPEN", lastMessageAt: D("2026-08-25T13:48:00Z") },
    // Newer, but closed: the open one is read first.
    { ...base, id: "web_omer", channel: "WEBCHAT", customerExternalId: "wc_omer", customerName: "Omer S", status: "CLOSED", lastMessageAt: D("2026-10-02T10:00:00Z") },
    { ...base, id: "support_c", channel: "WHATSAPP", customerExternalId: "972500000002", customerName: "Omer Ben David", status: "OPEN", departmentId: "support", lastMessageAt: D("2026-09-01T10:00:00Z") },
    { ...base, id: "shopper", channel: "SHOPIFY_LIVE_CHAT", customerExternalId: "s1", customerName: "Shopper on urban-supply-gotcha-demo.myshopify.com", status: "OPEN", lastMessageAt: D("2026-10-07T10:00:00Z") },
    { ...base, id: "other_tenant", tenantId: "OTHER", channel: "WHATSAPP", customerExternalId: "972599999999", customerName: "Not yours", status: "OPEN", lastMessageAt: D("2026-10-07T10:00:00Z") },
  ];
  H.messages = [
    { tenantId: "T", conversationId: "wa_omer", direction: "INBOUND", body: "היי", messageType: "text", senderName: null, createdAt: D("2026-08-25T13:40:00Z") },
    { tenantId: "T", conversationId: "wa_omer", direction: "OUTBOUND", body: "", messageType: "system", senderName: null, createdAt: D("2026-08-25T13:45:00Z") },
    { tenantId: "T", conversationId: "wa_omer", direction: "OUTBOUND", body: "Hi Omer, how can I help?", messageType: "text", senderName: "GOTCHA", createdAt: D("2026-08-25T13:48:00Z") },
  ];
  H.intel = [{ tenantId: "T", conversationId: "wa_omer", summary: "Omer asked about his order." }];
});

describe("★ by a customer", () => {
  it("their latest conversation the caller can see, an open one first: a card linking to it, the messages in order, the summary", async () => {
    const { out, artifacts } = await read({ customerId: "omer" });
    expect(out).toMatchObject({ ok: true, conversationId: "wa_omer", customer: "Omer Serruya", channel: "WhatsApp", state: "Open", whoHasIt: "GOTCHA", summary: "Omer asked about his order." });
    // System lines are not part of the conversation.
    expect(out.messages.map((m: any) => [m.role, m.text])).toEqual([["customer", "היי"], ["business", "Hi Omer, how can I help?"]]);
    const card = artifacts.blocks[0];
    expect(card).toMatchObject({ type: "record", kind: "conversation", title: "Omer Serruya", deepLink: "/inbox?c=wa_omer" });
    expect(card.fields.map((f: any) => f.key)).toEqual(["channel", "state", "handler", "started", "last", "summary"]);
    expect(artifacts.source).toMatchObject({ kind: "conversation", deepLink: "/inbox?c=wa_omer" });
  });

  it("by name, in any script: Omer's thread", async () => {
    expect((await read({ customer: ["עומר צרויה", "Omer Serruya"] })).out.conversationId).toBe("wa_omer");
  });

  it("a name that matches two people asks which; one spelling that misses asks for the others", async () => {
    const { out } = await read({ customer: ["Omer"] });
    expect(out.chooseOne.map((c: any) => c.name).sort()).toEqual(["Omer Ben David", "Omer Serruya"]);
    expect(H.reads).toEqual([]);
    expect((await read({ customer: ["עומר צרויה"] })).out.retry).toMatch(/other script/);
  });
});

describe("★ every id through the by-id rule", () => {
  it("an agent of sales cannot read support's conversation: not found, and its messages are never read", async () => {
    const { out } = await read({ conversationId: "support_c" }, ctx({ viewer: SALES, userId: "agent1" }));
    expect(out).toEqual({ ok: false, error: "conversation not found" });
    expect(H.reads).toEqual([]);
    // Through the customer too: their only conversation is not one the agent sees.
    expect((await read({ customerId: "omer_b" }, ctx({ viewer: SALES, userId: "agent1" }))).out.note).toMatch(/no conversation the user can see/);
  });

  it("fails closed without a viewer; another workspace's id; a private number", async () => {
    // The same answer as a missing id (not a crash that happens to say ok: false).
    expect((await read({ conversationId: "wa_omer" }, ctx({ viewer: undefined }))).out).toEqual({ ok: false, error: "conversation not found" });
    expect((await read({ conversationId: "other_tenant" })).out).toEqual({ ok: false, error: "conversation not found" });
    H.rules = [{ channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972525401686" }];
    expect((await read({ conversationId: "wa_omer" })).out).toEqual({ ok: false, error: "conversation not found" });
    expect(H.reads).toEqual([]);
  });

  it("Ctrl+K: the selected conversation when nothing is named; nothing selected asks which", async () => {
    expect((await read({}, ctx({ selectedConversationId: "wa_omer" }))).out.conversationId).toBe("wa_omer");
    expect((await read({})).out).toMatchObject({ ok: false, error: expect.stringMatching(/say which conversation/) });
    // The old name reads the same way.
    const old = await dispatchSystemToolCall({ id: "o", function: { name: "system_summarize_conversation", arguments: "{}" } }, ctx({ selectedConversationId: "wa_omer" }));
    expect(JSON.parse(old.content).conversationId).toBe("wa_omer");
  });
});

describe("★ from the list's replay (2026-10-08)", () => {
  it("an unnamed Shopify shopper reads as a shopper, not a domain", async () => {
    expect(customerDisplayName("Shopper on urban-supply-gotcha-demo.myshopify.com", "s1", "he")).toBe("קונה באתר");
    expect(customerDisplayName("Signed-in shopper on urban-supply-gotcha-demo.myshopify.com", "s1", "en")).toBe("Signed-in website shopper");
    expect(customerDisplayName("Dana", "x", "he")).toBe("Dana");
    expect((await read({ conversationId: "shopper" }, ctx({ locale: "he" }))).out.customer).toBe("קונה באתר");
    const list = await dispatchSystemToolCall({ id: "l", function: { name: "system_list_conversations", arguments: "{}" } }, ctx({ locale: "he" }));
    const titles = (list.artifacts as any).blocks[0].items.map((i: any) => i.title);
    expect(titles).toContain("קונה באתר");
    expect(titles.join(" ")).not.toMatch(/myshopify/);
  });

  it("a list's result asks for one sentence, never the rows again", async () => {
    const list = JSON.parse((await dispatchSystemToolCall({ id: "l", function: { name: "system_list_conversations", arguments: "{}" } }, ctx())).content);
    expect(list.shownAs).toBe(LIST_SHOWN_AS);
    expect(LIST_SHOWN_AS).toMatch(/ONE sentence/);
    expect(LIST_SHOWN_AS).toMatch(/never repeat the rows/);
    const found = JSON.parse((await dispatchSystemToolCall({ id: "f", function: { name: "system_find_customers", arguments: JSON.stringify({ queries: ["Omer"] }) } }, ctx())).content);
    expect(found.shownAs).toBe(LIST_SHOWN_AS);
  });

  it("the feminine examples cover listing, showing, seeing and finding", () => {
    const prompt = readFileSync(join(__dirname, "../prompts/system-copilot.md"), "utf-8");
    for (const f of ["מפרטת", "מציגה", "רואה", "מוצאת"]) expect(prompt).toContain(`"${f}"`);
    expect(prompt).toMatch(/Never "בודק", "יכול", "מוכן", "מפרט", "מציג", "מוצא"/);
  });
});
