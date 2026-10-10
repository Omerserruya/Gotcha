/**
 * metadata.media on the stored row (2026-10-09), through dispatch():
 *
 *   - ★ an inbound WhatsApp attachment carries { mimeType, byteSize,
 *     originalName }, merged beside the producer's metadata, never replacing it
 *   - a download that failed still names what was declared (byteSize null)
 *   - ★ a sticker is stored as messageType "sticker" and downloaded like an image
 *   - a Coexistence echo carries the same facts
 *   - no provider URL or token ever lands in metadata
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { get, head, prisma } = vi.hoisted(() => {
  const prisma = {
    tenant: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
    message: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (a: any) => ({ id: "m1", createdAt: new Date(), ...a.data })),
      count: vi.fn(async () => 1),
    },
    conversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    channelAccount: { findUnique: vi.fn(async () => ({ id: "ca1", externalId: "pn1", displayName: "Shop", credentials: "enc" })) },
    contact: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })), findFirst: vi.fn(async () => null) },
  };
  return { get: vi.fn(), head: vi.fn(), prisma };
});
vi.mock("axios", () => ({ default: { get, head, post: vi.fn(async () => ({ data: {} })) } }));
vi.mock("fs", () => {
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  return { default: { writeFileSync, mkdirSync }, writeFileSync, mkdirSync };
});

vi.mock("@chatcenter/shared", () => ({
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: () => "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma,
  publishEvent: vi.fn(async () => undefined),
  isInboundExcluded: vi.fn(async () => false),
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
  decryptCredentials: vi.fn(() => ({ accessToken: "SECRET_TOKEN" })),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  resolveContactByChannelId: vi.fn(async () => null),
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
}));
vi.mock("../services/whatsapp-approval-inbound.service", () => ({ handleApprovalButtonReply: vi.fn(async () => ({ handled: false })) }));
vi.mock("../services/comment-trigger.service", () => ({ processCommentTrigger: vi.fn() }));
vi.mock("../services/ensure-contact.service", () => ({ ensureContactForInbound: vi.fn(async () => ({ id: "k1", displayName: "Dana", avatarUrl: "a" })) }));
vi.mock("../services/locale-detect.service", () => ({ recordDetectedLocaleIfMissing: vi.fn(async () => undefined) }));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn(async () => undefined) }));
vi.mock("../services/whatsapp-handoff-link.service", () => ({ linkWebsiteHandoff: vi.fn(async () => ({ linked: false })) }));
vi.mock("../services/automation-runner.service", () => ({
  automationsForInbound: vi.fn(async () => true),
  automationAnsweredBefore: vi.fn(async () => false),
}));
vi.mock("../services/ai-bot.service", () => ({ processAIBot: vi.fn(async () => true) }));
vi.mock("../services/routing.service", () => ({ routeConversation: vi.fn(async () => ({ handledByAI: true })) }));
vi.mock("../services/flow-executor.service", () => ({ executeMainFlow: vi.fn(), executeSubFlow: vi.fn() }));

import { dispatch } from "../workers/incoming.worker";

const CONV = {
  id: "c1", tenantId: "t1", channel: "WHATSAPP", customerExternalId: "9725", status: "OPEN",
  customerName: "Dana", customerAvatarUrl: "a",
  assignedAgentId: null, isHandedOver: false, departmentId: null, handledBy: null, assignedAiAgentId: null,
  chatbotNodeId: null, chatbotFlowId: null, automationRunId: null, flowExpiresAt: null,
};

const BYTES = Buffer.from("0123456789abcdef"); // 16 bytes

function mockDownload(contentType: string) {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("https://cdn.example")) return { data: BYTES, headers: { "content-type": contentType } };
    return { data: { url: "https://cdn.example/f?token=CDN_SIG" } };
  });
}

const inbound = (n: Record<string, unknown>) => ({
  name: "process",
  data: {
    tenantId: "t1", channel: "WHATSAPP", channelAccountId: "ca1",
    normalizedMessage: { externalMessageId: "wamid.1", senderId: "9725", timestamp: new Date().toISOString(), ...n },
  },
}) as any;

const created = () => prisma.message.create.mock.calls.map((c: any[]) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.conversation.findFirst.mockImplementation(async () => ({ ...CONV }));
  mockDownload("application/octet-stream");
});

describe("★ inbound WhatsApp media keeps its facts on the row", () => {
  it("document: declared mime, bytes received, sender's name, beside the producer's metadata", async () => {
    await dispatch(inbound({
      contentType: "document", body: "contract.pdf", messageType: "document",
      mediaUrl: "MEDIA_1", fileName: "contract.pdf", mimeType: "application/pdf",
      metadata: { unsupported: { providerType: "x", errors: [] } },
    }));

    const row = created()[0];
    expect(row.messageType).toBe("document");
    expect(row.mediaUrl).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}\.pdf$/);
    expect(row.metadata).toEqual({
      unsupported: { providerType: "x", errors: [] },
      media: { mimeType: "application/pdf", byteSize: 16, originalName: "contract.pdf" },
    });
    const json = JSON.stringify(row.metadata);
    expect(json).not.toContain("SECRET_TOKEN");
    expect(json).not.toContain("cdn.example");
    expect(json).not.toContain("MEDIA_1");
  });

  it("a failed download still names what was declared, with no size", async () => {
    get.mockReset();
    get.mockRejectedValue(new Error("404"));

    await dispatch(inbound({
      contentType: "document", body: "contract.pdf", messageType: "document",
      mediaUrl: "MEDIA_GONE", fileName: "contract.pdf", mimeType: "application/pdf",
    }));

    const row = created()[0];
    expect(row.mediaUrl).toBeUndefined();
    expect(row.metadata).toEqual({
      mediaError: "download_failed",
      media: { mimeType: "application/pdf", byteSize: null, originalName: "contract.pdf" },
    });
  });

  it("★ a sticker is stored as a sticker and downloaded like an image", async () => {
    mockDownload("image/webp");

    await dispatch(inbound({
      contentType: "sticker", body: "[Sticker]", messageType: "sticker",
      mediaUrl: "MEDIA_STK", mimeType: "image/webp",
    }));

    const row = created()[0];
    expect(row.messageType).toBe("sticker");
    expect(row.body).toBe("[Sticker]");
    expect(row.mediaUrl).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}\.webp$/);
    // No sender name: a readable default, never the uuid (2026-10-10).
    expect(row.metadata.media).toEqual({ mimeType: "image/webp", byteSize: 16, originalName: expect.stringMatching(/^sticker-\d{4}-\d{2}-\d{2}\.webp$/) });
    expect(row.fileName).toBe(row.metadata.media.originalName);
  });

  it("a text message gets no media facts", async () => {
    await dispatch(inbound({ contentType: "text", body: "hi", messageType: "text" }));

    expect(created()[0].metadata).toBeUndefined();
  });
});

describe("★ a Coexistence echo keeps the same facts", () => {
  it("merged beside the echo's own markers", async () => {
    mockDownload("image/jpeg");

    await dispatch({
      name: "process-echo",
      data: {
        tenantId: "t1", channel: "WHATSAPP", channelAccountId: "ca1",
        echo: {
          externalMessageId: "wamid.E1", customerExternalId: "9725", businessExternalId: "9720",
          timestamp: "2026-10-09T10:00:00.000Z", contentType: "image", body: "[Image]", messageType: "image",
          mediaUrl: "MEDIA_E", mimeType: "image/jpeg",
        },
      },
    } as any);

    const row = created().find((d: any) => d.externalMessageId === "wamid.E1");
    expect(row.metadata).toEqual({
      source: "whatsapp_business_app",
      echo: true,
      businessExternalId: "9720",
      media: { mimeType: "image/jpeg", byteSize: 16, originalName: null },
    });
    expect(JSON.stringify(row.metadata)).not.toMatch(/SECRET_TOKEN|cdn\.example|MEDIA_E/);
  });

  it("a failed echo download still names what was declared", async () => {
    get.mockReset();
    get.mockRejectedValue(new Error("404"));

    await dispatch({
      name: "process-echo",
      data: {
        tenantId: "t1", channel: "WHATSAPP", channelAccountId: "ca1",
        echo: {
          externalMessageId: "wamid.E2", customerExternalId: "9725",
          timestamp: "2026-10-09T10:00:00.000Z", contentType: "document", body: "a.pdf", messageType: "document",
          mediaUrl: "MEDIA_E2", fileName: "a.pdf", mimeType: "application/pdf",
        },
      },
    } as any);

    const row = created().find((d: any) => d.externalMessageId === "wamid.E2");
    expect(row.metadata).toMatchObject({
      mediaError: "download_failed",
      media: { mimeType: "application/pdf", byteSize: null, originalName: "a.pdf" },
    });
  });
});


describe("★ Messenger and Instagram media get their facts too (2026-10-10)", () => {
  const meta = (channel: string, n: Record<string, unknown>) => {
    const j = inbound(n);
    j.data.channel = channel;
    return j;
  };

  it("one HEAD to Meta's CDN gives the type and size; the CDN URL is kept as the media URL", async () => {
    head.mockResolvedValueOnce({ headers: { "content-type": "image/jpeg; charset=binary", "content-length": "2048" } });
    await dispatch(meta("MESSENGER", { contentType: "image", body: "[Image]", messageType: "image", mediaUrl: "https://scontent.xx.fbcdn.net/v/t1/x.jpg?sig=1" }));
    const row = created()[0];
    expect(head).toHaveBeenCalledWith("https://scontent.xx.fbcdn.net/v/t1/x.jpg?sig=1", expect.objectContaining({ timeout: 4000 }));
    expect(row.mediaUrl).toBe("https://scontent.xx.fbcdn.net/v/t1/x.jpg?sig=1");
    expect(row.metadata.media).toEqual({ mimeType: "image/jpeg", byteSize: 2048, originalName: expect.stringMatching(/^image-\d{4}-\d{2}-\d{2}\.jpg$/) });
    expect(row.fileName).toBe(row.metadata.media.originalName);
  });

  it("a sender's file name is kept", async () => {
    head.mockResolvedValueOnce({ headers: { "content-type": "application/pdf", "content-length": "99" } });
    await dispatch(meta("INSTAGRAM", { contentType: "document", body: "x", messageType: "document", mediaUrl: "https://lookaside.fbsbx.com/ig/x", fileName: "menu.pdf" }));
    expect(created()[0].metadata.media).toEqual({ mimeType: "application/pdf", byteSize: 99, originalName: "menu.pdf" });
    expect(created()[0].fileName).toBe("menu.pdf");
  });

  it("a host that is not Meta's is never fetched; the HEAD failing changes nothing else", async () => {
    await dispatch(meta("MESSENGER", { contentType: "image", body: "[Image]", messageType: "image", mediaUrl: "https://evil.example/x.jpg" }));
    expect(head).not.toHaveBeenCalled();
    expect(created()[0].metadata.media).toMatchObject({ mimeType: null, byteSize: null });
    head.mockRejectedValueOnce(new Error("timeout"));
    await dispatch(meta("MESSENGER", { contentType: "image", body: "[Image]", messageType: "image", mediaUrl: "https://scontent.cdninstagram.com/x.jpg" }));
    expect(created()[1]).toMatchObject({ messageType: "image", mediaUrl: "https://scontent.cdninstagram.com/x.jpg" });
    expect(created()[1].metadata.media).toMatchObject({ mimeType: null, byteSize: null });
  });
});

describe("★ an unnamed WhatsApp file gets a readable name (2026-10-10)", () => {
  it("document without a name: file-<date>.pdf on the facts and the bubble", async () => {
    mockDownload("application/pdf");
    await dispatch(inbound({ contentType: "document", body: "[Document]", messageType: "document", mediaUrl: "MEDIA_2", mimeType: "application/pdf" }));
    const row = created()[0];
    expect(row.metadata.media.originalName).toMatch(/^file-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(row.fileName).toBe(row.metadata.media.originalName);
  });

  it("voice note: voice-<date>.ogg", async () => {
    mockDownload("audio/ogg");
    await dispatch(inbound({ contentType: "audio", body: "[Voice message]", messageType: "audio", mediaUrl: "MEDIA_3", mimeType: "audio/ogg; codecs=opus" }));
    expect(created()[0].metadata.media.originalName).toMatch(/^voice-\d{4}-\d{2}-\d{2}\.ogg$/);
  });
});
