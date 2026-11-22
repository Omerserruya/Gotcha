/**
 * W2 (2026-11-22): the "leave your number" template sent from the business's WABA fails with Meta
 * 131042 (the WABA cannot pay): the number's payment block is recorded, so the widget offers the
 * WhatsApp link instead for a day. Any other failure, or any other message, records nothing.
 * Meta is never reached: the adapter is a double.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  meta: { source: "website_phone_handoff" } as any,
  fail: null as any,
  settings: new Map<string, string>(),
}));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: { findUnique: vi.fn(async () => ({ id: "wa_1", externalId: "pnid", credentials: {} })) },
      message: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => ({ metadata: H.meta })),
        update: vi.fn(async () => ({ id: "m1", conversationId: null, createdAt: new Date(), scheduledMessageId: null })),
      },
      conversation: { updateMany: vi.fn(async () => ({ count: 1 })) },
      usageLog: { create: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
      scheduledMessage: { update: vi.fn(async () => ({})) },
    },
    getOutboundAdapter: () => ({
      channel: "WHATSAPP",
      sendTemplateMessage: vi.fn(async () => { if (H.fail) throw H.fail; return "wamid.t"; }),
      sendTextMessage: vi.fn(async () => "wamid.1"),
    }),
    describeSendError: (err: any) => ({ errorMessage: err.message, sendError: { channel: "WHATSAPP", phase: "send", code: err.code, message: err.message, retryable: false, at: new Date().toISOString() } }),
    createWorker: vi.fn(),
    analyticsQueue: { add: vi.fn() },
    publishEvent: vi.fn(async () => undefined),
    decryptCredentials: (v: any) => v,
    lastInboundAtForRecipient: vi.fn(async () => null),
    readDurableSetting: async (_t: string, k: string) => H.settings.get(k) ?? null,
    writeDurableSetting: async (_t: string, k: string, v: string | null) => { if (v === null) H.settings.delete(k); else H.settings.set(k, v); },
  };
});
vi.mock("../workers/broadcast.worker", () => ({ recordBroadcastResult: vi.fn(async () => undefined) }));

import { processOutgoingMessage } from "../workers/outgoing.worker";

const job = () => ({ data: { tenantId: "T", conversationId: null, channel: "WHATSAPP", channelAccountId: "wa_1", recipientExternalId: "972541234567", body: "x", messageType: "template", templateName: "website_chat_handoff", templateLanguage: "he", messageId: "m1" } } as any);
const KEY = "waPhoneHandoffPaymentBlock:wa_1";

beforeEach(() => { H.settings.clear(); H.meta = { source: "website_phone_handoff" }; H.fail = null; vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("the payment signal at send time", () => {
  it("★ 131042 on the handoff template: the number is blocked, logged without the visitor's number", async () => {
    H.fail = Object.assign(new Error("Business eligibility payment issue"), { code: 131042 });
    await processOutgoingMessage(job()).catch(() => undefined);
    expect(JSON.parse(H.settings.get(KEY)!)).toMatchObject({ code: 131042, phase: "send" });
    const logged = (console.warn as any).mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(logged).not.toContain("972541234567");
  });
  it("another error, a sent template, or another message's 131042: nothing recorded", async () => {
    H.fail = Object.assign(new Error("other"), { code: 131026 });
    await processOutgoingMessage(job()).catch(() => undefined);
    H.fail = null;
    await processOutgoingMessage(job()).catch(() => undefined);
    H.fail = Object.assign(new Error("pay"), { code: 131042 });
    H.meta = { source: "broadcast" };
    await processOutgoingMessage(job()).catch(() => undefined);
    expect(H.settings.has(KEY)).toBe(false);
  });
});
