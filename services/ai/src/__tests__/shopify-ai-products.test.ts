/**
 * Shopify Live Chat — what the AI employee can and cannot do with
 * products.
 *
 * The claim under test is "the AI cannot invent a product". These prove
 * the mechanism: the tools accept references only, every reference is
 * re-resolved against Shopify, and an id the model made up resolves to
 * nothing and is reported back as such.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => {
  const v: any = vi;
  return {
    conversation: { current: null as any },
    lastInbound: { current: null as any },
    features: { current: {} as Record<string, boolean> },
    store: { current: null as any },
    snapshots: { current: [] as any[] },
    productByHandle: { current: null as any },
    gate: { current: { decision: "ALLOW", reason: "ok" } as any },
  };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isFeatureEnabledForTenant: vi.fn(async (_t: string, f: string) => H.features.current[f] !== false),
    prisma: {
      conversation: { findFirst: vi.fn(async () => H.conversation.current) },
      message: { findFirst: vi.fn(async () => H.lastInbound.current) },
    },
  };
});

vi.mock("../services/shopify-catalog.service", () => ({
  resolveShopifyStore: vi.fn(async () => H.store.current),
  getProductSnapshot: vi.fn(async () => ({
    ok: true,
    store: H.store.current.store,
    data: H.productByHandle.current,
  })),
  getProductSnapshots: vi.fn(async () => ({
    ok: true,
    store: H.store.current.store,
    data: H.snapshots.current,
  })),
}));

import { prepareShopifyTurn } from "../services/shopify-chat-turn.service";
import {
  buildAgentTools,
  dispatchToolCall,
  buildProductSnapshot,
  defaultShopifyLiveChatConfig,
  type AgentToolContext,
} from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";

function snapshot(overrides: Record<string, any> = {}) {
  return {
    ...buildProductSnapshot({
      shopDomain: SHOP,
      currency: "USD",
      product: {
        id: 111,
        title: "Cloud Pro Runner",
        handle: "cloud-pro-runner",
        status: "active",
        vendor: "Cloudline",
        image: { src: "https://cdn.shopify.com/s/files/1/x.jpg" },
        options: [{ name: "Size" }],
        variants: [
          { id: 9001, title: "41", price: "120.00", compare_at_price: "150.00", available: true, option1: "41" },
          { id: 9002, title: "42", price: "120.00", available: false, option1: "42" },
        ],
      },
    })!,
    ...overrides,
  };
}

function channelRow(mutate?: (c: any) => void) {
  const config = defaultShopifyLiveChatConfig();
  config.shopDomain = SHOP;
  config.enabled = true;
  config.routing.aiAgentId = "agent1";
  mutate?.(config);
  return {
    id: "ch1",
    tenantId: "t1",
    externalId: "sfy_key",
    displayName: "Demo Store",
    connectionStatus: "CONNECTED",
    platformMeta: { shopifyLiveChat: config },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.features.current = {};
  H.conversation.current = { id: "conv1", tenantId: "t1", channelAccount: channelRow() };
  H.lastInbound.current = null;
  H.store.current = { ok: true, store: { tenantIntegrationId: "ti1", shopDomain: SHOP, currency: "USD" } };
  H.snapshots.current = [snapshot()];
  H.productByHandle.current = snapshot();
});

// ─── Tool surface ───────────────────────────────────────────

describe("tool surface", () => {
  it("does not offer product tools by default", () => {
    const names = buildAgentTools().map((t: any) => t.function.name);
    expect(names).not.toContain("send_product_card");
    expect(names).not.toContain("send_product_carousel");
  });

  it("offers both product tools when the channel allows them", () => {
    const names = buildAgentTools({ shopifyProducts: true }).map((t: any) => t.function.name);
    expect(names).toContain("send_product_card");
    expect(names).toContain("send_product_carousel");
  });
});

// ─── Turn preparation ───────────────────────────────────────

describe("turn preparation", () => {
  it("returns null for a conversation on any other channel", async () => {
    H.conversation.current = null;
    expect(await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" })).toBeNull();
  });

  it("enables product messaging when channel, plan and store all agree", async () => {
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    expect(turn!.productMessagingEnabled).toBe(true);
    expect(turn!.sendShopifyProducts).toBeTypeOf("function");
  });

  it("disables product messaging without the entitlement", async () => {
    // (case 55)
    H.features.current = { shopify_product_messaging: false };
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    expect(turn!.productMessagingEnabled).toBe(false);
    expect(turn!.sendShopifyProducts).toBeUndefined();
  });

  it("disables product messaging when the workspace moved to another store", async () => {
    // A channel bound to store A must not start showing store B's
    // catalogue to shoppers browsing store A.
    H.store.current = { ok: true, store: { tenantIntegrationId: "ti2", shopDomain: "other.myshopify.com", currency: "USD" } };
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    expect(turn!.productMessagingEnabled).toBe(false);
  });

  it("keeps chat alive when the store disconnects mid-conversation", async () => {
    // (case 42) Text chat survives; only the product surface goes.
    H.store.current = { ok: false, reason: "not_connected" };
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    expect(turn).not.toBeNull();
    expect(turn!.productMessagingEnabled).toBe(false);
  });
});

// ─── Storefront context block ───────────────────────────────

describe("storefront context block", () => {
  it("describes the SERVER-resolved product for the page the shopper is on", async () => {
    // (case 41) The handle came from a browser; every fact below did not.
    H.lastInbound.current = {
      metadata: { storefront: { pageType: "product", productHandle: "cloud-pro-runner", cartItemCount: 2, currency: "USD" } },
    };
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    const block = turn!.storefrontBlock!;
    expect(block).toContain("Cloud Pro Runner");
    expect(block).toContain("120.00");
    expect(block).toContain("product_id: 111");
    expect(block).toMatch(/this one/i);
  });

  it("tells the model to ask rather than guess when the product will not load", async () => {
    H.lastInbound.current = { metadata: { storefront: { pageType: "product", productHandle: "ghost" } } };
    H.productByHandle.current = null;
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    expect(turn!.storefrontBlock).toMatch(/ask which product/i);
  });

  it("has no block at all when the visitor sent no context", async () => {
    H.lastInbound.current = { metadata: {} };
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    expect(turn!.storefrontBlock).toBeUndefined();
  });
});

// ─── Staging product messages ───────────────────────────────

describe("send_product_card", () => {
  async function turnWithTools() {
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    const ctx: AgentToolContext = {
      tenantId: "t1",
      conversationId: "conv1",
      sendShopifyProducts: turn!.sendShopifyProducts,
    };
    return { turn: turn!, ctx };
  }

  function call(name: string, args: Record<string, unknown>) {
    return { id: "call1", function: { name, arguments: JSON.stringify(args) } };
  }

  it("stages a card and reports back only resolved facts", async () => {
    // (case 39)
    const { turn, ctx } = await turnWithTools();
    const result = await dispatchToolCall(call("send_product_card", { product_id: "111", reason: "Lighter cushioning" }), ctx);
    const payload = JSON.parse(result.content);

    expect(payload.ok).toBe(true);
    expect(payload.products[0]).toMatchObject({ title: "Cloud Pro Runner", price: "120.00", currency: "USD" });
    expect(turn.staged).toHaveLength(1);
    expect(turn.staged[0].messageType).toBe("shopify_product");
    const staged = turn.staged[0].metadata.shopify as any;
    expect(staged.shopDomain).toBe(SHOP);
    expect(staged.source).toBe("ai");
  });

  it("stages nothing when the model invents a product id", async () => {
    // (case 40) This is the mechanism, not a promise.
    H.snapshots.current = [];
    const { turn, ctx } = await turnWithTools();
    const result = await dispatchToolCall(call("send_product_card", { product_id: "9999999" }), ctx);
    const payload = JSON.parse(result.content);

    expect(payload.ok).toBe(false);
    expect(payload.reason).toMatch(/no_matching_products/);
    expect(turn.staged).toHaveLength(0);
  });

  it("refuses a call with no reference at all and tells the model to search first", async () => {
    const { turn, ctx } = await turnWithTools();
    const result = await dispatchToolCall(call("send_product_card", { reason: "nice shoe" }), ctx);
    const payload = JSON.parse(result.content);
    expect(payload.ok).toBe(false);
    expect(payload.instruction).toMatch(/search/i);
    expect(turn.staged).toHaveLength(0);
  });

  it("degrades with a clear refusal on a channel that cannot render cards", async () => {
    // (case 42) The model is told to answer in text and not invent facts.
    const result = await dispatchToolCall(call("send_product_card", { product_id: "111" }), {
      tenantId: "t1",
      conversationId: "conv1",
    });
    const payload = JSON.parse(result.content);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("product_cards_not_available_on_this_channel");
    expect(payload.instruction).toMatch(/never invent a price/i);
  });

  it("drops an unpublished product unless the merchant allowed it", async () => {
    H.snapshots.current = [snapshot({ status: "draft" })];
    const { turn, ctx } = await turnWithTools();
    const result = await dispatchToolCall(call("send_product_card", { product_id: "111" }), ctx);
    expect(JSON.parse(result.content).ok).toBe(false);
    expect(turn.staged).toHaveLength(0);
  });
});

describe("send_product_carousel", () => {
  it("stages a carousel and honours the merchant's size limit", async () => {
    H.conversation.current = {
      id: "conv1",
      tenantId: "t1",
      channelAccount: channelRow((c) => { c.commerce.carouselSize = 2; }),
    };
    H.snapshots.current = [snapshot(), snapshot({ productId: "222" })];
    const turn = await prepareShopifyTurn({ tenantId: "t1", conversationId: "conv1" });
    const ctx: AgentToolContext = {
      tenantId: "t1",
      conversationId: "conv1",
      sendShopifyProducts: turn!.sendShopifyProducts,
    };

    const result = await dispatchToolCall(
      {
        id: "c1",
        function: {
          name: "send_product_carousel",
          arguments: JSON.stringify({
            products: [{ product_id: "111" }, { product_id: "222" }, { product_id: "333" }, { product_id: "444" }],
          }),
        },
      },
      ctx,
    );

    expect(JSON.parse(result.content).ok).toBe(true);
    expect(turn!.staged[0].messageType).toBe("shopify_product_carousel");
    const { getProductSnapshots } = await import("../services/shopify-catalog.service");
    expect((getProductSnapshots as any).mock.calls[0][1]).toHaveLength(2);
  });
});
