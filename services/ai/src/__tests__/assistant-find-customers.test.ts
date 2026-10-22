/**
 * ★ Finding a customer (Omer's thread, 2026-10-08: "יש שיחה מעומר צרויה?"
 * found nothing; the customer is "Omer Serruya"):
 *   - several spellings in one call, word by word, any order, any case
 *   - a miss on ONE spelling asks for the other spellings; "not found" only
 *     after them
 *   - phones match whatever their format
 *   - one row per person (personId), with their channels and conversations
 *   - only what the caller sees in the app: conversations by the inbox's
 *     visibility rule; without crm:contacts:read, only customers with a
 *     conversation they can see; private numbers (InboundExclusion) hidden
 *   - the card links to the customer, in the turn's language
 *   - the prompt: no "screen context" excuse, no offer without a tool
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => ({ contacts: [] as any[], convs: [] as any[], rules: [] as any[] }));

function test(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return v.every((x: any) => test(row, x));
    if (k === "OR") return v.some((x: any) => test(row, x));
    if (k === "NOT") return !test(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      if ("contains" in v) return v.mode === "insensitive" ? String(row[k] ?? "").toLowerCase().includes(String(v.contains).toLowerCase()) : String(row[k] ?? "").includes(v.contains);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => JSON.stringify({ timezone: "Asia/Jerusalem", schedule: {} }),
    prisma: {
      contact: { findMany: async (a: any) => H.contacts.filter((c) => test(c, a.where)).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, a.take ?? 1e9) },
      conversation: { findMany: async (a: any) => H.convs.filter((c) => test(c, a.where)) },
      inboundExclusion: { findMany: async () => H.rules },
    },
  };
});

import { findCustomersResult, phoneCore } from "../services/assistant-customers.service";
import { dispatchSystemToolCall } from "../services/system-tools.service";
import { threadSystemLines } from "../services/assistant-threads.service";

const D = (iso: string) => new Date(iso);
const contact = (id: string, o: any = {}) => ({ id, tenantId: "T", channel: "WHATSAPP", externalId: `9725${id.padStart(8, "0")}`, displayName: null, email: null, phone: null, personId: null, mergedIntoId: null, updatedAt: D("2026-10-01"), ...o });
const conv = (id: string, c: any, o: any = {}) => ({ id, tenantId: "T", isTest: false, channel: c.channel, customerExternalId: c.externalId, channelAccountId: "acc_main", status: "OPEN", departmentId: null, assignedAgentId: null, lastMessageAt: D("2026-10-08T12:00:00Z"), createdAt: D("2026-10-07"), ...o });
let n = 0;
const ctx = (o: any = {}) => ({ tenantId: "T", locale: "en" as const, nextId: (k: "b" | "s") => `${k}${++n}`, canReadContacts: true, ...o });
const AGENT = { userId: "agent1", role: "AGENT", departmentId: "sales" };

const omerWa = contact("omer", { displayName: "Omer Serruya", email: "omerts58@gmail.com", phone: "+972525401686", externalId: "972525401686", personId: "person_omer", updatedAt: D("2026-10-08") });
const omerWeb = contact("omerweb", { channel: "WEBCHAT", externalId: "wc_omer", displayName: "Omer S", personId: "person_omer", updatedAt: D("2026-10-02") });
const dana = contact("dana", { displayName: "Dana Cohen", phone: "+972541111111", externalId: "972541111111" });

beforeEach(() => {
  n = 0;
  H.rules = [];
  H.contacts = [omerWa, omerWeb, dana, contact("omri", { displayName: "Omri Levi" })];
  H.convs = [
    conv("c_wa", omerWa),
    conv("c_web", omerWeb, { status: "CLOSED", departmentId: "support" }),
    conv("c_dana", dana, { assignedAgentId: "someone_else" }),
    // A test row on his real number: not a conversation the business had.
    conv("c_test", omerWa, { isTest: true }),
  ];
});

describe("★ several spellings, word by word", () => {
  it("one spelling that misses is not 'not found': the result asks for the other spellings", async () => {
    const r: any = await findCustomersResult(ctx(), ["עומר צרויה"]);
    expect(r.summary).toMatchObject({ ok: true, found: 0 });
    expect(r.summary.retry).toMatch(/other script/);
    expect(r.summary).not.toHaveProperty("notFound");
    expect(r.blocks).toBeUndefined();
  });

  it("★ Omer's case: the Hebrew spelling misses, the Latin one finds him, with his conversations and a link", async () => {
    const r: any = await findCustomersResult(ctx(), ["עומר צרויה", "Omer Serruya", "עומר"]);
    expect(r.summary.found).toBe(1);
    expect(r.summary.customers[0]).toMatchObject({ customerId: "omer", name: "Omer Serruya", channels: ["WhatsApp", "Web chat"], openConversations: 1, conversations: 2 });
    const card = r.blocks[0];
    expect(card).toMatchObject({ type: "record_list", kind: "customer", title: "Customers found", sourceId: "s1" });
    expect(card.items[0]).toMatchObject({ id: "omer", title: "Omer Serruya", deepLink: "/customers/omer" });
    expect(card.items[0].meta).toMatch(/^1 open · last contact 8 October$/);
  });

  it("any order, any case; a first name alone finds every Omer but not Omri", async () => {
    expect((await findCustomersResult(ctx(), ["serruya OMER"]) as any).summary.customers.map((c: any) => c.name)).toEqual(["Omer Serruya"]);
    expect((await findCustomersResult(ctx(), ["Omer"]) as any).summary.customers.map((c: any) => c.name)).toEqual(["Omer Serruya"]);
  });

  it("several misses are 'not found', with what was tried", async () => {
    const r: any = await findCustomersResult(ctx(), ["ישראל ישראלי", "Israel Israeli"]);
    expect(r.summary).toMatchObject({ found: 0, notFound: true, tried: ["ישראל ישראלי", "Israel Israeli"] });
  });

  it("phones match whatever their format", async () => {
    expect(phoneCore("054-111-1111")).toBe("541111111");
    expect(phoneCore("+972 54 111 1111")).toBe("541111111");
    for (const p of ["054-111-1111", "+972 54 111 1111", "0541111111", "054 111 1111"]) {
      expect((await findCustomersResult(ctx(), [p]) as any).summary.customers?.map((c: any) => c.name), p).toEqual(["Dana Cohen"]);
    }
  });

  it("in Hebrew: the card's words are Hebrew", async () => {
    const r: any = await findCustomersResult(ctx({ locale: "he" }), ["Omer Serruya"]);
    expect(r.blocks[0].title).toBe("לקוחות שנמצאו");
    expect(r.blocks[0].items[0].subtitle).toMatch(/^וואטסאפ, צ'אט באתר/);
    expect(r.blocks[0].items[0].meta).toMatch(/^שיחה פתוחה אחת · קשר אחרון 8 באוקטובר$/);
    // The source says what was found, never the query as typed ("1 לקוחות: מעומר צרויה").
    expect(r.source.label).toBe("לקוח אחד: Omer Serruya");
    const two: any = await findCustomersResult(ctx({ locale: "he" }), ["עומר", "Omer"]);
    expect(two.source.label).toBe("לקוח אחד: Omer Serruya");
  });
});

describe("★ only what the caller sees in the app", () => {
  it("an agent sees fewer conversations: the support department's closed one is not counted", async () => {
    const r: any = await findCustomersResult(ctx({ viewer: AGENT }), ["Omer Serruya"]);
    expect(r.summary.customers[0]).toMatchObject({ openConversations: 1, conversations: 1 });
  });

  it("without crm:contacts:read, a customer with no conversation the caller can see is not found", async () => {
    const r: any = await findCustomersResult(ctx({ viewer: AGENT, canReadContacts: false }), ["Dana Cohen"]);
    expect(r.summary.found).toBe(0);
    // With it (the customers screen shows every customer), Dana is there, with none of her conversations.
    const w: any = await findCustomersResult(ctx({ viewer: AGENT, canReadContacts: true }), ["Dana Cohen"]);
    expect(w.summary.customers[0]).toMatchObject({ name: "Dana Cohen", openConversations: 0, conversations: 0 });
  });

  it("★ private numbers: a channel-wide rule hides the customer; a rule on one number hides only that number's conversations", async () => {
    H.rules = [{ channel: "WHATSAPP", channelAccountId: null, customerExternalId: "972541111111" }];
    expect((await findCustomersResult(ctx(), ["Dana Cohen"]) as any).summary.found).toBe(0);
    H.rules = [{ channel: "WHATSAPP", channelAccountId: "acc_main", customerExternalId: "972525401686" }];
    const r: any = await findCustomersResult(ctx(), ["Omer Serruya"]);
    expect(r.summary.customers[0]).toMatchObject({ openConversations: 0, conversations: 1 });
  });
});

describe("through the tool", () => {
  it("system_find_customers returns the card as artifacts; the old name still works", async () => {
    const r = await dispatchSystemToolCall({ id: "t", function: { name: "system_find_customers", arguments: JSON.stringify({ queries: ["עומר צרויה", "Omer Serruya"] }) } }, { tenantId: "T", userId: "u", locale: "en", canReadContacts: true });
    expect(JSON.parse(r.content)).toMatchObject({ ok: true, found: 1 });
    expect((r.artifacts as any).blocks[0].items[0].deepLink).toBe("/customers/omer");
    const old = await dispatchSystemToolCall({ id: "t2", function: { name: "system_search_customers", arguments: JSON.stringify({ query: "Omer Serruya" }) } }, { tenantId: "T", userId: "u", canReadContacts: true });
    expect(JSON.parse(old.content).found).toBe(1);
    // The caller's permission is not assumed: absent means no.
    const none = await dispatchSystemToolCall({ id: "t3", function: { name: "system_find_customers", arguments: JSON.stringify({ queries: ["Dana Cohen", "דנה"] }) } }, { tenantId: "T", userId: "u", viewer: AGENT as any });
    expect(JSON.parse(none.content)).toMatchObject({ found: 0, notFound: true });
  });
});

describe("★ the prompt: no excuse, no offer without a tool", () => {
  const prompt = readFileSync(join(__dirname, "../prompts/system-copilot.md"), "utf-8");
  it("the Ctrl+K context is not a reason; missing data is said plainly; not found only after the other spellings", () => {
    expect(prompt).not.toMatch(/want me to look it up/);
    expect(prompt).toMatch(/never say you\s+lack their screen or their context/);
    expect(prompt).toMatch(/Offer to look something up only when\s+one of your tools can do it/);
    expect(prompt).toMatch(/"not found" only after searching the name as written, in the\s+other script/);
  });
  it("a Home thread is told no screen is attached", () => {
    const lines = threadSystemLines({ range: "last_7", channels: "all" }, "he").join("\n");
    expect(lines).toMatch(/No screen is attached to this conversation/);
    expect(lines).toMatch(/Never mention their screen, a selected conversation or "context"/);
  });
});
