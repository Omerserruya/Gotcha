import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHERE the exclusion is enforced, which matters as much as whether.
 *
 * The check has to happen before any Contact, Conversation or Message row
 * exists. One step later and the thread is already created, an agent has
 * already been notified, and a bot may already have answered a conversation
 * that was never meant to reach the team - deleting it afterwards does not
 * undo any of that.
 *
 * Both ingest paths are covered. Guarding only the inbound one leaves an
 * excluded number HALF excluded: the customer's messages are dropped while the
 * owner's own replies from the Business app still open a conversation for
 * them, which is the private thread appearing in the shared inbox with only
 * one side of it visible.
 */

const { isInboundExcluded, prisma, publishEvent } = vi.hoisted(() => ({
  isInboundExcluded: vi.fn().mockResolvedValue(false),
  prisma: {
    tenant: { findUnique: vi.fn() },
    message: { findFirst: vi.fn(), create: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    channelAccount: { findUnique: vi.fn() },
    contact: { update: vi.fn() },
  },
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@chatcenter/shared", () => ({
  // The uploads write probe runs at module load. Stubbed as writable so these
  // tests exercise their own subject rather than the storage check.
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: (err: any) =>
    err?.code === "EACCES" || err?.code === "EPERM" || err?.code === "EROFS"
      ? "storage_unwritable"
      : "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma,
  publishEvent,
  isInboundExcluded,
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
  decryptCredentials: vi.fn(() => ({})),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  resolveContactByChannelId: vi.fn().mockResolvedValue(null),
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
}));
vi.mock("../services/whatsapp-approval-inbound.service", () => ({ handleApprovalButtonReply: vi.fn() }));
vi.mock("../services/comment-trigger.service", () => ({ processCommentTrigger: vi.fn() }));

import { dispatch } from "../workers/incoming.worker";
import { processOutboundEcho } from "../services/outbound-echo.service";

const INBOUND_JOB = {
  name: "process",
  data: {
    tenantId: "t1",
    channel: "WHATSAPP",
    channelAccountId: "ca1",
    normalizedMessage: {
      externalMessageId: "wamid.1",
      senderId: "972541111111",
      timestamp: new Date().toISOString(),
      contentType: "text",
      body: "private matter",
      messageType: "text",
    },
  },
} as any;

const ECHO_JOB = {
  name: "process-echo",
  data: {
    tenantId: "t1",
    channel: "WHATSAPP",
    channelAccountId: "ca1",
    echo: {
      externalMessageId: "wamid.ECHO1",
      customerExternalId: "972541111111",
      timestamp: new Date().toISOString(),
      contentType: "text",
      body: "answered from my phone",
      messageType: "text",
    },
  },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ status: "ACTIVE" });
  prisma.message.findFirst.mockResolvedValue(null);
  prisma.message.create.mockImplementation(async (a: any) => ({ id: "m1", ...a.data }));
  prisma.conversation.findFirst.mockResolvedValue(null);
  prisma.conversation.create.mockImplementation(async (a: any) => ({ id: "c1", ...a.data }));
  prisma.conversation.update.mockResolvedValue({});
  prisma.channelAccount.findUnique.mockResolvedValue({ id: "ca1", displayName: "Biz", credentials: {} });
  isInboundExcluded.mockResolvedValue(false);
});

describe("an excluded number on the inbound path", () => {
  it("creates nothing at all", async () => {
    isInboundExcluded.mockResolvedValue(true);

    await dispatch(INBOUND_JOB);

    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("is checked with the account that received it, so a per-number rule can apply", async () => {
    await dispatch(INBOUND_JOB);

    expect(isInboundExcluded).toHaveBeenCalledWith({
      tenantId: "t1",
      channel: "WHATSAPP",
      customerExternalId: "972541111111",
      channelAccountId: "ca1",
    });
  });

  it("lets everyone else straight through", async () => {
    await dispatch(INBOUND_JOB);

    expect(prisma.conversation.create).toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });
});

describe("an excluded number on the business-app echo path", () => {
  it("creates nothing - otherwise the private thread appears one-sided", async () => {
    isInboundExcluded.mockResolvedValue(true);

    await processOutboundEcho(ECHO_JOB);

    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("does not even reach the idempotency read", async () => {
    // Proves the guard is genuinely first, rather than merely early.
    isInboundExcluded.mockResolvedValue(true);

    await processOutboundEcho(ECHO_JOB);

    expect(prisma.message.findFirst).not.toHaveBeenCalled();
  });

  it("still records the owner's reply for a number that is not excluded", async () => {
    await processOutboundEcho(ECHO_JOB);

    expect(prisma.message.create).toHaveBeenCalled();
  });
});
