/**
 * The outgoing worker refuses a send the customer-service window does not
 * allow (B7, 2026-10-12), before the provider call, and never retries it.
 *
 * Without it a free-text WhatsApp send 44 days after the customer's last
 * message went to Meta, failed with 131047, and the retry sent it again: nine
 * failed sends in one conversation on dev. The window rule itself is
 * packages/shared lib/reply-window.ts (its SQL checked on the dev Postgres).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const adapter = {
    channel: "WHATSAPP",
    sendTextMessage: vi.fn(async (..._a: any[]) => "wamid.1" as string | null),
    sendTemplateMessage: vi.fn(async (..._a: any[]) => "wamid.t" as string | null),
    sendMediaMessage: vi.fn(async (..._a: any[]) => "wamid.m" as string | null),
  };
  return {
    adapter,
    lastInbound: null as Date | null,
    lastInboundFails: false,
    lookups: [] as any[],
    updates: [] as any[],
    events: [] as any[],
    scheduledId: null as string | null,
  };
});
const P = vi.hoisted(() => ({ prisma: null as any }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  P.prisma = {
    channelAccount: { findUnique: vi.fn(async () => ({ id: "ca1", externalId: "pnid", credentials: {} })) },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ metadata: { source: "approval_continuation" } })),
      update: vi.fn(async (a: any) => { H.updates.push(a.data); return { id: "m1", conversationId: "c1", createdAt: new Date(), scheduledMessageId: H.scheduledId }; }),
    },
    conversation: { updateMany: vi.fn(async () => ({ count: 1 })) },
    usageLog: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    scheduledMessage: { update: vi.fn(async () => ({})) },
  };
  return {
    ...actual,
    prisma: P.prisma,
    getOutboundAdapter: () => H.adapter,
    createWorker: vi.fn(),
    analyticsQueue: { add: vi.fn() },
    publishEvent: vi.fn(async (e: any) => { H.events.push(e); }),
    decryptCredentials: (v: any) => v,
    lastInboundAtForRecipient: vi.fn(async (a: any) => {
      H.lookups.push(a);
      if (H.lastInboundFails) throw new Error("db blip");
      return H.lastInbound;
    }),
  };
});
const broadcast = vi.hoisted(() => ({ results: [] as any[] }));
vi.mock("../workers/broadcast.worker", () => ({ recordBroadcastResult: vi.fn(async (r: any) => { broadcast.results.push(r); }) }));

import { processOutgoingMessage } from "../workers/outgoing.worker";

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
const job = (data: Record<string, unknown> = {}) =>
  ({ data: { tenantId: "t1", conversationId: "c1", channel: "WHATSAPP", channelAccountId: "ca1", recipientExternalId: "972541111111", body: "Following up", messageType: "text", messageId: "m1", ...data } }) as any;
const sent = () => H.adapter.sendTextMessage.mock.calls.length + H.adapter.sendTemplateMessage.mock.calls.length + H.adapter.sendMediaMessage.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  H.lastInbound = null; H.lastInboundFails = false; H.lookups = []; H.updates = []; H.events = []; H.scheduledId = null;
  broadcast.results = [];
});

describe("★ WhatsApp past 24h: only a template goes", () => {
  it("free text is refused before the provider call, FAILED with the reason, not retried", async () => {
    H.lastInbound = hoursAgo(30);
    await expect(processOutgoingMessage(job())).resolves.toBeUndefined();
    expect(sent()).toBe(0);
    const failed = H.updates.find((u) => u.status === "FAILED")!;
    expect(failed.metadata.sendError).toMatchObject({ channel: "WHATSAPP", phase: "send", type: "TEMPLATE_REQUIRED", retryable: false });
    expect(failed.metadata.source).toBe("approval_continuation"); // merged, not replaced
    expect(failed.errorMessage).toMatch(/24 hours/);
    expect(H.events[0]).toMatchObject({ event: "message:status", data: { messageId: "m1", status: "FAILED" } });
  });

  it("the lookup is for this customer on this channel and account", async () => {
    H.lastInbound = hoursAgo(30);
    await processOutgoingMessage(job());
    expect(H.lookups).toEqual([{ tenantId: "t1", channel: "WHATSAPP", channelAccountId: "ca1", customerExternalId: "972541111111" }]);
  });

  it("media is refused too", async () => {
    H.lastInbound = hoursAgo(30);
    await processOutgoingMessage(job({ messageType: "image", mediaUrl: "https://x/y.png" }));
    expect(sent()).toBe(0);
  });

  it("a template is sent", async () => {
    H.lastInbound = hoursAgo(30);
    await processOutgoingMessage(job({ messageType: "template", templateName: "gotcha_reopen", templateLanguage: "he" }));
    expect(H.adapter.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("a customer who never wrote: template only as well", async () => {
    H.lastInbound = null;
    await processOutgoingMessage(job());
    expect(sent()).toBe(0);
  });

  it("inside 24h free text is sent", async () => {
    H.lastInbound = hoursAgo(2);
    await processOutgoingMessage(job());
    expect(H.adapter.sendTextMessage).toHaveBeenCalledTimes(1);
  });
});

describe("★ Instagram past 24h: nothing goes", () => {
  it("refused with REPLY_WINDOW_CLOSED", async () => {
    H.lastInbound = hoursAgo(30);
    await processOutgoingMessage(job({ channel: "INSTAGRAM", recipientExternalId: "1031990639501705" }));
    expect(sent()).toBe(0);
    expect(H.updates.find((u) => u.status === "FAILED")!.metadata.sendError.type).toBe("REPLY_WINDOW_CLOSED");
  });
});

describe("the mirrors a failed send already had", () => {
  it("a scheduled message is marked FAILED with the reason", async () => {
    H.lastInbound = hoursAgo(30);
    H.scheduledId = "s1";
    await processOutgoingMessage(job());
    expect(P.prisma.scheduledMessage.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "FAILED", error: expect.stringMatching(/24 hours/) } });
  });

  it("a broadcast recipient is recorded as failed", async () => {
    H.lastInbound = hoursAgo(30);
    await processOutgoingMessage(job({ conversationId: undefined, broadcastId: "b1", broadcastRecipientId: "r1" }));
    expect(broadcast.results[0]).toMatchObject({ broadcastId: "b1", broadcastRecipientId: "r1", success: false });
  });
});

describe("no window, or no way to read it", () => {
  it("email never looks the window up", async () => {
    await processOutgoingMessage(job({ channel: "GMAIL", recipientExternalId: "a@b.c" }));
    expect(H.lookups).toHaveLength(0);
    expect(H.adapter.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("an unreadable window sends anyway (Meta decides, as before)", async () => {
    H.lastInboundFails = true;
    await processOutgoingMessage(job());
    expect(H.adapter.sendTextMessage).toHaveBeenCalledTimes(1);
  });
});
