/**
 * ★ A provider fetches an agent's upload from a short-lived signed link minted
 * at send time, never from the public /api/uploads (2026-10-10, uploads plan
 * step 3). Meta CDN and operator-entered links pass through unchanged.
 * Through processOutgoingMessage, with the real signer and verifier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prisma, adapter } = vi.hoisted(() => {
  process.env.CHANNEL_ENCRYPTION_KEY = "test-channel-key";
  const adapter = {
    channel: "WHATSAPP",
    sendTextMessage: vi.fn(async (..._args: any[]) => "wamid.text" as string | null),
    sendMediaMessage: vi.fn(async (..._args: any[]) => "wamid.media" as string | null),
  };
  return {
    adapter,
    prisma: {
      channelAccount: { findUnique: vi.fn() },
      message: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      conversation: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
      usageLog: { create: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
      scheduledMessage: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    },
  };
});

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma,
    getOutboundAdapter: vi.fn(() => adapter),
    createWorker: vi.fn(),
    analyticsQueue: { add: vi.fn() },
    publishEvent: vi.fn(async () => undefined),
    decryptCredentials: (v: any) => v,
  };
});
vi.mock("../workers/broadcast.worker", () => ({ recordBroadcastResult: vi.fn(async () => undefined) }));

import { processOutgoingMessage } from "../workers/outgoing.worker";
import { OUTBOUND_MEDIA_TTL_SECONDS } from "../lib/outbound-media-url";
import { verifyMediaSignature } from "@chatcenter/shared/src/lib/media-url";

const NAME = "11111111-2222-4333-8444-555555555555.jpg";

function job(data: Record<string, unknown> = {}) {
  return {
    data: {
      tenantId: "t1",
      conversationId: "c1",
      channel: "WHATSAPP",
      channelAccountId: "ca1",
      recipientExternalId: "9725",
      body: "",
      messageType: "image",
      senderName: "agent@acme.test",
      messageId: "m_new",
      mediaUrl: `/api/uploads/${NAME}`,
      publicBaseUrl: "https://app.example.test",
      fileName: "photo.jpg",
      ...data,
    },
  } as any;
}

const sentUrl = () => adapter.sendMediaMessage.mock.calls[0]?.[3] as string;
let savedPublicUrl: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedPublicUrl = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  prisma.channelAccount.findUnique.mockResolvedValue({ id: "ca1", externalId: "pn1", credentials: { accessToken: "at" } });
  prisma.message.findUnique.mockResolvedValue({ metadata: {} });
  prisma.message.update.mockResolvedValue({ id: "m_new", conversationId: "c1" });
});
afterEach(() => { if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = savedPublicUrl; });

describe("★ an agent's upload goes out as a signed link", () => {
  it("signs /api/media/s/<messageId> for this message and tenant, for 15 minutes", async () => {
    const before = Math.floor(Date.now() / 1000);
    await processOutgoingMessage(job());
    const u = new URL(sentUrl());
    expect(u.origin).toBe("https://app.example.test");
    expect(u.pathname).toBe("/api/media/s/m_new");
    expect(sentUrl()).not.toContain("/api/uploads");
    const exp = Number(u.searchParams.get("exp"));
    const sig = u.searchParams.get("sig");
    expect(exp - before).toBeGreaterThanOrEqual(OUTBOUND_MEDIA_TTL_SECONDS);
    expect(exp - before).toBeLessThanOrEqual(OUTBOUND_MEDIA_TTL_SECONDS + 1);
    expect(OUTBOUND_MEDIA_TTL_SECONDS).toBe(900);
    expect(verifyMediaSignature({ messageId: "m_new", tenantId: "t1", exp, sig })).toBe(true);
    expect(verifyMediaSignature({ messageId: "m_other", tenantId: "t1", exp, sig })).toBe(false);
    expect(verifyMediaSignature({ messageId: "m_new", tenantId: "t2", exp, sig })).toBe(false);
    expect(prisma.message.update.mock.calls[0][0].data.status).toBe("SENT");
  });

  it("the worker's own PUBLIC_URL wins over the job's, and a trailing slash is dropped", async () => {
    process.env.PUBLIC_URL = "https://own.example.test/";
    await processOutgoingMessage(job());
    expect(sentUrl().startsWith("https://own.example.test/api/media/s/m_new?exp=")).toBe(true);
  });

  it("a Meta CDN link, an operator's link and a non-upload relative path pass through unchanged", async () => {
    for (const link of [
      "https://scontent.xx.fbcdn.net/v/abc.jpg?oh=1",
      "https://shop.example.com/banner.png",
      `https://app.example.test/api/uploads/${NAME}`,
    ]) {
      adapter.sendMediaMessage.mockClear();
      await processOutgoingMessage(job({ mediaUrl: link }));
      expect(sentUrl(), link).toBe(link);
    }
  });

  it("with no public origin the send FAILS with a reason, and nothing is handed to the provider", async () => {
    // FAILED, then thrown so BullMQ retries, as for any failed send.
    await expect(processOutgoingMessage(job({ publicBaseUrl: undefined }))).rejects.toThrow(/send failed/);
    expect(adapter.sendMediaMessage).not.toHaveBeenCalled();
    const data = prisma.message.update.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(String(data.errorMessage)).toMatch(/public origin/);
  });

  it("a text send is untouched", async () => {
    await processOutgoingMessage(job({ messageType: "text", body: "hi", mediaUrl: undefined }));
    expect(adapter.sendMediaMessage).not.toHaveBeenCalled();
    expect(adapter.sendTextMessage).toHaveBeenCalled();
  });
});
