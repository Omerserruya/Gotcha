/**
 * Channel abstraction.
 *
 * The Inbox will carry WhatsApp, Instagram, email, web chat and voice. The
 * failure this exists to prevent is `if (channel === 'whatsapp')` spreading
 * through every component until adding a sixth channel means editing forty
 * files and missing three.
 *
 * The split is: what every channel HAS is normalised into one shape; what only
 * some channels CAN DO is declared as capabilities and queried. A component
 * asks "may I edit this message?", never "is this WhatsApp?".
 *
 * Nothing here is wired to the backend. The platform declares no response
 * schemas, so the mapping from provider payloads onto these types is written
 * per channel when the Inbox is built and each contract is confirmed.
 */

/** Stable codes. Display names come from the translation layer. */
export type ChannelId = 'whatsapp' | 'instagram' | 'email' | 'web_chat' | 'voice';

/**
 * What a channel supports.
 *
 * Declared per channel rather than inferred, because the differences are not
 * guessable: WhatsApp allows editing within a window, Instagram does not;
 * email threads by subject, WhatsApp by reply reference.
 */
export interface ChannelCapabilities {
  readonly canReplyToSpecificMessage: boolean;
  readonly canEditSentMessage: boolean;
  readonly canDeleteSentMessage: boolean;
  readonly canSendAttachments: boolean;
  readonly canSendRichText: boolean;
  readonly canReact: boolean;
  readonly reportsReadReceipts: boolean;
  readonly reportsTyping: boolean;
  /**
   * Whether outbound messages are restricted to a time window after the
   * customer's last message. WhatsApp's 24-hour rule is the reason this is
   * modelled at all: a composer must be able to disable itself and say why.
   */
  readonly hasReplyWindow: boolean;
  readonly supportedAttachmentKinds: readonly MediaKind[];
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'location' | 'contact';

/** Where a message came from. */
export type SenderKind = 'customer' | 'human_agent' | 'ai_employee' | 'system';

export interface Sender {
  readonly kind: SenderKind;
  /** Absent for `system`. */
  readonly id?: string;
  readonly displayName?: string;
}

/**
 * Delivery state, normalised across providers.
 *
 * Providers disagree on both names and granularity. Normalising here means the
 * UI renders one set of states and a channel that reports fewer simply never
 * produces the missing ones.
 */
export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MediaAttachment {
  readonly kind: MediaKind;
  /**
   * Must be validated before use. A URL from a provider is untrusted input:
   * see `assertSafeMediaUrl` in `src/lib`-adjacent security helpers before
   * placing one in `src` or `href`.
   */
  readonly url: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly durationSeconds?: number;
}

/** A message, in the shape the UI renders regardless of origin. */
export interface NormalisedMessage {
  readonly id: string;
  readonly channel: ChannelId;
  readonly sender: Sender;
  /** Epoch milliseconds, UTC. Formatting is the i18n layer's job. */
  readonly sentAt: number;
  /** Plain text. Rich content arrives as `media`, never as raw HTML. */
  readonly text?: string;
  readonly media: readonly MediaAttachment[];
  readonly delivery: DeliveryState;
  /** The message this one replies to, where the channel supports it. */
  readonly replyToMessageId?: string;
  /** True once the channel's edit window has closed. */
  readonly isEdited?: boolean;
}

const NO_ATTACHMENTS: readonly MediaKind[] = [];

/**
 * The capability table.
 *
 * Deliberately conservative: every flag defaults to false and is turned on
 * only when the channel's support is confirmed. A capability wrongly declared
 * true produces a control that fails on click; wrongly false produces a
 * control that is merely absent. The second is the cheaper mistake.
 *
 * Values are placeholders until each channel's integration is built and its
 * contract verified - see docs/api-gaps.md.
 */
const CAPABILITIES: Record<ChannelId, ChannelCapabilities> = {
  whatsapp: base({ hasReplyWindow: true, canReplyToSpecificMessage: true }),
  instagram: base({ canReplyToSpecificMessage: true }),
  email: base({ canSendRichText: true }),
  web_chat: base(),
  voice: base({ canSendAttachments: false }),
};

function base(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    canReplyToSpecificMessage: false,
    canEditSentMessage: false,
    canDeleteSentMessage: false,
    canSendAttachments: false,
    canSendRichText: false,
    canReact: false,
    reportsReadReceipts: false,
    reportsTyping: false,
    hasReplyWindow: false,
    supportedAttachmentKinds: NO_ATTACHMENTS,
    ...overrides,
  };
}

export function capabilitiesOf(channel: ChannelId): ChannelCapabilities {
  return CAPABILITIES[channel];
}

/**
 * Whether a channel supports a capability.
 *
 * This is the function components call. `supports(channel, 'canReact')` reads
 * as intent; `channel === 'whatsapp' || channel === 'instagram'` reads as a
 * list that will be wrong the next time a channel is added.
 */
export function supports(
  channel: ChannelId,
  capability: {
    [K in keyof ChannelCapabilities]: ChannelCapabilities[K] extends boolean ? K : never;
  }[keyof ChannelCapabilities],
): boolean {
  return CAPABILITIES[channel][capability];
}
