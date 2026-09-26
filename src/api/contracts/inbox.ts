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
 * **Per-message intent does not persist YET, and it is authorized.**
 * `ConversationIntelligence` carries `detectedIntent` per CONVERSATION; the
 * per-message type exists in `ai-assist.service.ts` and nothing writes it,
 * so the design's *"3px left edge plus one small line"* has no data today.
 *
 * ★ OMER HAS APPROVED PERSISTING IT (2026-09-26), so this is a gap with a
 * date on it rather than a decision. Recorded that way deliberately: a note
 * saying only "does not exist" invites the next reader to design permanently
 * around it, which is how a temporary absence becomes a fixed shape.
 *
 * Until the column lands the marker is not drawn, and **absent will not mean
 * "no intent" — it means nobody recorded one.** The stream renders per
 * message with its own attributes, so adding the edge is an attribute and a
 * style rather than a restructure.
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
  /**
   * ★★ WHERE A SYSTEM MESSAGE KEEPS ITS MEANING.
   *
   * `createSystemMessage` writes `body: ""` and puts everything in metadata:
   * `{ systemEvent, ...eventData }`. So a claim, a transfer and a return to
   * the AI are all the same empty INBOUND row until this is read — and
   * rendered as messages they look like the customer sending nothing.
   *
   * Only the keys we draw are named. The rest are stripped, which is right
   * here: the unnamed ones are other events' payloads, and a divider that
   * printed an unknown field would be guessing at what happened.
   *
   * On the wire because `listByConversation` puts no `select` on the message
   * itself — it takes the whole row. Checked rather than assumed: the
   * conversation payload one route along **does** strip metadata.
   */
  metadata: z
    .object({
      systemEvent: z.string().optional(),
      /** `agent_claimed`. */
      agentName: z.string().optional(),
      /** `agent_transferred`. */
      fromAgentName: z.string().optional(),
      toAgentName: z.string().optional(),
    })
    .nullish()
    .default(null),
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

/* ── Ordering, and what the column it depends on is worth ────────────────── */

/**
 * The queue, newest first — and the rows whose place we cannot determine.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS SPLIT IS PER PAGE, AND THE SERVER SORTS NULLS LAST
 * ════════════════════════════════════════════════════════════════════════════
 * `orderBy` is `{ lastMessageAt: { sort: "desc", nulls: "last" } }`, so every
 * undated row is **at the very end of the whole queue** — after every dated
 * one, on the last page.
 *
 * So on a tenant with more conversations than one page holds, this function
 * returns an empty `undated` on every page but the last, and the group
 * disappears. **It is a per-page view of a whole-queue fact**, and the
 * screen must say so rather than letting an empty group read as "none".
 *
 * Answering "how many conversations have no `lastMessageAt`" properly needs
 * a count of its own, which no endpoint offers. Until one does, the caption
 * carries the scope — see `ConversationList`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `lastMessageAt` IS A DENORMALISED CACHE MAINTAINED BY CONVENTION
 * ════════════════════════════════════════════════════════════════════════════
 * It is written at ten call sites, and **ten or more writers bypass
 * `message.service` entirely.** One conversation on dev has it null while
 * being open, not a test, and carrying two real messages — the sandbox
 * writer never sets it.
 *
 * So the column the queue sorts by is maintained by everybody remembering,
 * and a **stale** value has no symptom at all: a conversation whose newest
 * message arrived through a forgetful writer sinks down the list while
 * somebody waits, and the list looks entirely normal.
 *
 * We cannot detect staleness from here — a plausible-but-old timestamp is
 * indistinguishable from a correct one. What we CAN do is refuse to bury the
 * rows that admit they do not know.
 *
 * ── SO NULL GOES IN ITS OWN GROUP, NOT AT THE BOTTOM ──
 * Sorted naively, a null sinks to the floor of a recency-ordered list and is
 * never seen — which is the same defect as the offset-pagination skip, and
 * the reason the capped list exists. Sorted to the top it would claim to be
 * the most recent, which it does not know either.
 *
 * Its own group says the true thing: **these are open and we cannot tell
 * where they belong.** The caption names it, and the count makes a growing
 * problem visible rather than gradual.
 */
export function queueOrder(rows: readonly ConversationRow[]): {
  readonly dated: readonly ConversationRow[];
  readonly undated: readonly ConversationRow[];
} {
  const dated: ConversationRow[] = [];
  const undated: ConversationRow[] = [];
  for (const row of rows) {
    if (row.lastMessageAt && Number.isFinite(Date.parse(row.lastMessageAt))) dated.push(row);
    else undated.push(row);
  }
  dated.sort((a, b) => Date.parse(b.lastMessageAt!) - Date.parse(a.lastMessageAt!));
  return { dated, undated };
}

/* ── What a colleague did, which is not a message ────────────────────────── */

/**
 * The system events `conversation.service.ts` writes.
 *
 * All four are `messageType: "system"`, `direction: "INBOUND"` and
 * `body: ""`. The direction is the service's, not a statement about who
 * acted — rendering them as inbound bubbles puts a colleague's action on the
 * customer's side of the thread.
 */
export const SYSTEM_EVENTS = [
  'agent_claimed',
  'agent_transferred',
  'department_transferred',
  'returned_to_ai',
] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

/**
 * The event this row records, or `null` if it is not one we can account for.
 *
 * `department_transferred` is included although this product never offers a
 * department transfer: the platform writes it, other clients can cause it,
 * and a divider that skipped it would leave an unexplained gap in the thread
 * exactly where somebody needs to know the conversation moved.
 *
 * Unknown events return `null` and fall to the stream's "we cannot show
 * this" line — **not** to a generic "something happened", which would be the
 * `messageType` trap one level down: an unconstrained string read through an
 * exhaustive switch, where the default branch names something it does not
 * know.
 */
export function systemEventOf(message: InboxMessage): SystemEvent | null {
  const event = message.metadata?.systemEvent?.trim();
  if (!event) return null;
  return (SYSTEM_EVENTS as readonly string[]).includes(event) ? (event as SystemEvent) : null;
}
