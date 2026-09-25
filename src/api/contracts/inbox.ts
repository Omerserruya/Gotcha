import { z } from 'zod';

/**
 * Screens 02 and 02b — the Inbox.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FOUR THINGS THE DESIGN DRAWS THAT HAVE NO DATA BEHIND THEM
 * ════════════════════════════════════════════════════════════════════════════
 * Recorded here rather than discovered per component, because each is a
 * visible element a reader will look for:
 *
 *   voice-note transcript   *"Read what she said"* — an inbound voice note is
 *                           stored as a file and nothing transcribes it. The
 *                           only audio-specific code in the worker is
 *                           `case "audio": return ".ogg"`, an extension for a
 *                           filename. **The Deepgram credential is present and
 *                           the client is not**, which is worth saying because
 *                           "we have the key" reads like "we have the feature"
 *   image understanding     *"GOTCHA saw damage in this photo"* — no vision
 *                           path anywhere, no `image_url` content parts
 *   cost per reply          *"Replace it now · costs ₪179"* — nothing prices an
 *                           action before proposing it. The only `estimatedCost`
 *                           in the platform is a broadcast's per-recipient send
 *                           cost, which is a different thing entirely
 *   reactions               no model. The design shows a React action; it is
 *                           left out rather than drawn disabled
 *
 * ── AND TWO THAT LOOK PRESENT AND ARE NOT ──
 *
 * **Agent-unread does not exist.** Nothing on `Conversation` records read
 * state for the agent side. `Message.readAt` is the CUSTOMER's receipt — the
 * same word for a different fact — and using it would show an agent's queue
 * as read because the customer read our reply. See `agentUnreadIsUnknown`.
 *
 * **Per-message intent does not persist.** `ConversationIntelligence` carries
 * `detectedIntent` per CONVERSATION with a confidence. The per-message type
 * exists in `ai-assist.service.ts` and nothing writes it, so the design's
 * *"3px left edge plus one small line"* — which is per message — has no data.
 * The conversation-level intent can sit on the list row; the edge cannot be
 * drawn.
 */

/* ── The list ────────────────────────────────────────────────────────────── */

/**
 * ★ THREE STATES, NOT THE DESIGN'S FIVE.
 *
 * `ConversationStatus` is `OPEN | WAITING | CLOSED`. Waiting-on-customer and
 * waiting-on-business are one undifferentiated `WAITING`, and
 * waiting-on-an-external-system does not exist at all — so 02b's *"11
 * exchanges held — returns system down"* has no state to hang on.
 */
export const CONVERSATION_STATUSES = ['OPEN', 'WAITING', 'CLOSED'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Who is carrying it. Richer than the design needs, and `null` is a real
 * value: an unrouted conversation is held by nobody, which is different from
 * being held by a person who has not replied.
 */
export const HANDLED_BY = ['ai_agent', 'flow', 'human'] as const;
export type HandledBy = (typeof HANDLED_BY)[number];

export const conversationRowSchema = z.object({
  id: z.string(),
  status: z.enum(CONVERSATION_STATUSES),
  channel: z.string().nullable().default(null),
  handledBy: z.enum(HANDLED_BY).nullable().default(null),
  assignedAgentId: z.string().nullable().default(null),
  assignedAiAgentId: z.string().nullable().default(null),
  isHandedOver: z.boolean().default(false),
  /** Drives "waiting 14m". Required: a row with no last message cannot be aged. */
  lastMessageAt: z.string().nullable().default(null),
  contactName: z.string().nullable().default(null),
});
export type ConversationRow = z.infer<typeof conversationRowSchema>;

/**
 * How long since the last message, in minutes, or `null`.
 *
 * ★ THIS IS "WAITING", NOT "FIRST REPLY TOOK". The design shows both and only
 * this one is computable from the list: `lastMessageAt` is the most recent
 * message either way, so it cannot say how long the FIRST reply took, and it
 * does not distinguish waiting-on-us from waiting-on-them.
 */
export function waitingMinutes(row: ConversationRow, now: Date): number | null {
  if (!row.lastMessageAt) return null;
  const at = Date.parse(row.lastMessageAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 60_000));
}

/**
 * ★★ AGENT-UNREAD IS NOT KNOWABLE, AND THE NEAREST FIELD IS A TRAP.
 *
 * A function rather than a constant so the prohibition is importable and
 * testable: any component tempted to compute unread has to call this and get
 * `false` back, and any future field has exactly one place to be added.
 *
 * `Message.readAt` is the customer's read receipt. Reading it as "the agent
 * has seen this" would mark a queue read because the CUSTOMER read our
 * reply — the same word for the opposite party's fact.
 */
export function agentUnreadIsUnknown(): true {
  return true;
}

/* ── The stream ──────────────────────────────────────────────────────────── */

/**
 * ⚠ `messageType` IS AN UNCONSTRAINED `String` ON THE MODEL.
 *
 * Observed writers produce at least: text, image, video, audio, document,
 * location, template, interactive, system, voice_final, email,
 * shopify_product. There is no enum, so this list is what somebody has
 * written so far and not a domain.
 *
 * So the renderer switches on the ones it can account for and lets
 * everything else fall to a neutral case. The trap is the same as
 * `KnowledgeDocument.status`: **an unconstrained string rendered through an
 * exhaustive switch turns an unknown into whatever the default branch
 * happens to be**, and a default branch that says "system message" would
 * mislabel the next type somebody adds.
 */
export const KNOWN_MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'location',
  'template',
  'interactive',
  'system',
] as const;
export type KnownMessageType = (typeof KNOWN_MESSAGE_TYPES)[number];

export const messageSchema = z.object({
  id: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  body: z.string().default(''),
  /** Free string. Use `renderableType`, never a bare switch. */
  messageType: z.string().default('text'),
  mediaUrl: z.string().nullable().default(null),
  createdAt: z.string(),
  deliveredAt: z.string().nullable().default(null),
  /** The CUSTOMER's read receipt. Never the agent's. */
  readAt: z.string().nullable().default(null),
  /**
   * ★★ BOTH REPLY COLUMNS, AND THAT IS THE POINT.
   *
   * `replyToExternalId` is the provider's id and is always present on a
   * reply. `replyToMessageId` is ours and **can fail to resolve** — the
   * quoted message may predate GOTCHA or have been deleted.
   *
   * Keeping the external id when the lookup misses is what lets the stream
   * say *"replying to an earlier message"* instead of showing nothing. The
   * `available: false` distinction, living in a message row.
   */
  replyToExternalId: z.string().nullable().default(null),
  replyToMessageId: z.string().nullable().default(null),
});
export type InboxMessage = z.infer<typeof messageSchema>;

/** A type we can render, or `null` for one we cannot account for. */
export function renderableType(message: InboxMessage): KnownMessageType | null {
  const type = message.messageType.trim().toLowerCase();
  return (KNOWN_MESSAGE_TYPES as readonly string[]).includes(type)
    ? (type as KnownMessageType)
    : null;
}

/** How a reply-to should be shown: the quoted message, a stub, or nothing. */
export type QuotedState = 'resolved' | 'unresolved' | 'none';

/**
 * ★ "UNRESOLVED" IS A THIRD STATE AND THE STREAM SHOWS IT.
 *
 * A reply whose quoted message we never stored is still visibly a reply.
 * Rendering it as an ordinary message loses the fact that the customer was
 * answering something, which is often the only thing that makes it legible.
 */
export function quotedState(message: InboxMessage): QuotedState {
  if (message.replyToMessageId) return 'resolved';
  if (message.replyToExternalId) return 'unresolved';
  return 'none';
}

/**
 * Is a voice note's content available to read?
 *
 * Always `false`. Nothing transcribes audio: the worker's only
 * audio-specific line is a filename extension, and the Deepgram credential
 * exists without a client. A function so the stream can say *"a voice note —
 * we can't read it out for you"* from one place, and so the day a
 * transcriber exists there is one thing to change.
 */
export function hasTranscript(_message: InboxMessage): false {
  return false;
}
