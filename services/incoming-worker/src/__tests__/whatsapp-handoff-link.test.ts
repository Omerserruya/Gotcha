/**
 * ★ "Continue on WhatsApp" arriving: the code in the first WhatsApp message
 * links the website chat to the WhatsApp conversation.
 *   - claimed once: the same code a second time links nothing
 *   - only on the workspace's number it was issued for
 *   - one customer: the WhatsApp person, else the website one, else a new one;
 *     two different people already are left apart ("conflict")
 *   - a system event in each conversation pointing at the other; the website
 *     chat closed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ kv: new Map<string, string>(), contacts: [] as any[], conversations: [] as any[], messages: [] as any[], events: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]) => (r[k] ?? null) === v);
  return {
    ...actual,
    publishEvent: async (e: any) => { H.events.push(e); },
    getRedis: () => ({
      multi: () => {
        const ops: any[] = [];
        const chain: any = {
          get: (k: string) => { ops.push(() => H.kv.get(k) ?? null); return chain; },
          del: (k: string) => { ops.push(() => (H.kv.delete(k) ? 1 : 0)); return chain; },
          exec: async () => ops.map((op) => [null, op()]),
        };
        return chain;
      },
      del: async (k: string) => (H.kv.delete(k) ? 1 : 0),
    }),
    prisma: {
      conversation: {
        findFirst: async (a: any) => H.conversations.find((c) => match(c, a.where)) ?? null,
        update: async (a: any) => { const c = H.conversations.find((x) => x.id === a.where.id); Object.assign(c, a.data); return c; },
      },
      contact: {
        findFirst: async (a: any) => H.contacts.find((c) => match(c, a.where)) ?? null,
        update: async (a: any) => { const c = H.contacts.find((x) => x.id === a.where.id); Object.assign(c, a.data); return c; },
      },
      message: { create: async (a: any) => { const m = { id: `m${H.messages.length + 1}`, ...a.data }; H.messages.push(m); return m; } },
      $transaction: async (ops: any[]) => Promise.all(ops),
    },
  };
});

import { linkWebsiteHandoff } from "../services/whatsapp-handoff-link.service";

const REF = "K7Q2MX";
const record = (o: any = {}) => JSON.stringify({ tenantId: "T", conversationId: "web1", whatsappChannelAccountId: "wa_1", createdAt: "2026-10-07T10:00:00Z", ...o });
const arrive = (o: any = {}) => linkWebsiteHandoff({
  tenantId: "T", channelAccountId: "wa_1", whatsappConversationId: "wa_conv",
  whatsappContact: H.contacts.find((c) => c.id === "c_wa") ?? null,
  body: `Hi, continuing our chat from the website (${REF})`, ...o,
});

beforeEach(() => {
  H.kv = new Map([[`wahandoff:ref:${REF}`, record()], ["wahandoff:conv:web1", REF]]);
  H.messages = []; H.events = [];
  H.conversations = [{ id: "web1", tenantId: "T", channel: "WEBCHAT", status: "OPEN", customerExternalId: "sess_1", closedAt: null }];
  H.contacts = [
    { id: "c_wa", tenantId: "T", channel: "WHATSAPP", externalId: "972521112222", personId: null, mergedIntoId: null },
    { id: "c_web", tenantId: "T", channel: "WEBCHAT", externalId: "sess_1", personId: null, mergedIntoId: null },
  ];
});

describe("★ linking", () => {
  it("links: one new person for both, an event in each conversation, the website chat closed", async () => {
    const r = await arrive();
    expect(r).toEqual({ linked: true, websiteConversationId: "web1", identity: "linked" });
    const [wa, web] = H.contacts;
    expect(wa.personId).toMatch(/^person_/);
    expect(web.personId).toBe(wa.personId);
    expect(H.messages.map((m) => [m.conversationId, m.metadata.systemEvent])).toEqual([["wa_conv", "continued_from_website"], ["web1", "continued_on_whatsapp"]]);
    expect(H.messages[0].metadata).toMatchObject({ fromConversationId: "web1", ref: REF });
    expect(H.messages[1].metadata).toMatchObject({ toConversationId: "wa_conv" });
    expect(H.conversations[0]).toMatchObject({ status: "CLOSED" });
    expect(H.conversations[0].closedAt).toBeInstanceOf(Date);
    expect(H.kv.size).toBe(0);
    expect(H.events.map((e) => e.event)).toEqual(["message:new", "message:new", "conversation:closed"]);
  });

  it("the WhatsApp person wins; else the website one", async () => {
    H.contacts[0].personId = "person_wa";
    await arrive();
    expect(H.contacts[1].personId).toBe("person_wa");
    beforeEachReset();
    H.contacts[1].personId = "person_web";
    await arrive();
    expect(H.contacts[0].personId).toBe("person_web");
  });

  it("two different people already: left apart, recorded as a conflict", async () => {
    H.contacts[0].personId = "person_a"; H.contacts[1].personId = "person_b";
    const r = await arrive();
    expect(r).toMatchObject({ linked: true, identity: "conflict" });
    expect([H.contacts[0].personId, H.contacts[1].personId]).toEqual(["person_a", "person_b"]);
    expect(H.messages[0].metadata.identity).toBe("conflict");
  });
});

describe("★ what links nothing", () => {
  it("no code; an unknown code; the same code twice", async () => {
    expect(await arrive({ body: "hello" })).toEqual({ linked: false, reason: "no_code" });
    expect(await arrive({ body: "hi (ABCDEF)" })).toEqual({ linked: false, reason: "unknown_code" });
    expect((await arrive()).linked).toBe(true);
    expect(await arrive()).toEqual({ linked: false, reason: "unknown_code" });
    expect(H.messages).toHaveLength(2);
  });

  it("another number or another workspace: nothing linked, and the code is spent", async () => {
    expect(await arrive({ channelAccountId: "wa_2" })).toEqual({ linked: false, reason: "other_number" });
    expect(H.kv.has(`wahandoff:ref:${REF}`)).toBe(false);
    beforeEachReset();
    expect(await arrive({ tenantId: "OTHER" })).toEqual({ linked: false, reason: "other_number" });
    expect(H.messages).toEqual([]);
    expect(H.conversations[0].status).toBe("OPEN");
  });

  it("the website chat is gone", async () => {
    H.conversations = [];
    expect(await arrive()).toEqual({ linked: false, reason: "website_chat_gone" });
  });
});

function beforeEachReset() {
  H.kv = new Map([[`wahandoff:ref:${REF}`, record()], ["wahandoff:conv:web1", REF]]);
  H.messages = []; H.events = [];
  H.conversations = [{ id: "web1", tenantId: "T", channel: "WEBCHAT", status: "OPEN", customerExternalId: "sess_1", closedAt: null }];
  H.contacts = [
    { id: "c_wa", tenantId: "T", channel: "WHATSAPP", externalId: "972521112222", personId: null, mergedIntoId: null },
    { id: "c_web", tenantId: "T", channel: "WEBCHAT", externalId: "sess_1", personId: null, mergedIntoId: null },
  ];
}

describe("★ started from the WhatsApp kind of widget (no website conversation)", () => {
  it("one event on the WhatsApp side carrying the page; nothing on the website touched; claimed once", async () => {
    H.kv.set(`wahandoff:ref:${REF}`, record({ conversationId: null, context: { pageType: "product", productHandle: "oak-lamp", path: "/products/oak-lamp" } }));
    const r = await arrive({ body: `Does it come in blue? (${REF})` });
    expect(r).toEqual({ linked: true, websiteConversationId: null, identity: "none" });
    expect(H.messages).toHaveLength(1);
    expect(H.messages[0]).toMatchObject({ conversationId: "wa_conv", messageType: "system" });
    expect(H.messages[0].metadata).toEqual({ systemEvent: "continued_from_website", fromConversationId: null, ref: REF, identity: "none", page: { pageType: "product", productHandle: "oak-lamp", path: "/products/oak-lamp" } });
    expect(H.conversations[0].status).toBe("OPEN");
    expect([H.contacts[0].personId, H.contacts[1].personId]).toEqual([null, null]);
    expect(H.events.map((e) => e.event)).toEqual(["message:new"]);
    expect(await arrive()).toEqual({ linked: false, reason: "unknown_code" });
  });

  it("still only on the number it was issued for", async () => {
    H.kv.set(`wahandoff:ref:${REF}`, record({ conversationId: null }));
    expect(await arrive({ channelAccountId: "wa_2" })).toEqual({ linked: false, reason: "other_number" });
    expect(H.messages).toEqual([]);
  });
});

/**
 * One thread (2026-11-22): the inbox reads the website chat inside the
 * WhatsApp conversation, in time order, from the two events written here.
 * What this side owes that read: the WhatsApp event dated just before the
 * customer's WhatsApp message, and the website chat archived as well as closed.
 */
describe("★ one thread: the divider's time, and the website chat archived", () => {
  const SAVED = new Date("2026-11-22T10:05:00.200Z");

  it("the WhatsApp event is dated one millisecond before the customer's WhatsApp message", async () => {
    await arrive({ whatsappMessageAt: SAVED });
    const [divider, onWebsite] = H.messages;
    expect(divider.metadata.systemEvent).toBe("continued_from_website");
    expect(divider.createdAt.toISOString()).toBe("2026-11-22T10:05:00.199Z");
    // Before, never at or after: at the same instant the order is anybody's.
    expect(divider.createdAt.getTime()).toBeLessThan(SAVED.getTime());
    // The website side keeps the database's own time.
    expect(onWebsite.metadata.systemEvent).toBe("continued_on_whatsapp");
    expect(onWebsite.createdAt).toBeUndefined();
  });

  it("without the message's time, or with an unreadable one, the event is dated now", async () => {
    const before = Date.now();
    await arrive();
    expect(H.messages[0].createdAt).toBeInstanceOf(Date);
    expect(H.messages[0].createdAt.getTime()).toBeGreaterThanOrEqual(before);

    beforeEachReset();
    await arrive({ whatsappMessageAt: new Date("not a date") });
    expect(Number.isNaN(H.messages[0].createdAt.getTime())).toBe(false);
    expect(H.messages[0].createdAt.getTime()).toBeGreaterThanOrEqual(before);

    beforeEachReset();
    await arrive({ whatsappMessageAt: null });
    expect(H.messages[0].createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("the website chat is archived in the same write that closes it", async () => {
    await arrive({ whatsappMessageAt: SAVED });
    const web = H.conversations[0];
    expect(web.status).toBe("CLOSED");
    expect(web.archivedAt).toBeInstanceOf(Date);
    // Archived when the link was made, not at the divider's time.
    expect(web.archivedAt.getTime()).toBe(web.closedAt.getTime());
    expect(web.archivedAt.getTime()).toBeGreaterThan(SAVED.getTime());
  });

  it("a website chat that was already closed is archived too", async () => {
    H.conversations[0].status = "CLOSED";
    H.conversations[0].closedAt = new Date("2026-11-22T09:00:00Z");
    await arrive({ whatsappMessageAt: SAVED });
    expect(H.conversations[0].archivedAt).toBeInstanceOf(Date);
  });

  it("nothing linked, nothing archived", async () => {
    await arrive({ channelAccountId: "wa_other", whatsappMessageAt: SAVED });
    expect(H.conversations[0].archivedAt).toBeUndefined();
    expect(H.conversations[0].status).toBe("OPEN");
    expect(H.messages).toEqual([]);
  });

  it("the page-only event (no website chat) keeps the database's own time", async () => {
    H.kv = new Map([[`wahandoff:ref:${REF}`, record({ conversationId: null, context: { pageType: "product", productHandle: "h", path: "/p" } })]]);
    await arrive({ whatsappMessageAt: SAVED });
    expect(H.messages).toHaveLength(1);
    expect(H.messages[0].metadata).toMatchObject({ systemEvent: "continued_from_website", fromConversationId: null });
    expect(H.messages[0].createdAt).toBeUndefined();
  });
});
