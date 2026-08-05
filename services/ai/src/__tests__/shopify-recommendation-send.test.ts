/**
 * The Shopify send path, now that it goes through the channel decision
 * layer rather than deciding for itself.
 *
 * The behaviour worth pinning is the asymmetry: the AI path is retried by
 * a worker and must not deliver the same shortlist twice, while a human
 * agent re-sending the same card is making a deliberate choice and must
 * never be silently swallowed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const created: any[] = [];

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      message: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: `msg${created.length + 1}`, createdAt: new Date(), ...data };
          created.push(row);
          return row;
        }),
      },
      conversation: { update: vi.fn(async () => ({})) },
    },
    publishEvent: vi.fn(async () => {}),
  };
});

import { sendProductMessage } from "../services/shopify-commerce-message.service";
import { __resetRecommendationDedup } from "../services/recommendation-delivery.service";
import type { ProductSnapshot } from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";

function snapshot(id = "111", overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    shopDomain: SHOP,
    productId: id,
    handle: `p-${id}`,
    title: `Product ${id}`,
    imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg",
    productUrl: `https://${SHOP}/products/p-${id}`,
    currency: "ILS",
    price: "120.00",
    compareAtPrice: null,
    available: true,
    status: "active",
    vendor: null,
    selectedVariantId: "9001",
    optionNames: [],
    variants: [
      {
        variantId: "9001",
        title: "41",
        price: "120.00",
        compareAtPrice: null,
        available: true,
        sku: null,
        options: [],
        requiresSellingPlan: false,
      },
    ],
    reason: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function send(overrides: Record<string, any> = {}) {
  return sendProductMessage({
    tenantId: "t1",
    conversationId: "conv1",
    channelAccountId: "ca1",
    shopDomain: SHOP,
    products: [snapshot()],
    source: "ai",
    senderName: "Store Assistant",
    addToCartEnabled: true,
    ...overrides,
  } as any);
}

beforeEach(() => {
  created.length = 0;
  __resetRecommendationDedup();
});

describe("the send reports the channel decision", () => {
  it("a single product is a card", async () => {
    const res = await send();
    expect(res).toMatchObject({ ok: true, presentation: "cards", productCount: 1 });
  });

  it("several products are a carousel", async () => {
    const res = await send({ products: [snapshot("111"), snapshot("222"), snapshot("333")] });
    expect(res).toMatchObject({ ok: true, presentation: "native_carousel", productCount: 3 });
  });

  it("carries a content-derived idempotency key", async () => {
    const res: any = await send();
    expect(res.idempotencyKey).toMatch(/^rec_[0-9a-f]{16}$/);
  });
});

describe("retry suppression", () => {
  it("refuses a second AI send of the same shortlist", async () => {
    const first = await send();
    expect(first.ok).toBe(true);
    const second = await send();
    expect(second).toEqual({ ok: false, reason: "duplicate_recommendation" });
    // And no second row was written.
    expect(created).toHaveLength(1);
  });

  it("allows an AI send of a DIFFERENT shortlist", async () => {
    await send();
    const other = await send({ products: [snapshot("222")] });
    expect(other.ok).toBe(true);
  });

  it("does not suppress across conversations", async () => {
    await send();
    const elsewhere = await send({ conversationId: "conv2" });
    expect(elsewhere.ok).toBe(true);
  });

  it("never suppresses a human agent re-sending the same card", async () => {
    // Deliberate, not a retry. An agent asked "sorry, which one?" sends
    // it again, and a composer that swallowed that would look broken.
    const first = await send({ source: "agent" });
    expect(first.ok).toBe(true);
    const again = await send({ source: "agent" });
    expect(again.ok).toBe(true);
    expect(created).toHaveLength(2);
  });

  it("an agent send does not poison the AI path's dedup window", async () => {
    await send({ source: "agent" });
    const ai = await send({ source: "ai" });
    expect(ai.ok).toBe(true);
  });
});

describe("store scoping still holds", () => {
  it("refuses a snapshot from another store", async () => {
    const res = await send({
      products: [snapshot("111", { shopDomain: "other-store.myshopify.com" })],
    });
    expect(res).toEqual({ ok: false, reason: "store_mismatch" });
  });

  it("refuses an empty selection", async () => {
    const res = await send({ products: [] });
    expect(res).toEqual({ ok: false, reason: "no_products" });
  });
});
