/**
 * Smoovee prod 2026-11-13 09:03 (cmwer1s5): Meta delivered the customer's
 * "טרם" as `type: "unsupported"`, error 131060, with no content. The worker
 * passed the placeholder "[unsupported message]" to the AI as her words, and
 * the bot answered "ההודעה נראית כ'לא נתמכת'". Now the AI never sees it: the
 * customer is asked once, gently, to send it again as text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ msgs: [] as any[], sent: [] as any[], seq: 0 }));

vi.mock("@chatcenter/shared", async () => ({
  prisma: {
    message: {
      findFirst: vi.fn(async (a: any) => H.msgs.find((m) =>
        m.conversationId === a.where.conversationId && m.direction === a.where.direction
        && +m.createdAt >= +a.where.createdAt.gte && m.metadata?.systemEvent === a.where.metadata.equals) ?? null),
      create: vi.fn(async (a: any) => { const m = { id: `m${++H.seq}`, createdAt: new Date(), ...a.data }; H.msgs.push(m); return m; }),
    },
    conversation: { update: vi.fn(async () => ({})) },
  },
  outgoingMessageQueue: { add: vi.fn(async (_n: string, job: any) => { H.sent.push(job); }) },
  publishEvent: vi.fn(async () => undefined),
}));

import { handleUndeliverable, undeliverableAction, RESEND_ASK, RESEND_ASK_GAP_MS } from "../services/undeliverable-message.service";

// Her payload's shape, as stored on the message (metadata.unsupported).
const unavailable = { unsupported: { providerType: "unsupported", errors: [{ code: 131060, title: "This message is unavailable." }], raw: { type: "unsupported", unsupported: { type: "unknown" } } } };
const album = { unsupported: { providerType: "unsupported", errors: [{ code: 131051 }], raw: { type: "unsupported", unsupported: { type: "album" } } } };
const reaction = { unsupported: { providerType: "reaction", errors: [], raw: { type: "reaction" } } };

const input = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1", conversationId: "c1", channel: "WHATSAPP", channelAccountId: "ca1",
  recipientExternalId: "972500004815", metadata: unavailable, detectedLocale: null, humanOwned: false, ...over,
});

beforeEach(() => {
  H.msgs = []; H.sent = []; H.seq = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("an undeliverable WhatsApp message", () => {
  it("asks once, in Hebrew by default, as the system, and never says 'unsupported'", async () => {
    expect(await handleUndeliverable(input())).toBe(true);
    expect(H.sent).toHaveLength(1);
    expect(H.sent[0].body).toBe(RESEND_ASK.he);
    expect(H.sent[0].senderName).toBe("System");
    expect(H.sent[0].recipientExternalId).toBe("972500004815");
    for (const t of Object.values(RESEND_ASK)) expect(t).not.toMatch(/נתמכ|unsupported|support/i);
  });

  it("in English for an English conversation", async () => {
    await handleUndeliverable(input({ detectedLocale: "en-US" }));
    expect(H.sent[0].body).toBe(RESEND_ASK.en);
  });

  it("not twice within ten minutes; again after", async () => {
    await handleUndeliverable(input());
    await handleUndeliverable(input());
    expect(H.sent).toHaveLength(1);
    H.msgs[0].createdAt = new Date(Date.now() - RESEND_ASK_GAP_MS - 1000);
    await handleUndeliverable(input());
    expect(H.sent).toHaveLength(2);
  });

  it("an album (its pictures follow as their own messages), a reaction, or a person owning the chat: handled, nothing sent", async () => {
    expect(await handleUndeliverable(input({ metadata: album }))).toBe(true);
    expect(await handleUndeliverable(input({ metadata: reaction }))).toBe(true);
    expect(await handleUndeliverable(input({ humanOwned: true }))).toBe(true);
    expect(H.sent).toHaveLength(0);
  });

  it("an ordinary message is not this service's", async () => {
    expect(undeliverableAction({ contacts: [] })).toBeNull();
    expect(undeliverableAction(null)).toBeNull();
    expect(await handleUndeliverable(input({ metadata: { edited: { originalExternalId: "w" } } }))).toBe(false);
    expect(H.sent).toHaveLength(0);
  });

  it("the worker runs it before automations, the playbook and the AI, and stops when handled; the placeholder sets no language", () => {
    const src = readFileSync(join(__dirname, "../workers/incoming.worker.ts"), "utf8");
    const at = src.indexOf("await handleUndeliverable({");
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf("if (handled) return;", at)).toBeGreaterThan(at);
    expect(at).toBeLessThan(src.indexOf("automationsForInbound({"));
    expect(src).toContain("if ((producerMetadata as any)?.unsupported) return;\n      const { recordDetectedLocaleIfMissing }");
  });
});
