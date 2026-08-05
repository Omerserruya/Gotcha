/**
 * The channel presentation adapter.
 *
 * Takes a `ProductRecommendationSet` and a channel's capabilities and
 * decides how the products are actually shown. Every commerce integration
 * feeds the same function, and every channel is answered by it, so
 * "recommendations look right on WhatsApp" is one change here rather than
 * a branch inside each Shopify tool.
 *
 * Two invariants:
 *
 *   1. There is ALWAYS a text fallback, on every presentation, even the
 *      native carousel. A provider that rejects a rich payload has to be
 *      recoverable without re-running the recommendation.
 *   2. Nothing this file emits contains a fact the set did not already
 *      carry. It arranges; it does not author. The only strings it
 *      introduces are UI labels ("View product", "In stock").
 */

import type { ChannelCapabilities } from "./capabilities";
import {
  availabilityLabel,
  priceLabel,
  recommendationIdempotencyKey,
  RECOMMENDATION_STRINGS,
  type ProductRecommendationSet,
  type RecommendationLocale,
  type RecommendedProduct,
} from "../lib/product-recommendations";

export type RecommendationPresentation =
  | "native_catalog"
  | "native_carousel"
  | "rich_html"
  | "cards"
  | "image_cards"
  | "link_buttons"
  | "quick_replies"
  | "speech"
  | "text";

export interface RenderedButton {
  id: string;
  title: string;
  /** Present only on channels with real URL buttons. */
  url?: string;
}

export type RenderedMessage =
  | { kind: "text"; text: string }
  | { kind: "carousel"; products: RecommendedProduct[]; addToCart: boolean }
  | { kind: "cards"; products: RecommendedProduct[]; addToCart: boolean }
  | { kind: "image"; imageUrl: string; caption: string; productId: string }
  | { kind: "buttons"; bodyText: string; buttons: RenderedButton[] }
  | { kind: "html"; html: string; text: string }
  | { kind: "speech"; text: string };

export interface RenderedRecommendations {
  presentation: RecommendationPresentation;
  /** Provider-neutral parts, in the order they must be sent. */
  messages: RenderedMessage[];
  included: RecommendedProduct[];
  /** Products the channel's limits pushed out. Never silently discarded. */
  dropped: RecommendedProduct[];
  /**
   * What to send instead when the provider rejects the rich payload.
   * Present on EVERY presentation, including the native ones.
   */
  textFallback: string;
  /**
   * Same set, same key, across retries. The outbound path refuses a second
   * send with a key it has already delivered.
   */
  idempotencyKey: string;
  /**
   * Plain sentences about what this channel could not do. Rendered in the
   * agent composer so a human sees the shape of the message they are about
   * to send, not a generic preview.
   */
  notes: string[];
  /**
   * Voice only: the links, for a companion text channel. A URL read aloud
   * is noise.
   */
  companionText?: string;
}

export interface RenderRecommendationsInput {
  channelCapabilities: ChannelCapabilities;
  recommendationSet: ProductRecommendationSet;
  locale?: RecommendationLocale | string;
}

export function renderProductRecommendations(
  input: RenderRecommendationsInput,
): RenderedRecommendations {
  const caps = input.channelCapabilities;
  const set = input.recommendationSet;
  const locale: RecommendationLocale = String(input.locale ?? "en").toLowerCase().startsWith("he")
    ? "he"
    : "en";
  const s = RECOMMENDATION_STRINGS[locale];
  const notes: string[] = [];

  // Channel limits are applied ONCE, here, so every branch below agrees on
  // which products it is presenting.
  const limit = caps.maxCards ?? set.products.length;
  const included = set.products.slice(0, limit);
  const dropped = set.products.slice(limit);
  if (dropped.length) {
    notes.push(
      `${dropped.length} product${dropped.length === 1 ? "" : "s"} not shown: this channel renders at most ${limit}.`,
    );
  }

  const intro = set.introduction?.trim() || (included.length ? s.here : "");
  const textFallback = buildTextFallback(intro, included, locale);
  const idempotencyKey = set.idempotencyKey ?? recommendationIdempotencyKey(set);

  const base = { included, dropped, textFallback, idempotencyKey, notes };

  if (!included.length) {
    return { ...base, presentation: "text", messages: [{ kind: "text", text: textFallback }] };
  }

  // ── The ladder ──────────────────────────────────────────────
  //
  // Ordered richest-first. Each rung is only taken when the channel can
  // actually render it, so a channel that gains a capability moves up
  // without any call site changing.

  if (caps.supportsNativeCatalog) {
    return {
      ...base,
      presentation: "native_catalog",
      messages: [
        ...(intro ? [{ kind: "text" as const, text: intro }] : []),
        { kind: "cards", products: included, addToCart: caps.supportsAddToCart },
      ],
    };
  }

  if (caps.supportsProductCarousel && included.length > 1) {
    return {
      ...base,
      presentation: "native_carousel",
      messages: [
        ...(intro ? [{ kind: "text" as const, text: intro }] : []),
        { kind: "carousel", products: included, addToCart: caps.supportsAddToCart },
      ],
    };
  }

  if (caps.supportsCards && caps.supportsRichHtml) {
    return {
      ...base,
      presentation: "rich_html",
      messages: [{ kind: "html", html: buildEmailHtml(intro, included, locale), text: textFallback }],
    };
  }

  if (caps.supportsCards) {
    return {
      ...base,
      presentation: "cards",
      messages: [
        ...(intro ? [{ kind: "text" as const, text: intro }] : []),
        { kind: "cards", products: included, addToCart: caps.supportsAddToCart },
      ],
    };
  }

  if (caps.supportsSpeech) {
    // Spoken shortlist, links elsewhere. The spoken text deliberately
    // contains no URL: reading "h-t-t-p-s colon slash slash" at someone is
    // not a recommendation.
    return {
      ...base,
      presentation: "speech",
      messages: [{ kind: "speech", text: buildSpokenSummary(intro, included, locale) }],
      companionText: textFallback,
      notes: [
        ...notes,
        "Voice cannot carry links. The spoken summary names the products; the links need a companion text channel.",
      ],
    };
  }

  if (caps.supportsImages) {
    // One image per product, the facts in the caption. Where the channel
    // has no URL buttons the link lives in the caption too - which is the
    // WhatsApp case, and why this is not called "image cards with buttons".
    const withImages = included.filter((p) => p.imageUrl);
    if (withImages.length) {
      if (!caps.supportsUrlButtons) {
        notes.push(
          "This channel has no link buttons, so each product's link is in its caption.",
        );
      }
      const messages: RenderedMessage[] = [];
      if (intro) messages.push({ kind: "text", text: intro });
      for (const p of included) {
        const caption = buildProductLine(p, locale, { withUrl: true });
        if (p.imageUrl) {
          messages.push({ kind: "image", imageUrl: p.imageUrl, caption, productId: p.productId });
        } else {
          // A product with no image still gets sent; dropping it would
          // silently shorten a shortlist the shopper was promised.
          messages.push({ kind: "text", text: caption });
        }
      }
      return { ...base, presentation: "image_cards", messages, notes };
    }
    notes.push("No product images were available, so this falls back to links.");
  }

  if (caps.supportsUrlButtons) {
    const maxButtons = caps.maxButtons ?? included.length;
    const buttons = included.slice(0, maxButtons).map((p) => ({
      id: `product_${p.productId}`,
      title: p.buttonLabel ?? truncate(p.title, 20),
      url: p.productUrl,
    }));
    if (included.length > maxButtons) {
      notes.push(
        `Only ${maxButtons} link buttons fit on this channel; the rest are listed in the message body.`,
      );
    }
    return {
      ...base,
      presentation: "link_buttons",
      messages: [{ kind: "buttons", bodyText: textFallback, buttons }],
    };
  }

  if (caps.supportsQuickReplies) {
    // Reply buttons carry no link, so the body must still contain the
    // URLs. The buttons are a way to pick, not a way to open.
    const maxButtons = caps.maxButtons ?? included.length;
    const buttons = included.slice(0, maxButtons).map((p) => ({
      id: `product_${p.productId}`,
      title: p.buttonLabel ?? truncate(p.title, 20),
    }));
    notes.push(
      "Buttons on this channel reply with text, they do not open a link, so the links stay in the message body.",
    );
    return {
      ...base,
      presentation: "quick_replies",
      messages: [{ kind: "buttons", bodyText: textFallback, buttons }],
    };
  }

  // Everything supports this.
  return {
    ...base,
    presentation: "text",
    messages: splitForLength(textFallback, caps.maxBodyChars).map((text) => ({
      kind: "text" as const,
      text,
    })),
  };
}

// ─── Text ────────────────────────────────────────────────────

/**
 * One product, one readable block. The exact URL, the exact price, and
 * nothing that was not in the set.
 */
export function buildProductLine(
  product: RecommendedProduct,
  locale: RecommendationLocale,
  opts: { withUrl?: boolean; index?: number } = {},
): string {
  const parts: string[] = [];
  const head = opts.index != null ? `${opts.index}. ${product.title}` : product.title;
  parts.push(head);

  const price = priceLabel(product.price);
  const availability = availabilityLabel(product.availability, locale);
  const meta = [price, availability].filter(Boolean).join(" · ");
  if (meta) parts.push(meta);

  if (product.reason) parts.push(product.reason);
  if (opts.withUrl !== false) parts.push(product.productUrl);

  return parts.join("\n");
}

function buildTextFallback(
  intro: string,
  products: RecommendedProduct[],
  locale: RecommendationLocale,
): string {
  if (!products.length) return intro;
  const blocks = products.map((p, i) => buildProductLine(p, locale, { withUrl: true, index: i + 1 }));
  return [intro, ...blocks].filter(Boolean).join("\n\n");
}

/**
 * A spoken shortlist. Names and prices, no URLs, no part codes - all of
 * which are unlistenable.
 */
function buildSpokenSummary(
  intro: string,
  products: RecommendedProduct[],
  locale: RecommendationLocale,
): string {
  const lines = products.map((p, i) => {
    const price = priceLabel(p.price);
    const availability = p.availability === "out_of_stock" ? availabilityLabel(p.availability, locale) : null;
    return [`${i + 1}. ${p.title}`, price, availability].filter(Boolean).join(", ");
  });
  return [intro, ...lines].filter(Boolean).join(" ");
}

/**
 * Split without cutting a product block in half. A URL bisected across
 * two SMS segments is not a link.
 */
export function splitForLength(text: string, maxChars?: number): string[] {
  if (!maxChars || text.length <= maxChars) return [text];
  const blocks = text.split("\n\n");
  const out: string[] = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    // A single block longer than the limit goes out whole rather than
    // being chopped mid-URL. An over-long message is a nuisance; a broken
    // link is a dead end.
    current = block;
  }
  if (current) out.push(current);
  return out;
}

// ─── Email ───────────────────────────────────────────────────

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Responsive product cards for email.
 *
 * Tables and inline styles because that is what email clients render.
 * Every image carries alt text and every link is a real anchor with the
 * product title in it, so a screen reader and a text-only client both get
 * a usable message.
 */
export function buildEmailHtml(
  intro: string,
  products: RecommendedProduct[],
  locale: RecommendationLocale,
): string {
  const s = RECOMMENDATION_STRINGS[locale];
  const dir = locale === "he" ? "rtl" : "ltr";
  const align = locale === "he" ? "right" : "left";

  const cards = products
    .map((p) => {
      const price = priceLabel(p.price);
      const was = priceLabel(p.compareAtPrice);
      const availability = availabilityLabel(p.availability, locale);
      const image = p.imageUrl
        ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.title)}" width="120" ` +
          `style="display:block;width:120px;max-width:120px;height:auto;border-radius:8px;border:0;">`
        : "";
      return [
        `<tr><td style="padding:12px 0;border-bottom:1px solid #eef2f7;">`,
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" dir="${dir}">`,
        `<tr>`,
        image ? `<td width="132" valign="top" style="padding-inline-end:12px;">${image}</td>` : "",
        `<td valign="top" align="${align}" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;">`,
        `<div style="font-weight:600;font-size:15px;">${escapeHtml(p.title)}</div>`,
        price
          ? `<div style="margin-top:4px;" dir="ltr">${escapeHtml(price)}` +
            (was && was !== price
              ? ` <span style="color:#94a3b8;text-decoration:line-through;">${escapeHtml(s.was)} ${escapeHtml(was)}</span>`
              : "") +
            `</div>`
          : "",
        availability ? `<div style="margin-top:4px;color:#475569;font-size:13px;">${escapeHtml(availability)}</div>` : "",
        p.reason ? `<div style="margin-top:6px;color:#475569;font-size:13px;">${escapeHtml(p.reason)}</div>` : "",
        `<div style="margin-top:10px;">`,
        `<a href="${escapeHtml(p.productUrl)}" style="display:inline-block;padding:8px 14px;background:#111827;color:#ffffff;`,
        `text-decoration:none;border-radius:8px;font-size:13px;">${escapeHtml(p.buttonLabel ?? s.viewProduct)}: ${escapeHtml(p.title)}</a>`,
        `</div>`,
        `</td></tr></table></td></tr>`,
      ].join("");
    })
    .join("");

  return [
    `<div dir="${dir}" style="max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;">`,
    intro ? `<p style="font-size:15px;color:#0f172a;text-align:${align};">${escapeHtml(intro)}</p>` : "",
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${cards}</table>`,
    `</div>`,
  ].join("");
}

function truncate(raw: string, max: number): string {
  return raw.length <= max ? raw : `${raw.slice(0, Math.max(1, max - 1))}…`;
}
