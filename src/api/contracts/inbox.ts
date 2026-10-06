import { z } from 'zod';

import { CHANNEL_TYPES } from './channels';

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
  /**
   * ★★ `customerName`, WHICH IS THE COLUMN'S NAME. NOT `contactName`.
   *
   * This said `contactName`, a field the platform has never sent. `z.object`
   * stripped the real one, the invented one defaulted to `null`, and **every
   * row in the queue read "Someone"** — ten of ten in the capture, which read
   * as redaction by the security fixtures and was neither redaction nor
   * fixtures.
   *
   * The list route puts no `select` on the conversation, so every scalar on
   * the model arrives. The field was there the whole time under the name the
   * schema gives it.
   */
  customerName: z.string().nullable().default(null),
  /**
   * The handle this conversation arrived on — a phone number on WhatsApp, a
   * PSID on Messenger. Required on the model, so nullable only for a route
   * that does not send it.
   *
   * ★ AND ITS ABSENCE WAS VISIBLE: `IdentityPanel` said *"No channel handle is
   * recorded for this person"* while the row beside it showed a channel,
   * because the page had no handle to pass it. Two true sentences about
   * different things, reading as a contradiction.
   */
  customerExternalId: z.string().nullable().default(null),
  /**
   * The person this conversation is with — Backend is adding it (asked
   * 2026-10-06, read-only, merged → target). Named now so it is not stripped
   * the day it arrives; `null` until then, and the wall says "—" with why.
   */
  contactId: z.string().min(1).nullable().catch(null).default(null),
  /**
   * The last message the CUSTOMER could have seen, flattened by the route
   * from a `take: 1` — and excluding FAILED sends, deliberately: *"a failed
   * outbound is a message the customer never received"*, so previewing it
   * would make the row read as answered.
   */
  lastMessageBody: z.string().nullable().default(null),
  /**
   * ★★ WHO SPOKE LAST, WHICH IS NOT THE SAME AS "UNREAD" AND IS STILL USEFUL.
   *
   * `agentUnreadIsUnknown()` remains true: there is no per-user read marker in
   * the schema and `Message.readAt` is the customer's receipt. But the route
   * projects this, and INBOUND-last is a fact — **the customer spoke and
   * nobody has answered** — which is the thing the queue is actually for.
   *
   * It is not "you have not read this". Two people looking at the same queue
   * see the same value, and that is correct for what it claims.
   */
  lastMessageDirection: z.enum(['INBOUND', 'OUTBOUND']).nullable().default(null),
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
/**
 * How to say a wait, at a scale a person can read.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `47061m` WAS ON SCREEN, AND IT IS THIRTY-TWO DAYS
 * ════════════════════════════════════════════════════════════════════════════
 * The row printed `{minutes}m` unconditionally, so the capture showed `47061m`,
 * `86110m`, `86409m` — and the wait column is the thing an agent triages on.
 * It was not even legible as a duration: read quickly, `47061m` looks like an
 * identifier, which is how it was first reported.
 *
 * Minutes below an hour, hours below a day, days beyond that. The unit is
 * chosen here rather than in the component so the queue and anything else that
 * ages a row cannot disagree.
 */
export type WaitingScale = 'minutes' | 'hours' | 'days';

export function waitingScale(minutes: number): { scale: WaitingScale; value: number } {
  if (minutes < 60) return { scale: 'minutes', value: minutes };
  if (minutes < 60 * 24) return { scale: 'hours', value: Math.floor(minutes / 60) };
  return { scale: 'days', value: Math.floor(minutes / (60 * 24)) };
}

/**
 * The channel's own name, or `null` when the platform sends one we do not know.
 *
 * ★ `Conversation.channel` IS AN UNCONSTRAINED STRING and the capture showed
 * `SHOPIFY_LIVE_CHAT` and `WHATSAPP` on screen — a screaming-snake enum on the
 * operational screen, where `channels.name.*` has carried both labels in both
 * languages all along.
 *
 * `null` for an unrecognised value rather than the raw string: every other
 * screen in this product strips raw identifiers, and an agent cannot act on an
 * enum name. The caller says "another channel" and the value goes to the log,
 * which is where a new channel type should surface.
 */
/**
 * A channel in the reader's language, or `null` when there is no channel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONE FUNCTION, BECAUSE THIS DEFECT HAS NOW BEEN FOUND TEN TIMES
 * ════════════════════════════════════════════════════════════════════════════
 * A raw channel enum reaching a reader has been fixed at ten separate sites:
 * the inbox queue, Home's queue rows, Home's channel bar, Home's "worth
 * knowing" sentence, the inbox identity panel, the automations list, the AI
 * employees list, the campaign card, the customer timeline, and the channels
 * screen. Six of those were found only after the first three were "fixed".
 *
 * Every one of them had written the same three lines by hand:
 *
 *     channelLabelKey(x) ? t(`name.${x}`) : t('name.other')
 *
 * A pattern copied at ten sites is a function that has not been written yet,
 * and the eleventh site will be written by somebody who has not read any of
 * this. So this is the only place that shape exists now.
 *
 * `t` is the `channels` namespace translator, passed in rather than resolved
 * here: this module is a contract and must not reach for a framework.
 */
export function channelName(
  channel: string | null | undefined,
  /*
   * Typed as the two keys this function can ask for. next-intl's namespace
   * translator accepts every key in `channels.json`, and a function that
   * accepts more is assignable where one accepting fewer is wanted — so callers
   * pass `channelNames` straight in, with no cast at the call site. The cast
   * that used to sit at each of those sites is the thing being removed.
   */
  t: (key: 'name.WHATSAPP' | 'name.other') => string,
): string | null {
  if (!channel) return null;
  return channelLabelKey(channel)
    ? t(`name.${channel}` as 'name.WHATSAPP')
    : /*
       * A channel the platform added after this catalogue was written. Naming it
       * "another channel" keeps the sentence true; printing the enum would make
       * the reader do the translating.
       */
      t('name.other');
}

/** Every channel in a list, named. Unknown ones collapse to one "another channel". */
export function channelNameList(
  channels: readonly string[],
  t: (key: 'name.WHATSAPP' | 'name.other') => string,
): string[] {
  const named = channels.map((channel) => channelName(channel, t)).filter((x): x is string => !!x);
  return [...new Set(named)];
}

export function channelLabelKey(channel: string | null): string | null {
  if (!channel) return null;
  const known = (CHANNEL_TYPES as readonly string[]).includes(channel);
  return known ? channel : null;
}

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
  // Drawn since the media round: a voice note under its own name, a sticker, a shared contact.
  'voice',
  'sticker',
  'contact',
  'contacts',
] as const;
export type KnownMessageType = (typeof KNOWN_MESSAGE_TYPES)[number];

/**
 * `Message.status`, which this contract did not name until 2026-09-27.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ PENDING AND FAILED WERE INDISTINGUISHABLE, AND THAT IS THE WHOLE POINT
 * ════════════════════════════════════════════════════════════════════════════
 * The schema has carried `deliveredAt` and `readAt` all along, so a delivered
 * message could be told from an undelivered one. **A FAILED message has no
 * timestamp either** — it looks exactly like one still on its way. So an
 * outbound reply that the customer never received rendered identically to one
 * sent a second ago.
 *
 * `GET /api/conversations/:id/messages` puts no `select` on the row, so `status`
 * has been on the wire the entire time and `z.object` was stripping it. Third
 * time this week; see `contracts/README.md`.
 *
 * ── WHY `z.string()` AND NOT `z.enum(...).catch('PENDING')` ──
 * The house pattern for a status column is an enum with a catch, and it is wrong
 * here. Catching an unrecognised value to `PENDING` would render a failure we do
 * not recognise as **"on its way"** — the reassuring direction, on the one field
 * whose entire job is to stop somebody believing a message arrived. So the raw
 * value is kept, never rendered, and `deliveryOf` maps it to a closed set with
 * an explicit `unknown`.
 */
export const MESSAGE_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export type Delivery = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';

/**
 * What happened to an outbound message, from every source we hold.
 *
 * `null` for an inbound message: `status` on one of those describes OUR
 * ingestion, not anything the reader can act on, and a "delivered" marker beside
 * the customer's own words would be nonsense.
 *
 * The order is evidence-strength, and the first line is the one that matters:
 *
 *   · `FAILED` wins over any timestamp. A failure is not undone by a `sentAt`
 *     recorded before the provider rejected it.
 *   · then `readAt`, then `deliveredAt` — a specific timestamp beats a column
 *     that may not have caught up.
 *   · then the status itself, if we recognise it.
 *   · then `unknown`, which the stream says out loud rather than treating as
 *     "fine". **The safe default for "did this arrive" is no.**
 */
export function deliveryOf(message: {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly status?: string | undefined;
  readonly deliveredAt?: string | null;
  readonly readAt?: string | null;
}): Delivery | null {
  if (message.direction === 'INBOUND') return null;

  const status = message.status?.trim().toUpperCase();
  if (status === 'FAILED') return 'failed';
  if (message.readAt) return 'read';
  if (message.deliveredAt) return 'delivered';
  if (status !== undefined && (MESSAGE_STATUSES as readonly string[]).includes(status)) {
    return status.toLowerCase() as Delivery;
  }
  return 'unknown';
}

export const messageSchema = z.object({
  id: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  body: z.string().default(''),
  /** Free string. Use `renderableType`, never a bare switch. */
  messageType: z.string().default('text'),
  mediaUrl: z.string().nullable().default(null),
  /** The sender's own name for a file — the download's label. */
  fileName: z.string().nullish().catch(null).default(null),
  createdAt: z.string(),
  /**
   * `PENDING · SENT · DELIVERED · READ · FAILED`. Read through `deliveryOf`,
   * never directly — see the note above `MESSAGE_STATUSES`.
   *
   * `.optional()` rather than `.default('PENDING')`: a deploy that does not send
   * it must not be indistinguishable from one reporting a message on its way.
   */
  status: z.string().optional(),
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
   * The provider's own id for this message. What a reaction points at — Meta
   * names the target by `wamid`, never by ours.
   */
  externalMessageId: z.string().nullable().default(null),
  /**
   * Who sent it, as the writer put it — and writers disagree. A human agent's
   * send writes their LOGIN EMAIL (`req.user.email`); an AI employee writes
   * its name; the platform writes "System", a storefront shopper "Shopper".
   * So it is shown only through `senderLabel`, which knows that.
   */
  senderName: z.string().nullish().default(null),
  /**
   * ★★ THE QUOTED MESSAGE, WHICH TRAVELLED WITH THE REPLY ALL ALONG.
   * `listByConversation` includes `replyTo { id, body, direction,
   * messageType, senderName, mediaUrl, fileName }` precisely so a quote from
   * last week can be drawn without being on this page — and this schema
   * stripped it. `null` when the reply's target is not stored.
   */
  replyTo: z
    .object({
      id: z.string(),
      body: z
        .string()
        .nullish()
        .transform((body) => body ?? ''),
      direction: z.enum(['INBOUND', 'OUTBOUND']),
      messageType: z.string().nullish().default('text'),
      senderName: z.string().nullish().default(null),
    })
    .nullish()
    .default(null),
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
      /** The attachment could not be fetched (WhatsApp media expires) — said, never blank. */
      mediaError: z.string().optional().catch(undefined),
      /** A shared contact card: who, and the numbers to reach them. */
      contacts: z
        .array(
          z.object({
            name: z.string().nullish().catch(null),
            organization: z.string().nullish().catch(null),
            phones: z
              .array(
                z.object({
                  number: z.string().nullish().catch(null),
                  waId: z.string().nullish().catch(null),
                }),
              )
              .catch([])
              .default([]),
          }),
        )
        .optional()
        .catch(undefined),
      /**
       * ★★ A MESSAGE THE PROVIDER COULD NOT BE REPRESENTED AS ANYTHING ELSE.
       *
       * `whatsapp.adapter.ts`'s default branch turns an unmodelled type into
       * `{ type: "text", text: "[<type> message]" }` and attaches the real
       * payload here; `webhook.ts:344` persists it. So the row LOOKS like a
       * text message whose body is a bracketed token, and everything the
       * provider actually sent is in this object.
       *
       * Only `reaction` is decoded, because it is the only one whose shape
       * this product has read. Everything else is named, not interpreted.
       */
      unsupported: z
        .object({
          providerType: z.string().optional(),
          raw: z
            .object({
              reaction: z
                .object({
                  message_id: z.string().optional(),
                  /** Empty string is Meta's "the reaction was REMOVED". */
                  emoji: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
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
/**
 * The sender worth naming on a message's time line, or `null`.
 *
 * ⚠ A human agent's send stores their LOGIN EMAIL as `senderName`. An email
 *   is an identifier, not a name, and printing a colleague's address under
 *   every reply is not what 02's "Support AI" slot is for. The platform tells
 *   them apart the same way — `live-voice.service` counts humans by
 *   `senderName contains "@"`.
 *
 * Outbound only: an inbound sender is the customer, whom the header names.
 */
export function senderLabel(message: {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly senderName?: string | null;
}): string | null {
  if (message.direction !== 'OUTBOUND') return null;
  const name = message.senderName?.trim() ?? '';
  return name === '' || name.includes('@') ? null : name;
}

export function quotedState(message: InboxMessage): QuotedState {
  if (message.replyToMessageId) return 'resolved';
  if (message.replyToExternalId) return 'unresolved';
  return 'none';
}

/**
 * Is a voice note's content available to read?
 *
 * Always `false`. Nothing transcribes a stored audio message: the worker's
 * only audio-specific line is a filename extension.
 *
 * ★★ AND A DEEPGRAM CLIENT DOES EXIST — IT IS THE WRONG ONE.
 * This note used to say *"the Deepgram credential exists without a client"*,
 * and that stopped being true. `services/voice-copilot/src/stt/`
 * instantiates `@deepgram/sdk` with `LiveTranscriptionEvents`: **streaming
 * STT for a phone call in progress**, which is screens 05d and 05e. A
 * WhatsApp voice note is a finished file on a URL, and Deepgram's prerecorded
 * API is called from nowhere in this repository.
 *
 * Stated carefully on purpose. A reader who greps for a Deepgram client finds
 * one, concludes the comment is stale, and wires the live provider to a
 * stored file — a different API and a different failure. **The conclusion did
 * not change; the reason for it did, and a stale reason is how a true note
 * gets overturned.**
 *
 * A function rather than a constant so the stream says *"a voice note — we
 * can't read it out for you"* from one place, and so the day a transcriber
 * exists there is one thing to change.
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
  // stop-ai (3e7bae17): written with no name — nothing says who stopped it.
  'ai_stopped',
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

/* ── Reactions, inbound only, because outbound does not exist ────────────── */

/**
 * A customer's reaction, or `null`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THERE IS NO REACTION MODEL. THIS IS READ OUT OF AN UNSUPPORTED PAYLOAD.
 * ════════════════════════════════════════════════════════════════════════════
 * No table, no column, no handler. A WhatsApp reaction arrives as a type the
 * adapter does not model, so it becomes a text message whose body is the
 * literal string `"[reaction message]"` — which is what an agent sees today —
 * with the emoji and the target's id kept on `metadata.unsupported.raw`.
 *
 * So this is a derived reading of a payload nobody modelled, and it is worth
 * saying plainly: the day reactions get a model, this function is what
 * changes, and nothing above it should know the difference.
 *
 * **Inbound only is not a restraint here, it is the shape of the platform.**
 * `whatsAppOutboundAdapter` has no reaction send, so there is nothing a
 * picker could call. The absence Omer asked for is one the code already had.
 *
 * `removed` is a third state and Meta's own: a reaction that is taken back
 * arrives as the same message with `emoji: ""`. Read as "no reaction" it
 * would silently drop the event; read as a reaction it would print an empty
 * bubble.
 */
export type Reaction =
  | { readonly kind: 'added'; readonly emoji: string; readonly toExternalId: string | null }
  | { readonly kind: 'removed'; readonly toExternalId: string | null };

export function reactionOf(message: InboxMessage): Reaction | null {
  const unsupported = message.metadata?.unsupported;
  if (unsupported?.providerType !== 'reaction') return null;
  const reaction = unsupported.raw?.reaction;
  if (!reaction) return null;
  const toExternalId = reaction.message_id?.trim() || null;
  const emoji = reaction.emoji ?? '';
  return emoji === '' ? { kind: 'removed', toExternalId } : { kind: 'added', emoji, toExternalId };
}

/**
 * The provider's name for a message we could not be given properly, or null.
 *
 * Everything the adapter cannot model lands as `[<providerType> message]` in
 * the body — `[revoke message]`, `[edit message]`, `[unsupported message]`.
 * An agent reading a bracketed token has no idea whether that is the
 * customer's text or ours.
 *
 * Naming the type is all this does. It does not say what happened, because
 * for every type except `reaction` we do not know.
 */
export function unsupportedType(message: InboxMessage): string | null {
  const providerType = message.metadata?.unsupported?.providerType?.trim();
  return providerType ? providerType : null;
}

/** Our id for the message a reaction points at, if it is on this page. */
export function resolveExternal(
  externalId: string | null,
  messages: readonly InboxMessage[],
): InboxMessage | null {
  if (!externalId) return null;
  return messages.find((m) => m.externalMessageId === externalId) ?? null;
}

/* ── Who a conversation can be handed to ─────────────────────────────────── */

/**
 * A colleague, from `GET /api/agents`.
 *
 * `looseObject` because the route sends a good deal more — departments,
 * counts, phone — and none of it is wanted here. A strict object would strip
 * silently and a required field we do not need would fail the whole read.
 */
export const colleagueSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullish(),
  email: z.string().nullish(),
  /**
   * ★★ THE FILTER THE PLATFORM DOES NOT APPLY.
   *
   * `reassign` checks only that the user exists in the tenant, so a transfer
   * to a deactivated colleague SUCCEEDS — and leaves the conversation
   * assigned to somebody who cannot sign in, with no unassign to recover it.
   * Required, not defaulted: a route that stopped sending this must fail the
   * read rather than quietly treat everybody as available.
   */
  isActive: z.boolean(),
});
export type Colleague = z.infer<typeof colleagueSchema>;
export const colleagueListSchema = z.array(colleagueSchema);

/**
 * The people this viewer may hand a conversation to.
 *
 * Excludes themselves — "transfer to me" is what holding it already means —
 * and anybody deactivated. Named rather than displayed nameless: the route's
 * `name` is optional and a blank option in a select is a transfer to nobody
 * in particular.
 */
export function transferableTo(
  colleagues: readonly Colleague[],
  meId: string | null,
): readonly { readonly id: string; readonly name: string }[] {
  return colleagues
    .filter((c) => c.isActive && c.id !== meId)
    .map((c) => ({ id: c.id, name: (c.name ?? c.email ?? '').trim() }))
    .filter((c) => c.name !== '');
}

/**
 * `GET /api/agents/settings/auto-greeting`.
 *
 * `template` is required and `""` is a real answer — the route writes
 * `(await readDurableSetting(...)) || ""`, so "no greeting configured" and
 * "a greeting configured" are the same field with different contents. A
 * default here would turn a route that stopped sending it into a confident
 * "nothing will be sent", which is the one thing the screen must not say
 * without knowing.
 */
export const autoGreetingSchema = z.object({ template: z.string() });
