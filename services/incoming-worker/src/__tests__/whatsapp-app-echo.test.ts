import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Business-app echo handling: the owner answers a customer from the WhatsApp
 * Business app on their phone (Coexistence) and Meta mirrors it to us.
 *
 * What must hold, and why each one bites if it doesn't:
 *   - the row is OUTBOUND (an inbound row would make the bot answer the owner)
 *   - the AI stops, because a human just spoke in the thread
 *   - a parked flow cursor is cleared (otherwise the flow resumes and talks
 *     over the person who took over)
 *   - re-delivery is a no-op (Meta redelivers on any non-2xx)
 */

const { prisma, publishEvent } = vi.hoisted(() => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    message: { findFirst: vi.fn(), create: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    channelAccount: { findUnique: vi.fn() },
  },
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@chatcenter/shared", () => ({
  prisma,
  publishEvent,
  decryptCredentials: vi.fn(),
  resolveContactByChannelId: vi.fn().mockResolvedValue(null),
  isInboundExcluded: vi.fn().mockResolvedValue(false),
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
}));

import { processOutboundEcho } from "../services/outbound-echo.service";

const JOB = {
  name: "process-echo",
  data: {
    tenantId: "t1",
    channel: "WHATSAPP",
    channelAccountId: "ca1",
    echo: {
      externalMessageId: "wamid.ECHO1",
      customerExternalId: "972541111111",
      businessExternalId: "972500000000",
      timestamp: "2026-08-14T10:00:00.000Z",
      contentType: "text",
      body: "אני מטפל בזה",
      messageType: "text",
    },
  },
} as any;

const AI_DRIVEN_CONVERSATION = {
  id: "c1",
  tenantId: "t1",
  channel: "WHATSAPP",
  customerExternalId: "972541111111",
  isHandedOver: false,
  assignedAgentId: null,
  chatbotFlowId: "f1",
  chatbotNodeId: "n7",
  status: "OPEN",
};

function messageCreateCalls() {
  return prisma.message.create.mock.calls.map((c: any[]) => c[0].data);
}

describe("WhatsApp business-app echo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.tenant.findUnique.mockResolvedValue({ status: "ACTIVE" });
    prisma.message.findFirst.mockResolvedValue(null);
    prisma.message.create.mockImplementation(async (args: any) => ({ id: "m1", ...args.data }));
    prisma.channelAccount.findUnique.mockResolvedValue({ id: "ca1", displayName: "GOTCHA Sales", credentials: {} });
    prisma.conversation.findFirst.mockResolvedValue({ ...AI_DRIVEN_CONVERSATION });
    prisma.conversation.update.mockImplementation(async (args: any) => ({ ...AI_DRIVEN_CONVERSATION, ...args.data }));
    prisma.conversation.create.mockImplementation(async (args: any) => ({ id: "c-new", ...args.data }));
  });

  it("writes the owner's message into the customer's thread as OUTBOUND", async () => {
    await processOutboundEcho(JOB);

    const echoRow = messageCreateCalls().find((d: any) => d.externalMessageId === "wamid.ECHO1");
    expect(echoRow).toMatchObject({
      conversationId: "c1",
      direction: "OUTBOUND",
      body: "אני מטפל בזה",
      status: "DELIVERED",
      senderName: "GOTCHA Sales",
    });
    expect(echoRow.metadata).toMatchObject({ source: "whatsapp_business_app", echo: true });
  });

  it("stops the AI and clears the parked flow cursor", async () => {
    await processOutboundEcho(JOB);

    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: expect.objectContaining({
          isHandedOver: true,
          handledBy: "human",
          status: "OPEN",
          chatbotFlowId: null,
          chatbotNodeId: null,
        }),
      }),
    );
  });

  it("explains the takeover on the timeline", async () => {
    await processOutboundEcho(JOB);

    const divider = messageCreateCalls().find((d: any) => d.messageType === "system");
    expect(divider?.metadata).toMatchObject({ systemEvent: "whatsapp_app_takeover" });
  });

  it("leaves an already-human conversation alone - no second takeover divider", async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      ...AI_DRIVEN_CONVERSATION,
      isHandedOver: true,
      assignedAgentId: "u1",
      chatbotFlowId: null,
      chatbotNodeId: null,
    });

    await processOutboundEcho(JOB);

    expect(messageCreateCalls().some((d: any) => d.messageType === "system")).toBe(false);
    // Only the timestamp moves; ownership is not rewritten under the agent.
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { lastMessageAt: expect.any(Date) },
    });
  });

  it("is idempotent - a redelivered echo writes nothing", async () => {
    prisma.message.findFirst.mockResolvedValue({ id: "already-there" });

    await processOutboundEcho(JOB);

    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("opens a human-owned conversation when the business messages someone new", async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await processOutboundEcho(JOB);

    expect(prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerExternalId: "972541111111",
          isHandedOver: true,
          handledBy: "human",
        }),
      }),
    );
    // No divider: nothing was taken over, the thread started human-owned.
    expect(messageCreateCalls().some((d: any) => d.messageType === "system")).toBe(false);
  });

  it("skips a non-active tenant entirely", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: "SUSPENDED" });

    await processOutboundEcho(JOB);

    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
