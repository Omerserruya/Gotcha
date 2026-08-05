/**
 * The composer's preview must agree with the server's renderer.
 *
 * `frontend/src/lib/recommendation-preview-client.ts` restates the channel
 * capability matrix and the presentation ladder, because the frontend is
 * not an npm workspace and cannot import `@chatcenter/shared` at runtime.
 *
 * Drift here has a specific, ugly consequence: the agent sees "Product
 * carousel", approves it, and the customer receives a numbered text list.
 * The one human who could have caught a bad recommendation was looking at
 * a message that does not exist.
 *
 * The import of the shared package works here because tests run on the
 * host, where the root `node_modules` symlink exists.
 */
import { describe, it, expect } from "vitest";
import {
  CHANNEL_CAPABILITIES,
  capabilitiesFor,
  TEXT_ONLY_CAPABILITIES,
  type RecommendationChannel,
} from "../../../../packages/shared/src/channels/capabilities";
import { renderProductRecommendations } from "../../../../packages/shared/src/channels/recommendation-renderer";
import { normalizeRecommendationSet } from "../../../../packages/shared/src/lib/product-recommendations";
import {
  PREVIEW_CAPABILITIES,
  previewCapabilitiesFor,
  previewPresentation,
  TEXT_ONLY_PREVIEW_CAPABILITIES,
} from "../recommendation-preview-client";

const CHANNELS: RecommendationChannel[] = [
  "SHOPIFY_LIVE_CHAT", "WEBCHAT", "WHATSAPP", "MESSENGER", "INSTAGRAM",
  "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "SMS", "VOICE",
];

const SHOP = "demo-store.myshopify.com";

function makeSet(count: number, withImages: boolean) {
  return normalizeRecommendationSet({
    introduction: "Here are some options:",
    products: Array.from({ length: count }, (_, i) => ({
      productId: String(100 + i),
      title: `Product ${i + 1}`,
      productUrl: `https://${SHOP}/products/p-${i + 1}`,
      imageUrl: withImages ? `https://cdn.shopify.com/s/files/1/${i}.jpg` : undefined,
      price: { amount: "120.00", currency: "ILS" },
      availability: "in_stock",
    })),
    source: { integration: "shopify", shopDomain: SHOP },
  });
}

describe("capability matrix parity", () => {
  it("agrees on every channel, field by field", () => {
    for (const channel of CHANNELS) {
      expect(previewCapabilitiesFor(channel), channel).toEqual(CHANNEL_CAPABILITIES[channel]);
    }
  });

  it("covers exactly the same set of channels", () => {
    expect(Object.keys(PREVIEW_CAPABILITIES).sort()).toEqual(
      Object.keys(CHANNEL_CAPABILITIES).sort(),
    );
  });

  it("agrees on an unknown channel", () => {
    expect(previewCapabilitiesFor("TELEGRAM")).toEqual(capabilitiesFor("TELEGRAM"));
    expect(TEXT_ONLY_PREVIEW_CAPABILITIES).toEqual(TEXT_ONLY_CAPABILITIES);
  });
});

describe("presentation parity", () => {
  it("agrees on every channel, every selection size, with and without imagery", () => {
    let compared = 0;
    for (const channel of [...CHANNELS, "TELEGRAM" as RecommendationChannel]) {
      for (const count of [0, 1, 2, 3, 5, 8]) {
        for (const withImages of [true, false]) {
          const set = makeSet(count, withImages);
          const server = renderProductRecommendations({
            channelCapabilities: capabilitiesFor(channel),
            recommendationSet: set,
          }).presentation;
          const client = previewPresentation(
            previewCapabilitiesFor(channel),
            set.products.length,
            set.products.some((p) => !!p.imageUrl),
          );
          expect(client, `${channel} count=${count} images=${withImages}`).toBe(server);
          compared++;
        }
      }
    }
    expect(compared).toBe(144);
  });
});

describe("the limits the preview shows are the limits the renderer applies", () => {
  it("agrees on how many products actually go out", () => {
    for (const channel of CHANNELS) {
      const set = makeSet(8, true);
      const rendered = renderProductRecommendations({
        channelCapabilities: capabilitiesFor(channel),
        recommendationSet: set,
      });
      const caps = previewCapabilitiesFor(channel);
      const previewLimit = caps.maxCards ?? set.products.length;
      expect(rendered.included.length, channel).toBe(Math.min(previewLimit, set.products.length));
    }
  });
});
