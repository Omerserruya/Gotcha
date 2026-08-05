/**
 * The channel presentation adapter.
 *
 * The capability matrix describes what GOTCHA has BUILT, not what each
 * vendor's API documentation says is possible. Several tests below exist
 * only to keep it that way: the day someone marks WhatsApp as supporting
 * URL buttons because the Cloud API docs say so, the renderer starts
 * emitting payloads whatsapp.adapter drops on the floor and the shopper
 * receives nothing at all.
 */
import { describe, it, expect } from "vitest";
import {
  renderProductRecommendations,
  splitForLength,
  buildEmailHtml,
} from "../channels/recommendation-renderer";
import {
  CHANNEL_CAPABILITIES,
  capabilitiesFor,
  TEXT_ONLY_CAPABILITIES,
  type RecommendationChannel,
} from "../channels/capabilities";
import {
  normalizeRecommendationSet,
  type ProductRecommendationSet,
} from "../lib/product-recommendations";

const SHOP = "demo-store.myshopify.com";

function makeSet(count = 3, overrides: Record<string, any> = {}): ProductRecommendationSet {
  return normalizeRecommendationSet({
    introduction: "מצאתי שלוש אפשרויות שיכולות להתאים למה שחיפשת:",
    products: Array.from({ length: count }, (_, i) => ({
      productId: String(100 + i),
      variantId: String(9000 + i),
      title: `Cloud Pro ${i + 1}`,
      productUrl: `https://${SHOP}/products/cloud-pro-${i + 1}`,
      imageUrl: `https://cdn.shopify.com/s/files/1/${i}.jpg`,
      price: { amount: "120.00", currency: "ILS" },
      compareAtPrice: { amount: "150.00", currency: "ILS" },
      availability: "in_stock",
      reason: "קליל ונוח לריצה יומית.",
      purchasable: true,
    })),
    source: { integration: "shopify", shopDomain: SHOP },
    ...overrides,
  });
}

function render(channel: RecommendationChannel, set = makeSet(), locale = "he") {
  return renderProductRecommendations({
    channelCapabilities: capabilitiesFor(channel),
    recommendationSet: set,
    locale,
  });
}

// ─── The matrix ──────────────────────────────────────────────

describe("channel capability matrix", () => {
  const CHANNELS: RecommendationChannel[] = [
    "SHOPIFY_LIVE_CHAT", "WHATSAPP", "INSTAGRAM", "MESSENGER", "WEBCHAT",
    "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "SMS", "VOICE",
  ];

  it("covers every channel the spec names", () => {
    for (const c of CHANNELS) expect(CHANNEL_CAPABILITIES[c], c).toBeTruthy();
  });

  it("an unknown channel gets the text-only floor, not a crash", () => {
    expect(capabilitiesFor("TELEGRAM")).toEqual(TEXT_ONLY_CAPABILITIES);
    expect(capabilitiesFor(null)).toEqual(TEXT_ONLY_CAPABILITIES);
    expect(capabilitiesFor(undefined)).toEqual(TEXT_ONLY_CAPABILITIES);
  });

  it("does NOT claim WhatsApp URL buttons or a native catalog", () => {
    // whatsapp.adapter sends text, media and up to three REPLY buttons.
    // Interactive lists, CTA-URL buttons and product messages are not
    // implemented, so the matrix must not promise them.
    const wa = CHANNEL_CAPABILITIES.WHATSAPP;
    expect(wa.supportsUrlButtons).toBe(false);
    expect(wa.supportsNativeCatalog).toBe(false);
    expect(wa.supportsCards).toBe(false);
    expect(wa.supportsProductCarousel).toBe(false);
    // What it DOES have.
    expect(wa.supportsImages).toBe(true);
    expect(wa.supportsQuickReplies).toBe(true);
    expect(wa.maxButtons).toBe(3);
  });

  it("does NOT claim Messenger or Instagram generic templates", () => {
    // Both adapters send quick_replies only; no generic template is wired.
    for (const c of ["MESSENGER", "INSTAGRAM"] as const) {
      expect(CHANNEL_CAPABILITIES[c].supportsCards, c).toBe(false);
      expect(CHANNEL_CAPABILITIES[c].supportsUrlButtons, c).toBe(false);
      expect(CHANNEL_CAPABILITIES[c].maxButtons, c).toBe(13);
    }
  });

  it("gives Add to Cart to the storefront only", () => {
    expect(CHANNEL_CAPABILITIES.SHOPIFY_LIVE_CHAT.supportsAddToCart).toBe(true);
    // The website widget renders the same cards but has no storefront cart.
    expect(CHANNEL_CAPABILITIES.WEBCHAT.supportsAddToCart).toBe(false);
  });

  it("caps the storefront carousel where the widget caps it", () => {
    expect(CHANNEL_CAPABILITIES.SHOPIFY_LIVE_CHAT.maxCards).toBe(5);
  });
});

// ─── Shopify Live Chat ───────────────────────────────────────

describe("Shopify Live Chat", () => {
  it("renders a carousel, with the introduction as its own message", () => {
    const r = render("SHOPIFY_LIVE_CHAT");
    expect(r.presentation).toBe("native_carousel");
    expect(r.messages[0]).toEqual({
      kind: "text",
      text: "מצאתי שלוש אפשרויות שיכולות להתאים למה שחיפשת:",
    });
    expect(r.messages[1]).toMatchObject({ kind: "carousel", addToCart: true });
  });

  it("does NOT repeat the products as a text list", () => {
    const r = render("SHOPIFY_LIVE_CHAT");
    const textParts = r.messages.filter((m) => m.kind === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as any).text).not.toContain("https://");
  });

  it("a single product is one card, not a carousel of one", () => {
    const r = render("SHOPIFY_LIVE_CHAT", makeSet(1));
    expect(r.presentation).toBe("cards");
  });

  it("enforces the five-card cap and says what it dropped", () => {
    const r = render("SHOPIFY_LIVE_CHAT", makeSet(8));
    expect(r.included).toHaveLength(5);
    expect(r.dropped).toHaveLength(3);
    expect(r.notes.join(" ")).toContain("3 products not shown");
  });

  it("still carries a text fallback for a rejected rich payload", () => {
    const r = render("SHOPIFY_LIVE_CHAT");
    expect(r.textFallback).toContain(`https://${SHOP}/products/cloud-pro-1`);
    expect(r.textFallback).toContain("120.00 ILS");
  });
});

// ─── WhatsApp ────────────────────────────────────────────────

describe("WhatsApp", () => {
  it("uses images with the link in the caption, because it has no URL buttons", () => {
    const r = render("WHATSAPP");
    expect(r.presentation).toBe("image_cards");
    const images = r.messages.filter((m) => m.kind === "image");
    expect(images).toHaveLength(3);
    expect((images[0] as any).caption).toContain(`https://${SHOP}/products/cloud-pro-1`);
    expect(r.notes.join(" ")).toContain("no link buttons");
  });

  it("caps at three products - a shortlist, not a catalogue dump", () => {
    const r = render("WHATSAPP", makeSet(6));
    expect(r.included).toHaveLength(3);
    expect(r.notes.join(" ")).toContain("3 products not shown");
  });

  it("falls back to text when no product has an image", () => {
    const noImages = normalizeRecommendationSet({
      products: [
        {
          productId: "1",
          title: "Cloud Pro",
          productUrl: `https://${SHOP}/products/cloud-pro`,
          price: { amount: "120.00", currency: "ILS" },
        },
      ],
      source: { integration: "shopify", shopDomain: SHOP },
    });
    const r = render("WHATSAPP", noImages);
    expect(r.presentation).toBe("quick_replies");
    expect(r.notes.join(" ")).toContain("No product images were available");
  });

  it("never sends a wall of raw URLs", () => {
    const r = render("WHATSAPP");
    // Every URL that goes out is attached to a titled product, not
    // stacked bare in one body.
    for (const m of r.messages) {
      if (m.kind === "image") {
        expect(m.caption).toMatch(/Cloud Pro/);
      }
    }
  });
});

// ─── Meta ────────────────────────────────────────────────────

describe("Messenger and Instagram", () => {
  it.each(["MESSENGER", "INSTAGRAM"] as const)("%s uses images with captioned links", (channel) => {
    const r = render(channel);
    expect(r.presentation).toBe("image_cards");
    expect(r.messages.filter((m) => m.kind === "image")).toHaveLength(3);
  });
});

// ─── Email ───────────────────────────────────────────────────

describe("Email", () => {
  it.each(["EMAIL", "GMAIL", "OUTLOOK"] as const)("%s gets responsive HTML cards", (channel) => {
    const r = render(channel);
    expect(r.presentation).toBe("rich_html");
    const html = (r.messages[0] as any).html as string;
    expect(html).toContain("max-width:600px");
    expect(html).toContain(`href="https://${SHOP}/products/cloud-pro-1"`);
  });

  it("gives every image alt text and every link the product title", () => {
    const html = (render("EMAIL").messages[0] as any).html as string;
    expect(html).toContain('alt="Cloud Pro 1"');
    // A link reading "View product" three times is unusable with a screen
    // reader; the title is what makes each one distinguishable.
    expect(html).toContain("לצפייה במוצר: Cloud Pro 1");
  });

  it("lays the HTML out right-to-left for a Hebrew customer", () => {
    expect((render("EMAIL").messages[0] as any).html).toContain('dir="rtl"');
    expect((render("EMAIL", makeSet(), "en").messages[0] as any).html).toContain('dir="ltr"');
  });

  it("keeps the price left-to-right inside RTL copy", () => {
    const html = (render("EMAIL").messages[0] as any).html as string;
    expect(html).toContain('dir="ltr">120.00 ILS');
  });

  it("escapes a hostile product title", () => {
    const hostile = normalizeRecommendationSet({
      products: [
        {
          productId: "1",
          title: '<img src=x onerror=alert(1)>',
          productUrl: `https://${SHOP}/products/x`,
        },
      ],
      source: { integration: "shopify", shopDomain: SHOP },
    });
    const html = buildEmailHtml("", hostile.products, "en");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("carries a plain-text alternative alongside the HTML", () => {
    const m = render("EMAIL").messages[0] as any;
    expect(m.text).toContain(`https://${SHOP}/products/cloud-pro-1`);
  });
});

// ─── Slack ───────────────────────────────────────────────────

describe("Slack", () => {
  it("uses images with links, since Block Kit cards are not wired", () => {
    expect(render("SLACK").presentation).toBe("image_cards");
  });
});

// ─── SMS ─────────────────────────────────────────────────────

describe("SMS", () => {
  it("is a concise numbered list with the links", () => {
    const r = render("SMS", makeSet(2));
    expect(r.presentation).toBe("text");
    const body = r.messages.map((m) => (m as any).text).join("\n\n");
    expect(body).toContain("1. Cloud Pro 1");
    expect(body).toContain("2. Cloud Pro 2");
    expect(body).toContain(`https://${SHOP}/products/cloud-pro-1`);
  });

  it("splits on product boundaries, never mid-URL", () => {
    const r = render("SMS", makeSet(3));
    for (const m of r.messages) {
      const text = (m as any).text as string;
      // A URL that survived the split is a whole URL.
      for (const url of text.match(/https:\/\/\S+/g) ?? []) {
        expect(url).toMatch(/^https:\/\/demo-store\.myshopify\.com\/products\/cloud-pro-\d$/);
      }
    }
  });
});

// ─── Voice ───────────────────────────────────────────────────

describe("Voice", () => {
  it("speaks a summary with no URLs in it", () => {
    const r = render("VOICE", makeSet(2));
    expect(r.presentation).toBe("speech");
    const spoken = (r.messages[0] as any).text as string;
    expect(spoken).toContain("Cloud Pro 1");
    expect(spoken).not.toContain("https://");
  });

  it("hands the links to a companion text channel", () => {
    const r = render("VOICE", makeSet(2));
    expect(r.companionText).toContain(`https://${SHOP}/products/cloud-pro-1`);
    expect(r.notes.join(" ")).toContain("companion text channel");
  });
});

// ─── Cross-cutting guarantees ────────────────────────────────

describe("guarantees that hold on every channel", () => {
  const CHANNELS: RecommendationChannel[] = [
    "SHOPIFY_LIVE_CHAT", "WHATSAPP", "INSTAGRAM", "MESSENGER", "WEBCHAT",
    "EMAIL", "GMAIL", "OUTLOOK", "SLACK", "SMS", "VOICE",
  ];

  it.each(CHANNELS)("%s always has a text fallback", (channel) => {
    const r = render(channel);
    expect(r.textFallback.length).toBeGreaterThan(0);
    expect(r.textFallback).toContain(`https://${SHOP}/products/cloud-pro-1`);
  });

  it.each(CHANNELS)("%s carries a stable idempotency key", (channel) => {
    expect(render(channel).idempotencyKey).toBe(render(channel).idempotencyKey);
  });

  it("the same set renders to the same key on every channel - one recommendation, one key", () => {
    const set = makeSet();
    const keys = new Set(CHANNELS.map((c) => render(c, set).idempotencyKey));
    expect(keys.size).toBe(1);
  });

  it.each(CHANNELS)("%s invents no price, link or product", (channel) => {
    const r = render(channel);
    const blob = JSON.stringify(r);
    // Every URL that appears anywhere in the output is one of ours.
    for (const url of blob.match(/https:\\?\/\\?\/[^"\\, ]+/g) ?? []) {
      expect(url.replace(/\\/g, "")).toMatch(
        /^https:\/\/(demo-store\.myshopify\.com|cdn\.shopify\.com)/,
      );
    }
    // Every money amount is the one the set carried.
    for (const amount of blob.match(/\d+\.\d\d ILS/g) ?? []) {
      expect(["120.00 ILS", "150.00 ILS"]).toContain(amount);
    }
  });

  it("an empty set renders as text and never as an empty carousel", () => {
    const empty = normalizeRecommendationSet({
      products: [],
      source: { integration: "shopify", shopDomain: SHOP },
    });
    for (const channel of CHANNELS) {
      const r = render(channel, empty);
      expect(r.presentation, channel).toBe("text");
      expect(r.included, channel).toHaveLength(0);
    }
  });

  it("uses the model's introduction when it wrote one", () => {
    const r = render("SMS", makeSet(1, { introduction: "בדיוק מה שחיפשת:" }));
    expect(r.textFallback.startsWith("בדיוק מה שחיפשת:")).toBe(true);
  });

  it("supplies its own lead-in when the model wrote none", () => {
    const r = render("SMS", makeSet(1, { introduction: undefined }), "he");
    expect(r.textFallback.startsWith("הנה מה שמצאתי:")).toBe(true);
  });
});

describe("splitForLength", () => {
  it("returns one part when it fits", () => {
    expect(splitForLength("short", 100)).toEqual(["short"]);
  });

  it("returns one part when there is no limit", () => {
    expect(splitForLength("x".repeat(5000))).toHaveLength(1);
  });

  it("never chops a block that is itself too long", () => {
    const long = `A${"x".repeat(400)}`;
    expect(splitForLength(`${long}\n\nB`, 100)).toEqual([long, "B"]);
  });
});
