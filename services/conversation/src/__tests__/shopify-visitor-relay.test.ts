/**
 * Shopify Live Chat - realtime relay to storefront visitors.
 *
 * The visitor side of the socket is the one place where a bug becomes a
 * cross-tenant leak in real time, so these pin down exactly what leaves
 * for a shopper and which room it goes to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    conversation: { current: null as any },
    channel: { current: null as any },
    sockets: { current: [{ id: "s1" }] as any[] },
    emit: v.fn(),
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    prisma: {
      conversation: { findFirst: vi.fn(async () => H.conversation.current) },
      channelAccount: { findFirst: vi.fn(async () => H.channel.current) },
    },
  };
});

vi.mock("../lib/socket", () => ({
  getIO: () => ({
    to: () => ({ emit: H.emit }),
    in: () => ({ fetchSockets: async () => H.sockets.current }),
  }),
}));

import { relayToVisitor, relayConversationState, __resetVisitorRelayCache } from "../subscribers/shopify-visitor-relay";
import { defaultShopifyLiveChatConfig } from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";

function event(overrides: Record<string, any> = {}) {
  return {
    event: "message:new",
    tenantId: "t1",
    data: {
      conversationId: "conv1",
      channel: "SHOPIFY_LIVE_CHAT",
      message: {
        id: "m1",
        direction: "OUTBOUND",
        body: "Hello",
        messageType: "text",
        senderName: "AI Bot",
        metadata: { source: "ai_bot" },
        createdAt: new Date().toISOString(),
        ...(overrides.message ?? {}),
      },
      ...(overrides.data ?? {}),
    },
    ...overrides.root,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetVisitorRelayCache();
  H.sockets.current = [{ id: "s1" }];
  H.conversation.current = { channelAccountId: "ch1" };
  const config = defaultShopifyLiveChatConfig();
  config.shopDomain = SHOP;
  config.welcome.assistantName = "Store Assistant";
  H.channel.current = { platformMeta: { shopifyLiveChat: config } };
});

describe("relayToVisitor", () => {
  it("projects a message into the visitor's own room", async () => {
    await relayToVisitor(event() as any);
    expect(H.emit).toHaveBeenCalledTimes(1);
    const [name, payload] = H.emit.mock.calls[0];
    expect(name).toBe("visitor:message");
    expect(payload.conversationId).toBe("conv1");
    expect(payload.message.author).toBe("Store Assistant");
    expect(payload.message.authorKind).toBe("ai");
  });

  it("ignores every channel that is not Shopify Live Chat", async () => {
    await relayToVisitor(event({ data: { channel: "WHATSAPP" }, message: { channel: "WHATSAPP" } }) as any);
    expect(H.emit).not.toHaveBeenCalled();
  });

  it("ignores events that are not new messages", async () => {
    await relayToVisitor({ ...event(), event: "conversation:updated" } as any);
    expect(H.emit).not.toHaveBeenCalled();
  });

  it("does no database work when nobody has the widget open", async () => {
    // A busy storefront must not turn into a query storm for a room with
    // no listeners.
    H.sockets.current = [];
    const { prisma } = await import("@chatcenter/shared");
    await relayToVisitor(event() as any);
    expect(H.emit).not.toHaveBeenCalled();
    expect((prisma.conversation.findFirst as any)).not.toHaveBeenCalled();
  });

  it("scopes the conversation lookup to the event's tenant", async () => {
    // (case 48) The room name alone never decides what is sent.
    const { prisma } = await import("@chatcenter/shared");
    await relayToVisitor(event() as any);
    expect((prisma.conversation.findFirst as any).mock.calls[0][0].where).toMatchObject({
      id: "conv1",
      tenantId: "t1",
    });
  });

  it("sends nothing when the conversation is not this tenant's", async () => {
    H.conversation.current = null;
    await relayToVisitor(event() as any);
    expect(H.emit).not.toHaveBeenCalled();
  });

  it("strips an agent's email address before it reaches the shopper", async () => {
    await relayToVisitor(
      event({ message: { senderName: "dana.levi@merchant.com", metadata: {} } }) as any,
    );
    const payload = H.emit.mock.calls[0][1];
    expect(payload.message.author).toBe("dana levi");
    expect(JSON.stringify(payload)).not.toContain("@merchant.com");
  });

  it("does not relay system breadcrumbs", async () => {
    await relayToVisitor(
      event({ message: { messageType: "system", body: "", metadata: { systemEvent: "ai_bot_escalation" } } }) as any,
    );
    expect(H.emit).not.toHaveBeenCalled();
  });

  it("drops a commerce payload that belongs to another channel", async () => {
    // (case 49)
    await relayToVisitor(
      event({
        message: {
          messageType: "shopify_product",
          body: "Cloud Pro",
          metadata: {
            source: "ai_bot",
            shopify: {
              kind: "shopify_commerce",
              shopDomain: SHOP,
              channelAccountId: "SOME_OTHER_CHANNEL",
              addToCartEnabled: true,
              source: "ai",
              products: [{ shopDomain: SHOP, productId: "1", title: "x" }],
            },
          },
        },
      }) as any,
    );
    const payload = H.emit.mock.calls[0][1];
    expect(payload.message.commerce).toBeNull();
  });
});

describe("relayConversationState", () => {
  it("tells the widget when the conversation was handed to a human", () => {
    relayConversationState({
      event: "conversation:updated",
      tenantId: "t1",
      data: { id: "conv1", channel: "SHOPIFY_LIVE_CHAT", status: "WAITING", isHandedOver: true },
    } as any);
    expect(H.emit).toHaveBeenCalledWith("visitor:conversation", {
      conversationId: "conv1",
      status: "WAITING",
      isHandedOver: true,
    });
  });

  it("carries no message content", () => {
    relayConversationState({
      event: "conversation:closed",
      tenantId: "t1",
      data: { id: "conv1", channel: "SHOPIFY_LIVE_CHAT", status: "CLOSED", secret: "should not travel" },
    } as any);
    expect(JSON.stringify(H.emit.mock.calls[0][1])).not.toContain("should not travel");
  });

  it("ignores other channels", () => {
    relayConversationState({
      event: "conversation:updated",
      tenantId: "t1",
      data: { id: "conv1", channel: "WHATSAPP", status: "WAITING" },
    } as any);
    expect(H.emit).not.toHaveBeenCalled();
  });
});
