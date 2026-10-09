/**
 * ★ A customer's "הסר" / "STOP" reply (marketing by opt-out, Omer 2026-10-08,
 * docs/product/ai-studio-skills-automations.md §6):
 *   - the whole message, any case or punctuation, Hebrew or English; a
 *     sentence that merely contains the word is not an opt-out
 *   - the contact is opted out on that channel, a consent withdrawal and an
 *     audit entry are written, and a short confirmation answers in the
 *     customer's language; nothing else answers that message
 *   - the next marketing send to that customer on that channel is stopped
 *   - in the worker it runs before anything that could answer (bot,
 *     automations), whoever owns the conversation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({
  contacts: [] as any[], consent: [] as any[], messages: [] as any[], queued: [] as any[], audits: [] as any[], published: [] as any[],
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: {
      findFirst: async (a: any) => H.contacts.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null,
      update: async (a: any) => { const c = H.contacts.find((x) => x.id === a.where.id); Object.assign(c, a.data); return c; },
    },
    consentRecord: { create: async (a: any) => { H.consent.push(a.data); return a.data; } },
    message: { create: async (a: any) => { const m = { id: `m${H.messages.length + 1}`, ...a.data }; H.messages.push(m); return m; } },
    conversation: { update: async () => ({}) },
  },
  outgoingMessageQueue: { add: async (_n: string, d: any) => { H.queued.push(d); } },
  publishEvent: async (e: any) => { H.published.push(e); },
  auditSystem: async (...a: any[]) => { H.audits.push(a); },
  AuditAction: { CONSENT_WITHDRAWN: "gdpr.consent_withdrawn", CONSENT_GRANTED: "gdpr.consent_granted" },
}));

import { interceptOptOutReply } from "../services/marketing-optout.service";
import { optOutReply, isOptedOutOn } from "@chatcenter/shared/src/lib/marketing-optout";

const base = { tenantId: "T", contactId: "k1", channel: "WHATSAPP", conversationId: "c1", channelAccountId: "acct", recipientExternalId: "972501234567", messageId: "in1" };
const reply = (body: string, o: any = {}) => interceptOptOutReply({ ...base, messageType: "text", body, ...o });

beforeEach(() => {
  H.contacts = [{ id: "k1", tenantId: "T", optOutChannels: [] }];
  H.consent = []; H.messages = []; H.queued = []; H.audits = []; H.published = [];
});

describe("★ what is an opt-out reply", () => {
  it.each(["הסר", "  הסר!  ", "הסירו אותי", "להסרה", "STOP", "Stop.", "unsubscribe", "Remove me"])("'%s' is one", (t) => {
    expect(optOutReply(t)).not.toBeNull();
  });

  it.each(["הסר את המוצר מההזמנה", "please stop calling me at work, I will buy tomorrow", "stopping by tomorrow", "שלום", "", "אפשר להסיר את הכתובת?"])("'%s' is not", (t) => {
    expect(optOutReply(t)).toBeNull();
  });

  it("the language of the reply decides the confirmation's", () => {
    expect(optOutReply("הסר")).toBe("he");
    expect(optOutReply("STOP")).toBe("en");
  });
});

describe("★ the reply opts the customer out", () => {
  it("opted out on that channel, a withdrawal and an audit entry, a Hebrew confirmation", async () => {
    expect(await reply("הסר")).toBe(true);
    expect(H.contacts[0].optOutChannels).toEqual(["WHATSAPP"]);
    expect(H.contacts[0].optedOutAt).toBeInstanceOf(Date);
    expect(H.consent).toEqual([expect.objectContaining({ subjectId: "k1", purpose: "marketing_whatsapp", granted: false, source: "reply_keyword" })]);
    expect(H.audits[0]).toEqual(["T", "gdpr.consent_withdrawn", { type: "contact", id: "k1" }, expect.objectContaining({ purpose: "marketing_whatsapp", source: "reply_keyword" })]);
    expect(H.queued).toEqual([expect.objectContaining({ conversationId: "c1", recipientExternalId: "972501234567", messageType: "text", body: "הוסרת מרשימת התפוצה. לא נשלח לך עוד הודעות שיווקיות." })]);
    expect(H.messages[0]).toMatchObject({ direction: "OUTBOUND", metadata: { systemEvent: "marketing_opt_out_confirmation" } });
  });

  it("English reply, English confirmation; an earlier opt-out (any case) is not duplicated", async () => {
    H.contacts[0].optOutChannels = ["whatsapp"];
    expect(await reply("STOP")).toBe(true);
    expect(H.contacts[0].optOutChannels).toEqual(["whatsapp"]);
    expect(H.queued[0].body).toBe("You're unsubscribed. We won't send you marketing messages again.");
  });

  it("other channels are kept as they are", async () => {
    H.contacts[0].optOutChannels = ["EMAIL"];
    await reply("הסר");
    expect(H.contacts[0].optOutChannels).toEqual(["EMAIL", "WHATSAPP"]);
  });

  it("not an opt-out: nothing written, nothing sent, the message goes on to be answered", async () => {
    expect(await reply("הסר את המוצר מההזמנה")).toBe(false);
    expect(await reply("הסר", { messageType: "image" })).toBe(false);
    expect(await reply("הסר", { contactId: "" })).toBe(false);
    expect([H.consent.length, H.queued.length, H.audits.length]).toEqual([0, 0, 0]);
  });

  it("★ the next marketing send to that customer on that channel is stopped", async () => {
    await reply("הסר");
    expect(isOptedOutOn(H.contacts[0].optOutChannels, "whatsapp")).toBe(true);
    expect(isOptedOutOn(H.contacts[0].optOutChannels, "EMAIL")).toBe(false);
  });
});

describe("★ opting back in: START / הצטרף", () => {
  it("an opted-out customer is back on that channel, with a granted consent, an audit entry and a confirmation", async () => {
    H.contacts[0].optOutChannels = ["WHATSAPP", "EMAIL"];
    expect(await reply("הצטרף")).toBe(true);
    expect(H.contacts[0].optOutChannels).toEqual(["EMAIL"]);
    expect(H.consent).toEqual([expect.objectContaining({ purpose: "marketing_whatsapp", granted: true, source: "reply_keyword" })]);
    expect(H.audits[0]![1]).toBe("gdpr.consent_granted");
    expect(H.queued[0].body).toBe("חזרת לרשימת התפוצה. אפשר להסיר בכל עת: השיבו הסר.");
    expect(H.messages[0].metadata).toEqual({ systemEvent: "marketing_opt_in_confirmation" });
  });

  it("the last opt-out removed clears its date; English START, English confirmation", async () => {
    H.contacts[0].optOutChannels = ["whatsapp"];
    H.contacts[0].optedOutAt = new Date(1);
    expect(await reply("START")).toBe(true);
    expect(H.contacts[0]).toMatchObject({ optOutChannels: [], optedOutAt: null });
    expect(H.queued[0].body).toBe("You're subscribed again. Reply STOP at any time to unsubscribe.");
  });

  it("★ from a customer who is not opted out, 'start' is an ordinary message: nothing written, it goes on to be answered", async () => {
    expect(await reply("start")).toBe(false);
    H.contacts[0].optOutChannels = ["EMAIL"];
    expect(await reply("הצטרף")).toBe(false);
    expect([H.consent.length, H.queued.length, H.audits.length]).toEqual([0, 0, 0]);
  });

  it("a sentence is not an opt-in", async () => {
    H.contacts[0].optOutChannels = ["WHATSAPP"];
    expect(await reply("איך מצטרפים למועדון?")).toBe(false);
    expect(await reply("how do I start a return?")).toBe(false);
    expect(await reply("אני רוצה להצטרף למועדון הלקוחות")).toBe(false);
    expect(H.contacts[0].optOutChannels).toEqual(["WHATSAPP"]);
  });
});

describe("★ in the worker: before anything that could answer", () => {
  it("the check runs after the message is saved and before the bot and automations", () => {
    const src = readFileSync(join(__dirname, "..", "workers", "incoming.worker.ts"), "utf8");
    const at = (s: string) => { const i = src.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const check = at("interceptOptOutReply(");
    expect(at("const message = await prisma.message.create(")).toBeLessThan(check);
    expect(check).toBeLessThan(at("// Process bot if no agent assigned"));
    // The "unsupported media" auto-reply is gone (2026-10-09): nothing else
    // answers a customer automatically before the bot.
    expect(src).not.toMatch(/don't support this type of media/);
    expect(src.slice(check, check + 600)).toMatch(/if \(handled\) return;/);
  });
});
