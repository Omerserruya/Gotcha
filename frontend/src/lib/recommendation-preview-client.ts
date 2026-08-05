/**
 * The agent composer's copy of the channel decision.
 *
 * `packages/shared/src/channels/capabilities.ts` and
 * `recommendation-renderer.ts` decide how a recommendation is presented on
 * each channel. The frontend is not an npm workspace and cannot import
 * that package at runtime, so the parts an agent needs to SEE before
 * sending are restated here.
 *
 * Restating a rule is only safe if drift is caught. That is what
 * `frontend/src/lib/__tests__/recommendation-preview-parity.test.ts` is
 * for: it imports both and fails the moment the composer would show an
 * agent a carousel the customer will not receive.
 *
 * Deliberately NOT restated: the renderer's message construction. The
 * composer needs to know WHAT SHAPE is going out and what the channel
 * cannot do; it does not need to build the payload, and a second copy of
 * that logic would be a second place for a price to go wrong.
 */

export interface PreviewCapabilities {
  supportsProductCarousel: boolean;
  supportsCards: boolean;
  supportsImages: boolean;
  supportsUrlButtons: boolean;
  supportsQuickReplies: boolean;
  supportsNativeCatalog: boolean;
  supportsRichHtml: boolean;
  supportsSpeech: boolean;
  supportsAddToCart: boolean;
  maxButtons?: number;
  maxCards?: number;
  maxBodyChars?: number;
}

export type PreviewPresentation =
  | "native_catalog"
  | "native_carousel"
  | "rich_html"
  | "cards"
  | "image_cards"
  | "link_buttons"
  | "quick_replies"
  | "speech"
  | "text";

const NOTHING: PreviewCapabilities = {
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

export const PREVIEW_CAPABILITIES: Record<string, PreviewCapabilities> = {
  SHOPIFY_LIVE_CHAT: {
    ...NOTHING,
    supportsProductCarousel: true,
    supportsCards: true,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsQuickReplies: true,
    supportsAddToCart: true,
    maxCards: 5,
    maxButtons: 2,
    maxBodyChars: 2000,
  },
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
  WHATSAPP: {
    ...NOTHING,
    supportsImages: true,
    supportsQuickReplies: true,
    maxButtons: 3,
    maxCards: 3,
    maxBodyChars: 1024,
  },
  MESSENGER: {
    ...NOTHING,
    supportsImages: true,
    supportsQuickReplies: true,
    maxButtons: 13,
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
  SLACK: {
    ...NOTHING,
    supportsImages: true,
    supportsUrlButtons: true,
    supportsQuickReplies: true,
    maxButtons: 5,
    maxCards: 5,
    maxBodyChars: 3000,
  },
  SMS: { ...NOTHING, maxCards: 3, maxBodyChars: 320 },
  VOICE: { ...NOTHING, supportsSpeech: true, maxCards: 3, maxBodyChars: 600 },
};

export function previewCapabilitiesFor(channel: string | null | undefined): PreviewCapabilities {
  const key = String(channel ?? "").toUpperCase();
  return PREVIEW_CAPABILITIES[key] ?? NOTHING;
}

export const TEXT_ONLY_PREVIEW_CAPABILITIES: PreviewCapabilities = NOTHING;

/**
 * The same ladder the renderer walks. `productCount` and `hasAnyImage`
 * are the two facts that change the answer for a real selection: one
 * product is a card rather than a carousel, and a shortlist with no
 * imagery cannot be image cards.
 */
export function previewPresentation(
  caps: PreviewCapabilities,
  productCount: number,
  hasAnyImage: boolean,
): PreviewPresentation {
  if (productCount === 0) return "text";
  if (caps.supportsNativeCatalog) return "native_catalog";
  if (caps.supportsProductCarousel && productCount > 1) return "native_carousel";
  if (caps.supportsCards && caps.supportsRichHtml) return "rich_html";
  if (caps.supportsCards) return "cards";
  if (caps.supportsSpeech) return "speech";
  if (caps.supportsImages && hasAnyImage) return "image_cards";
  if (caps.supportsUrlButtons) return "link_buttons";
  if (caps.supportsQuickReplies) return "quick_replies";
  return "text";
}

/**
 * What this channel cannot do, in sentences an agent can act on. Shown
 * next to the preview so "three of these will not be sent" is visible
 * BEFORE the send, not discovered afterwards.
 */
export function previewLimitations(
  caps: PreviewCapabilities,
  presentation: PreviewPresentation,
  productCount: number,
): string[] {
  const notes: string[] = [];
  const limit = caps.maxCards ?? productCount;
  if (productCount > limit) {
    notes.push(
      `Only ${limit} of ${productCount} will be sent: this channel renders at most ${limit}.`,
    );
  }
  if (presentation === "image_cards" && !caps.supportsUrlButtons) {
    notes.push("No link buttons on this channel, so each product's link goes in its caption.");
  }
  if (presentation === "quick_replies") {
    notes.push("Buttons here reply with text and do not open a link, so links stay in the body.");
  }
  if (presentation === "speech") {
    notes.push("Voice carries no links. The spoken summary names the products; links need a text channel.");
  }
  if (presentation === "text") {
    notes.push("This channel renders text only. The customer receives a numbered list with links.");
  }
  if (!caps.supportsAddToCart) {
    notes.push("Add to cart is not available on this channel.");
  }
  return notes;
}
