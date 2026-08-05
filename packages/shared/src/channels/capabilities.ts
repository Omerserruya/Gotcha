/**
 * What each channel can actually render.
 *
 * Every flag here describes what GOTCHA has IMPLEMENTED, not what the
 * provider's API documentation says is possible. That distinction is the
 * entire value of the file. WhatsApp's Cloud API does support interactive
 * lists, CTA-URL buttons and multi-product catalog messages; this codebase
 * sends none of them, so `supportsUrlButtons` and `supportsNativeCatalog`
 * are false. A capability map that describes the vendor rather than the
 * build produces a renderer that emits payloads the adapter silently drops,
 * and a shopper who receives nothing.
 *
 * When an adapter grows a capability, flip the flag here in the same
 * change. The flag is the contract; the adapter is the implementation.
 */

import type { ChannelType } from "./types";

export interface ChannelCapabilities {
  /** A horizontally scrollable, natively rendered set of product cards. */
  supportsProductCarousel: boolean;
  /** Structured cards - image, title, price, actions - rendered natively. */
  supportsCards: boolean;
  supportsImages: boolean;
  /** Buttons that OPEN A URL. Reply/postback buttons are not these. */
  supportsUrlButtons: boolean;
  /** Reply/postback buttons that send text back, carrying no link. */
  supportsQuickReplies: boolean;
  /** The provider's own product/catalog message type. */
  supportsNativeCatalog: boolean;
  /** Real HTML with layout, images and links (email family). */
  supportsRichHtml: boolean;
  /** The message is spoken, not read. */
  supportsSpeech: boolean;
  /** Add to Cart can be completed inside the conversation. */
  supportsAddToCart: boolean;
  maxButtons?: number;
  maxCards?: number;
  /** Practical body limit for one message. Drives text splitting. */
  maxBodyChars?: number;
}

/**
 * Channels the renderer knows about.
 *
 * A superset of the adapter-layer `ChannelType`, on purpose:
 *   • VOICE exists in the Prisma ChannelType enum and has a whole service
 *     behind it, but no inbound/outbound *adapter*, so it is absent from
 *     the adapter union while still being a channel a recommendation can
 *     be asked to render on.
 *   • SMS has neither yet. It is mapped anyway so the fallback is decided
 *     here rather than improvised at a call site the day it lands.
 */
export type RecommendationChannel = ChannelType | "SMS" | "VOICE";

const NOTHING: ChannelCapabilities = {
  supportsProductCarousel: false,
  supportsCards: false,
  supportsImages: false,
  supportsUrlButtons: false,
  supportsQuickReplies: false,
  supportsNativeCatalog: false,
  supportsRichHtml: false,
  supportsSpeech: false,
  supportsAddToCart: false,
};

export const CHANNEL_CAPABILITIES: Record<RecommendationChannel, ChannelCapabilities> = {
  // The storefront widget renders its own carousel, its own cards and its
  // own Add to Cart against the theme's cart. Everything here is real and
  // shipped; see frontend/public/widget/gotcha-shopify-chat.js.
  SHOPIFY_LIVE_CHAT: {
    ...NOTHING,
    supportsProductCarousel: true,
    supportsCards: true,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsQuickReplies: true,
    supportsAddToCart: true,
    maxCards: 5, // MAX_CAROUSEL_ITEMS - past ~5 a shopper scrolls instead of choosing
    maxButtons: 2, // View product + Add to cart
    maxBodyChars: 2000,
  },

  // The website widget loads the SAME bundle with a different apiPath, so
  // it can render exactly the same cards. What it cannot do is complete a
  // purchase: there is no storefront cart behind it.
  WEBCHAT: {
    ...NOTHING,
    supportsProductCarousel: true,
    supportsCards: true,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsQuickReplies: true,
    maxCards: 5,
    maxButtons: 2,
    maxBodyChars: 2000,
  },

  // Implemented: text, media with caption, and up to 3 REPLY buttons
  // (interactive type "button"). Not implemented: interactive lists,
  // CTA-URL buttons, single- or multi-product catalog messages.
  //
  // So a WhatsApp recommendation is images with the link in the caption,
  // never a button a shopper can tap through to the product. Claiming
  // otherwise here would produce payloads whatsapp.adapter cannot send.
  WHATSAPP: {
    ...NOTHING,
    supportsImages: true,
    supportsQuickReplies: true,
    maxButtons: 3, // hard Cloud API limit on interactive type "button"
    maxCards: 3, // one media message per product; more is a flood, not a shortlist
    maxBodyChars: 1024, // media caption limit, the tighter of the two
  },

  // Implemented: text, media, and quick_replies. Generic/product templates
  // are not wired, so there are no native cards and no URL buttons.
  MESSENGER: {
    ...NOTHING,
    supportsImages: true,
    supportsQuickReplies: true,
    maxButtons: 13, // Meta's quick_replies limit, honoured by the adapter
    maxCards: 3,
    maxBodyChars: 2000,
  },

  INSTAGRAM: {
    ...NOTHING,
    supportsImages: true,
    supportsQuickReplies: true,
    maxButtons: 13,
    maxCards: 3,
    maxBodyChars: 1000,
  },

  // All three email adapters send real HTML with links (see the
  // sendInteractiveMessage implementations). HTML IS the card format for
  // email, so `supportsCards` is true and the renderer produces a
  // responsive card layout rather than a degraded image-with-caption.
  EMAIL: {
    ...NOTHING,
    supportsCards: true,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsRichHtml: true,
    maxCards: 6,
    maxButtons: 6,
    maxBodyChars: 100000,
  },
  GMAIL: {
    ...NOTHING,
    supportsCards: true,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsRichHtml: true,
    maxCards: 6,
    maxButtons: 6,
    maxBodyChars: 100000,
  },
  OUTLOOK: {
    ...NOTHING,
    supportsCards: true,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsRichHtml: true,
    maxCards: 6,
    maxButtons: 6,
    maxBodyChars: 100000,
  },

  // Slack Block Kit would give real cards. The adapter posts text and
  // attachments today, so: images yes, cards no.
  SLACK: {
    ...NOTHING,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsQuickReplies: true,
    maxButtons: 5,
    maxCards: 5,
    maxBodyChars: 3000,
  },

  // No adapter yet. Mapped so the answer is decided rather than improvised:
  // a numbered list, short links, one message.
  SMS: {
    ...NOTHING,
    maxCards: 3,
    maxBodyChars: 320, // two concatenated segments; more is a wall
  },

  // Spoken. A URL read aloud is noise, so the spoken part carries the
  // shortlist and the links go out over a companion text channel.
  VOICE: {
    ...NOTHING,
    supportsSpeech: true,
    maxCards: 3,
    maxBodyChars: 600,
  },
};

/**
 * Capabilities for a channel. Unknown channels get NOTHING, which renders
 * clean text - the one presentation every channel in existence supports.
 */
export function capabilitiesFor(channel: string | null | undefined): ChannelCapabilities {
  const key = String(channel ?? "").toUpperCase() as RecommendationChannel;
  return CHANNEL_CAPABILITIES[key] ?? NOTHING;
}

/** The plain-text floor, for tests and for anything building its own map. */
export const TEXT_ONLY_CAPABILITIES: ChannelCapabilities = NOTHING;
