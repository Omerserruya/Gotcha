/**
 * Shopify Live Chat — persistence of AI product messages.
 *
 * The AI service resolves and validates product cards but deliberately
 * does NOT write them: the worker does, AFTER the text reply, so the bot
 * explains its recommendation before the card appears. A card that lands
 * before its own reasoning reads like an ad.
 *
 * These pin down that ordering and the cases where a card must be
 * dropped entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    reply: { current: null as any },
    conversation: {
      current: {
        id: "conv1",
        tenantId: "t1",
        isHandedOver: false,
        assignedAgentId: null,
        assignedAiAgentId: "agent1",
        channel: "SHOPIFY_LIVE_CHAT",
        customerExternalId: "sfyv_visitor",
        createdAt: new Date(),
        channelAccount: { id: "ch1", externalId: "sfy_key", credentials: { accessToken: "x" } },
      } as any,
    },
    createMessage: v.fn(),
    countMessages: v.fn().mockResolvedValue(0),
    publish: v.fn().mockResolvedValue(undefined),
    axiosPost: v.fn(),
  };
});

vi.mock("axios", () => ({
  default: { post: H.axiosPost },
}));

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    conversation: {
      findFirst: vi.fn(async () => H.conversation.current),
      findUnique: vi.fn(async () => ({ createdAt: new Date() })),
      update: vi.fn().mockResolvedValue({}),
    },
    aIAgent: {
      findUnique: vi.fn(async () => ({
        id: "agent1",
        tenantId: "t1",
        escalationMessage: "Connecting you now.",
        maxAutonomousMessages: 10,
        maxAutonomousMinutes: 60,
        status: "ACTIVE",
      })),
    },
    message: {
      create: H.createMessage,
      count: H.countMessages,
      findMany: vi.fn().mockResolvedValue([]),
    },
    usageLog: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  getOutboundAdapter: () => ({
    sendTextMessage: vi.fn(async () => "sfychat_ext_1"),
  }),
  decryptCredentials: (v: any) => v,
  publishEvent: H.publish,
}));

import { processAIBot } from "../services/ai-bot.service";

const CARD = {
  messageType: "shopify_product",
  body: "Cloud Pro Runner (120.00 USD) https://demo.myshopify.com/products/cloud-pro",
  metadata: {
    source: "ai_bot",
    shopify: {
      kind: "shopify_commerce",
      shopDomain: "demo.myshopify.com",
      channelAccountId: "ch1",
      addToCartEnabled: true,
      source: "ai",
      products: [{ shopDomain: "demo.myshopify.com", productId: "111", title: "Cloud Pro Runner" }],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  H.countMessages.mockResolvedValue(0);
  let seq = 0;
  H.createMessage.mockImplementation(async ({ data }: any) => ({
    id: `msg${++seq}`,
    createdAt: new Date(),
    ...data,
  }));
  H.axiosPost.mockImplementation(async () => ({ data: H.reply.current }));
  H.reply.current = {
    reply: "For long runs I would start with the Cloud Pro.",
    escalation: null,
    awaitingApproval: null,
    toolCallLog: [],
    modelUsed: "gpt-4o-mini",
    totalTokens: 100,
    structuredMessages: [CARD],
  };
});

describe("structured product messages", () => {
  it("persists the text reply first, then the card", async () => {
    await processAIBot("t1", "conv1", "is this good for long runs?");

    const created = H.createMessage.mock.calls.map((c: any[]) => c[0].data);
    expect(created).toHaveLength(2);
    expect(created[0].messageType ?? "text").toBe("text");
    expect(created[0].body).toContain("Cloud Pro");
    expect(created[1].messageType).toBe("shopify_product");
    expect(created[1].metadata.shopify.channelAccountId).toBe("ch1");
    expect(created[1].channel).toBe("SHOPIFY_LIVE_CHAT");
    expect(created[1].direction).toBe("OUTBOUND");
  });

  it("announces the card on the realtime bus so the widget sees it", async () => {
    await processAIBot("t1", "conv1", "hi");
    const events = H.publish.mock.calls.map((c: any[]) => c[0]);
    const messageEvents = events.filter((e: any) => e.event === "message:new");
    expect(messageEvents).toHaveLength(2);
    expect(messageEvents[1].data.message.messageType).toBe("shopify_product");
  });

  it("sends nothing extra when the AI staged nothing", async () => {
    H.reply.current = { ...H.reply.current, structuredMessages: undefined };
    await processAIBot("t1", "conv1", "hi");
    expect(H.createMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the reply when a card fails to persist", async () => {
    // A card that cannot be written must not lose a reply that was
    // already delivered to the customer.
    let call = 0;
    H.createMessage.mockImplementation(async ({ data }: any) => {
      call++;
      if (call === 2) throw new Error("db down");
      return { id: `msg${call}`, createdAt: new Date(), ...data };
    });
    await expect(processAIBot("t1", "conv1", "hi")).resolves.toBe(true);
  });

  it("drops staged cards entirely on escalation", async () => {
    // A product suggestion arriving after "let me get a colleague" is
    // noise. The AI service already withholds them; the worker never
    // reaches the persist loop on this path either.
    H.reply.current = {
      reply: null,
      escalation: { reason: "customer asked for a human" },
      awaitingApproval: null,
      toolCallLog: [],
      modelUsed: "gpt-4o-mini",
      totalTokens: 10,
      structuredMessages: [CARD],
    };
    await processAIBot("t1", "conv1", "I want a person");

    const types = H.createMessage.mock.calls.map((c: any[]) => c[0].data.messageType);
    expect(types).not.toContain("shopify_product");
  });
});
