import { z } from 'zod';

import { CHANNEL_TYPES } from './channels';

/**
 * Screens 02 and 02b - the Inbox.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FOUR THINGS THE DESIGN DRAWS THAT HAVE NO DATA BEHIND THEM
 * ════════════════════════════════════════════════════════════════════════════
 * Recorded here rather than discovered per component, because each is a
 * visible element a reader will look for:
 *
 *   voice-note transcript   *"Read what she said"* - an inbound voice note is
 *                           stored as a file and nothing transcribes it. The
 *                           only audio-specific code in the worker is
 *                           `case "audio": return ".ogg"`, an extension for a
 *                           filename. **The Deepgram credential is present and
 *                           the client is not**, which is worth saying because
 *                           "we have the key" reads like "we have the feature"
 *   image understanding     *"GOTCHA saw damage in this photo"* - no vision
 *                           path anywhere, no `image_url` content parts
 *   cost per reply          *"Replace it now · costs ₪179"* - nothing prices an
 *                           action before proposing it. The only `estimatedCost`
 *                           in the platform is a broadcast's per-recipient send
 *                           cost, which is a different thing entirely
 *   reactions               no model. The design shows a React action; it is
 *                           left out rather than drawn disabled
 *
 * ── AND TWO THAT LOOK PRESENT AND ARE NOT ──
 *
 * **Agent-unread is the row's `unread`, and nothing else.** The platform keeps
 * it per person (`ConversationReadState`, Backend 7b69c714); the list is to
 * send it on each row. `Message.readAt` is the CUSTOMER's receipt - the same
 * word for a different fact - and using it would show an agent's queue as
 * read because the customer read our reply. See `rowIsUnread`.
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
 * "no intent" - it means nobody recorded one.** The stream renders per
 * message with its own attributes, so adding the edge is an attribute and a
 * style rather than a restructure.
 */

/* ── The list ────────────────────────────────────────────────────────────── */

/**
 * ★ THREE STATES, NOT THE DESIGN'S FIVE.
 *
 * `ConversationStatus` is `OPEN | WAITING | CLOSED`. Waiting-on-customer and
 * waiting-on-business are one undifferentiated `WAITING`, and
 * waiting-on-an-external-system does not exist at all - so 02b's *"11
 * exchanges held - returns system down"* has no state to hang on.
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
   * row in the queue read "Someone"** - ten of ten in the capture, which read
   * as redaction by the security fixtures and was neither redaction nor
   * fixtures.
   *
   * The list route puts no `select` on the conversation, so every scalar on
   * the model arrives. The field was there the whole time under the name the
   * schema gives it.
   */
  customerName: z.string().nullable().default(null),
  /**
   * The handle this conversation arrived on - a phone number on WhatsApp, a
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
   * The person this conversation is with - Backend is adding it (asked
   * 2026-10-06, read-only, merged → target). Named now so it is not stripped
   * the day it arrives; `null` until then, and the wall says "-" with why.
   */
  contactId: z.string().min(1).nullable().catch(null).default(null),
  /**
   * The last message the CUSTOMER could have seen, flattened by the route
   * from a `take: 1` - and excluding FAILED sends, deliberately: *"a failed
   * outbound is a message the customer never received"*, so previewing it
   * would make the row read as answered.
   */
  lastMessageBody: z.string().nullable().default(null),
  /**
   * The same last message's `messageType` (Backend 33e6216a), so the row can
   * say "Photo" where the body is the adapter's "[Image]". A free String on the
   * model, not an enum: any string is kept, and anything else - or an older
   * service that does not send it - is `null`, never a rejected row.
   */
  lastMessageType: z.string().nullable().catch(null).default(null),
  /**
   * ★★ WHO SPOKE LAST, WHICH IS NOT THE SAME AS "UNREAD" AND IS STILL USEFUL.
   *
   * Not unread: that is `unread` below, per person, and `Message.readAt` is
   * the customer's receipt. But the route projects this, and INBOUND-last is
   * a fact - **the customer spoke and nobody has answered** - which is the
   * thing the queue is actually for.
   *
   * It is not "you have not read this". Two people looking at the same queue
   * see the same value, and that is correct for what it claims.
   */
  lastMessageDirection: z.enum(['INBOUND', 'OUTBOUND']).nullable().default(null),
  /**
   * The response target's two other inputs (W2): which department's target
   * applies, and when the conversation started - the clock's start when no
   * message has a time. The list route sends every scalar; absent is null.
   */
  departmentId: z.string().nullable().default(null),
  createdAt: z.string().nullable().default(null),
  /**
   * Since when the customer has waited for a reply (Backend 558f64a5): the
   * FIRST customer message after our last reply; `null` when nothing came in
   * after it - or when the server could not work it out (it says nobody is
   * waiting rather than fail the list).
   *
   * ★ ABSENT IS NOT NULL. A server from before 558f64a5 does not send it, and
   *   the response target then keeps its older rule; `null` is an answer -
   *   no mark. So no `.default`: it would turn "not sent" into "not waiting".
   *   A value that is not a string reads as `null`.
   */
  waitingSince: z.string().nullable().optional().catch(null),
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ UNREAD FOR THE PERSON LOOKING - THE SERVER'S ANSWER, OR NOTHING
   * ════════════════════════════════════════════════════════════════════════
   * Per person: `ConversationReadState` (Backend 7b69c714) holds a manual
   * `markedUnread` and a `lastReadAt` for each viewer, and the list carries
   * the computed answer on every row (Backend 0190bd4e, building on
   * 2026-10-11 - so optional: dev may run the older image for a while).
   *
   * ★ A fresh tenant has no read-state rows, so every conversation with a
   *   customer message reads unread at first. That is true, not a defect.
   *
   * ⚠⚠ ABSENT IS "NOT SAID", AND IT DRAWS NO DOT. Never inferred here from
   *    `lastMessageDirection`, `lastMessageAt` or `Message.readAt`: a wrong
   *    dot is worse than none, because the person learns to ignore it.
   *    `.catch(undefined)` so a malformed value is the same "not said",
   *    never a rejected list.
   */
  unread: z.boolean().optional().catch(undefined),
  /**
   * How many of the customer's messages this person has not read - inbound,
   * not system, since their `lastReadAt` - capped at 99 by the route. Marked
   * unread by hand with nothing new is `unread: true, unreadCount: 0`. Like
   * WhatsApp Web, the row shows the number when there is one. Absent or
   * malformed is "not said", never 0.
   */
  unreadCount: z.number().int().nonnegative().optional().catch(undefined),
  /** When this person last opened it. Named so it is not stripped; nothing draws it yet. */
  lastReadAt: z.string().nullable().optional().catch(undefined),
  /**
   * What may be sent now (Backend 47e376a4, B7): the list rows and
   * `GET /api/conversations/:id` both carry it - and the open conversation
   * is parsed with THIS schema, so one field covers both. Read through
   * `replyWindowOf`, never directly.
   *
   * ★ ABSENT, NULL AND MALFORMED ARE ALL "FREE". The server fails open (an
   *   unreadable window is `null` and the send goes ahead), so the composer
   *   must not be stricter than the route that decides.
   */
  replyWindow: z
    .object({
      channel: z.string().nullish().catch(null),
      open: z.boolean().optional().catch(undefined),
      closesAt: z.string().nullish().catch(null),
      /** A free string here: an unknown mode is "free", never a rejected row. */
      mode: z.string().optional().catch(undefined),
    })
    .nullish()
    .catch(null),
});
export type ConversationRow = z.infer<typeof conversationRowSchema>;

/* ── The customer-service window (B7) ────────────────────────────────────── */

export type ReplyMode = 'free' | 'template_only' | 'closed';

/**
 * The window as the composer acts on it. `template_only`: WhatsApp past 24h,
 * only an approved template. `closed`: Instagram/Messenger past 24h, nothing.
 * Anything else, or nothing, is `free` - the server fails open.
 */
export function replyWindowOf(row: Pick<ConversationRow, 'replyWindow'>): {
  readonly mode: ReplyMode;
  /** When free text stops being allowed; `null` when unknown or not windowed. */
  readonly closesAt: string | null;
} {
  const window = row.replyWindow;
  if (!window) return { mode: 'free', closesAt: null };
  const mode = window.mode === 'template_only' || window.mode === 'closed' ? window.mode : 'free';
  return { mode, closesAt: mode === 'free' ? (window.closesAt ?? null) : null };
}

/**
 * One approved template of this conversation's WhatsApp number -
 * `GET /api/conversations/:id/reply-templates` (Backend 47e376a4). `[]` when
 * the channel is not WhatsApp. Only the fields the picker reads are named.
 */
export const replyTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string().nullish().catch(null).default(null),
  body: z
    .string()
    .nullish()
    .transform((body) => body ?? ''),
  /** `TEXT` is the only header whose content the route sends. */
  headerType: z.string().nullish().catch(null).default(null),
  headerContent: z.string().nullish().catch(null).default(null),
  footer: z.string().nullish().catch(null).default(null),
  buttons: z
    .array(z.object({ text: z.string().nullish().catch(null).default(null) }))
    .catch([])
    .default([]),
  /** What the agent fills in, in order: `{{1}}` or `{{name}}`, and its sample. */
  placeholders: z
    .array(z.object({ key: z.string(), sample: z.string().nullish().catch(null).default(null) }))
    .catch([])
    .default([]),
});
export type ReplyTemplate = z.infer<typeof replyTemplateSchema>;
export const replyTemplateListSchema = z.array(replyTemplateSchema);

/** The template's text with its placeholders filled - the same `{{ key }}` rule as the route. */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (match, key: string) =>
    values[key] !== undefined && values[key] !== '' ? values[key] : match,
  );
}

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
 * `86110m`, `86409m` - and the wait column is the thing an agent triages on.
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
 * `SHOPIFY_LIVE_CHAT` and `WHATSAPP` on screen - a screaming-snake enum on the
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
   * accepts more is assignable where one accepting fewer is wanted - so callers
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
 * ★★ IS THIS ROW UNREAD FOR THE PERSON LOOKING? ONLY IF THE SERVER SAID SO.
 *
 * The one place the question is answered, so the row's mark, its weight and
 * the menu's choice of "Mark as read" cannot disagree. Unread when the
 * server sent `unread: true` or a positive `unreadCount`; absent fields (an
 * older list route) or `false` are not unread.
 *
 * ⚠ THE NEAREST FIELDS ARE TRAPS. `Message.readAt` is the customer's read
 *   receipt - reading it as "the agent has seen this" would mark a queue read
 *   because the CUSTOMER read our reply. And INBOUND-last is "nobody has
 *   answered", which two people see alike.
 */
export function rowIsUnread(row: UnreadFields): boolean {
  return unreadMark(row) !== null;
}

/**
 * What opening this row has to do about its read state: `unread` (it has a
 * mark), `read` (the server says `unread: false` - nothing to clear), or
 * `unknown` (no read fields at all - a row read by id carries none).
 */
export function openReadState(row: UnreadFields): 'unread' | 'read' | 'unknown' {
  if (rowIsUnread(row)) return 'unread';
  return row.unread === false ? 'read' : 'unknown';
}

type UnreadFields = { readonly unread?: boolean; readonly unreadCount?: number };

/**
 * What the row draws for it, from the server's fields alone:
 *
 *   unreadCount > 0               the count (WhatsApp Web's badge)
 *   unread === true, no count     a dot - unread, and nobody counted
 *     (or a count of 0: marked unread by hand, nothing new to count)
 *   anything else                 nothing
 *
 * ⚠ The open conversation draws neither, whatever this says - that rule is
 *   the list's, which knows which row is open.
 */
export type UnreadMark =
  { readonly kind: 'count'; readonly count: number } | { readonly kind: 'dot' };

export function unreadMark(row: UnreadFields): UnreadMark | null {
  if (row.unreadCount !== undefined && row.unreadCount > 0) {
    return { kind: 'count', count: row.unreadCount };
  }
  return row.unread === true ? { kind: 'dot' } : null;
}

/** Above this the badge says "99+", as WhatsApp does; the label keeps the number. */
export const UNREAD_BADGE_MAX = 99;

/**
 * How many conversations are unread for this person, per view
 * (`GET /api/conversations/unread-counts?views=…`, Backend 0190bd4e). The
 * route answers `{ data: { <view>: n } }`, which the client unwraps.
 *
 * ★ PER KEY, NEVER ALL OR NOTHING. A view the route does not count, or counts
 *   with something that is not a whole number, is simply absent - and an
 *   absent view draws no count, never a 0.
 */
export const unreadCountsSchema = z.record(z.string(), z.unknown());

export function parseUnreadCounts<View extends string>(
  body: Record<string, unknown>,
  views: readonly View[],
): Partial<Record<View, number>> {
  const counts: Partial<Record<View, number>> = {};
  for (const view of views) {
    const value = body[view];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) counts[view] = value;
  }
  return counts;
}

/**
 * How many conversations each view holds, from the same answer: Backend adds
 * `totals: { <view>: n }` beside the unread keys (each equal to that view's
 * own viewTotal), so the rail's sizes cost no second call.
 *
 * ★ ABSENT IS NOT 0. A backend that does not send `totals` yet, or sends
 *   something that is not an object, gives no total for any view - and a view
 *   whose total is not a whole non-negative number gives none for that view.
 *   The rail draws nothing for a missing total; a real 0 IS drawn, because it
 *   is the view's size.
 */
export function parseViewTotals<View extends string>(
  body: Record<string, unknown>,
  views: readonly View[],
): Partial<Record<View, number>> {
  const totals = body.totals;
  if (typeof totals !== 'object' || totals === null) return {};
  return parseUnreadCounts(totals as Record<string, unknown>, views);
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
/** A price as the store wrote it: a string or a number, else nothing. */
const priceOf = z
  .union([z.string(), z.number()])
  .nullish()
  .catch(null)
  .transform((v) => (v === null || v === undefined || v === '' ? null : String(v)));

/** One product card on a message (W9b): what the inbox needs of the widget's shape. */
export const commerceProductSchema = z.object({
  productId: z.coerce.string(),
  title: z.string(),
  imageUrl: z.string().nullish().catch(null),
  productUrl: z.string().nullish().catch(null),
  currency: z.string().nullish().catch(null),
  price: priceOf,
  compareAtPrice: priceOf,
  available: z.boolean().catch(true).default(true),
});
export type CommerceProduct = z.infer<typeof commerceProductSchema>;

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
  // Product cards (W9b): the web chat's WooCommerce ones, and the storefront's.
  'woo_product',
  'woo_product_carousel',
  'shopify_product',
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
 * timestamp either** - it looks exactly like one still on its way. So an
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
 * not recognise as **"on its way"** - the reassuring direction, on the one field
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
 *   · then `readAt`, then `deliveredAt` - a specific timestamp beats a column
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
  /** The sender's own name for a file - the download's label. */
  fileName: z.string().nullish().catch(null).default(null),
  createdAt: z.string(),
  /**
   * `PENDING · SENT · DELIVERED · READ · FAILED`. Read through `deliveryOf`,
   * never directly - see the note above `MESSAGE_STATUSES`.
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
   * reply. `replyToMessageId` is ours and **can fail to resolve** - the
   * quoted message may predate GOTCHA or have been deleted.
   *
   * Keeping the external id when the lookup misses is what lets the stream
   * say *"replying to an earlier message"* instead of showing nothing. The
   * `available: false` distinction, living in a message row.
   */
  replyToExternalId: z.string().nullable().default(null),
  replyToMessageId: z.string().nullable().default(null),
  /**
   * The provider's own id for this message. What a reaction points at - Meta
   * names the target by `wamid`, never by ours.
   */
  externalMessageId: z.string().nullable().default(null),
  /**
   * Who sent it, as the writer put it - and writers disagree. A human agent's
   * send writes their LOGIN EMAIL (`req.user.email`); an AI employee writes
   * its name; the platform writes "System", a storefront shopper "Shopper".
   * So it is shown only through `senderLabel`, which knows that.
   */
  senderName: z.string().nullish().default(null),
  /**
   * ★★ THE QUOTED MESSAGE, WHICH TRAVELLED WITH THE REPLY ALL ALONG.
   * `listByConversation` includes `replyTo { id, body, direction,
   * messageType, senderName, mediaUrl, fileName }` precisely so a quote from
   * last week can be drawn without being on this page - and this schema
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
   * the AI are all the same empty INBOUND row until this is read - and
   * rendered as messages they look like the customer sending nothing.
   *
   * Only the keys we draw are named. The rest are stripped, which is right
   * here: the unnamed ones are other events' payloads, and a divider that
   * printed an unknown field would be guessing at what happened.
   *
   * On the wire because `listByConversation` puts no `select` on the message
   * itself - it takes the whole row. Checked rather than assumed: the
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
      /**
       * `ai_bot_escalation`: why the AI handed over, as a code
       * (`budget_exceeded:tenant_day`, `customer_requested_human`, ...). Read
       * through `escalationReasonOf`, never printed. Its sibling
       * `escalationSummary` is the platform's English and is not named here.
       */
      escalationCase: z.string().optional().catch(undefined),
      /**
       * Why a send failed (Backend 47e376a4): `{ channel, phase, type,
       * message, retryable, at }`, written by the outgoing worker and the flow
       * executor. Only `type` is read - `TEMPLATE_REQUIRED` and
       * `REPLY_WINDOW_CLOSED` are said in words; `message` is the platform's
       * English and is never shown.
       */
      sendError: z
        .object({ type: z.string().optional().catch(undefined) })
        .optional()
        .catch(undefined),
      /** The attachment could not be fetched (WhatsApp media expires) - said, never blank. */
      mediaError: z.string().optional().catch(undefined),
      /**
       * What the attachment is (Backend 9e68eb03): written for inbound WhatsApp
       * media, Coexistence echoes and agent uploads - `byteSize` null when the
       * download failed, `originalName` null when nobody named the file. Rows
       * from before it have none. Each field falls to null on its own, and a
       * malformed object to nothing, so a bad value never costs the message.
       */
      media: z
        .object({
          mimeType: z.string().nullish().catch(null),
          byteSize: z.number().nonnegative().nullish().catch(null),
          originalName: z.string().nullish().catch(null),
        })
        .optional()
        .catch(undefined),
      /**
       * A shared location (Backend 11094abb): `{ latitude, longitude, name?,
       * address?, url }` - `url` the provider's https link, else Google Maps.
       * The body is `[Shared location: …]`, written for the AI, never shown.
       */
      location: z
        .object({
          latitude: z.coerce.number(),
          longitude: z.coerce.number(),
          name: z.string().nullish().catch(null),
          address: z.string().nullish().catch(null),
          url: z.string().nullish().catch(null),
        })
        .optional()
        .catch(undefined),
      /**
       * ★ W9b: the product cards sent (`woo_product`, `woo_product_carousel`,
       * `shopify_product`) - built server-side from the store's own answer,
       * the widget's shape. The body is their plain-text fallback. A product
       * that does not parse is left out; none left, the body is shown.
       */
      commerce: z
        .object({
          products: z
            .array(z.unknown())
            .catch([])
            .transform((rows) =>
              rows.flatMap((row) => {
                const product = commerceProductSchema.safeParse(row);
                return product.success ? [product.data] : [];
              }),
            ),
        })
        .optional()
        .catch(undefined),
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
 *   them apart the same way - `live-voice.service` counts humans by
 *   `senderName contains "@"`.
 *
 * Outbound only: an inbound sender is the customer, whom the header names.
 *
 * ★ An old row's generic "Bot" is GOTCHA (the 14" sweep: "Bot" ×6 on a
 *   Hebrew conversation), and so is "AI Bot" - the rerun found that one: 9
 *   rows Backend's approval-rejection path wrote (being fixed at the source;
 *   stored rows keep it). Exact names only, any case: "Bot Smith" is a name.
 *   GOTCHA is the brand in every language, so it needs no catalogue.
 */
export function senderLabel(message: {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly senderName?: string | null;
}): string | null {
  if (message.direction !== 'OUTBOUND') return null;
  const name = message.senderName?.trim() ?? '';
  if (/^(ai )?bot$/i.test(name)) return 'GOTCHA';
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
 * ★★ AND A DEEPGRAM CLIENT DOES EXIST - IT IS THE WRONG ONE.
 * This note used to say *"the Deepgram credential exists without a client"*,
 * and that stopped being true. `services/voice-copilot/src/stt/`
 * instantiates `@deepgram/sdk` with `LiveTranscriptionEvents`: **streaming
 * STT for a phone call in progress**, which is screens 05d and 05e. A
 * WhatsApp voice note is a finished file on a URL, and Deepgram's prerecorded
 * API is called from nowhere in this repository.
 *
 * Stated carefully on purpose. A reader who greps for a Deepgram client finds
 * one, concludes the comment is stale, and wires the live provider to a
 * stored file - a different API and a different failure. **The conclusion did
 * not change; the reason for it did, and a stale reason is how a true note
 * gets overturned.**
 *
 * A function rather than a constant so the stream says *"a voice note - we
 * can't read it out for you"* from one place, and so the day a transcriber
 * exists there is one thing to change.
 */
export function hasTranscript(_message: InboxMessage): false {
  return false;
}

/* ── Ordering, and what the column it depends on is worth ────────────────── */

/**
 * The queue, newest first - and the rows whose place we cannot determine.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS SPLIT IS PER PAGE, AND THE SERVER SORTS NULLS LAST
 * ════════════════════════════════════════════════════════════════════════════
 * `orderBy` is `{ lastMessageAt: { sort: "desc", nulls: "last" } }`, so every
 * undated row is **at the very end of the whole queue** - after every dated
 * one, on the last page.
 *
 * So on a tenant with more conversations than one page holds, this function
 * returns an empty `undated` on every page but the last, and the group
 * disappears. **It is a per-page view of a whole-queue fact**, and the
 * screen must say so rather than letting an empty group read as "none".
 *
 * Answering "how many conversations have no `lastMessageAt`" properly needs
 * a count of its own, which no endpoint offers. Until one does, the caption
 * carries the scope - see `ConversationList`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `lastMessageAt` IS A DENORMALISED CACHE MAINTAINED BY CONVENTION
 * ════════════════════════════════════════════════════════════════════════════
 * It is written at ten call sites, and **ten or more writers bypass
 * `message.service` entirely.** One conversation on dev has it null while
 * being open, not a test, and carrying two real messages - the sandbox
 * writer never sets it.
 *
 * So the column the queue sorts by is maintained by everybody remembering,
 * and a **stale** value has no symptom at all: a conversation whose newest
 * message arrived through a forgetful writer sinks down the list while
 * somebody waits, and the list looks entirely normal.
 *
 * We cannot detect staleness from here - a plausible-but-old timestamp is
 * indistinguishable from a correct one. What we CAN do is refuse to bury the
 * rows that admit they do not know.
 *
 * ── SO NULL GOES IN ITS OWN GROUP, NOT AT THE BOTTOM ──
 * Sorted naively, a null sinks to the floor of a recency-ordered list and is
 * never seen - which is the same defect as the offset-pagination skip, and
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
 * The system events the platform writes, each drawn as a divider in words.
 *
 * Every one is `messageType: "system"`, `direction: "INBOUND"` and
 * `body: ""`. The direction is the writer's, not a statement about who
 * acted - rendering them as inbound bubbles puts a colleague's action, or the
 * AI's, on the customer's side of the thread.
 *
 * The first five are `conversation.service.ts`'s. The rest were read off
 * their writers (2026-10-11): the AI handing over (`ai-bot.service.ts`), an
 * automation ending in a handoff (`flow-executor.service.ts`), a storefront
 * visitor asking for a person (`shopify-chat-public.ts`), the idle closer
 * (`idle-conversation.worker.ts`), a reply from the WhatsApp Business app
 * (`outbound-echo.service.ts`), the website-to-WhatsApp continuation
 * (`whatsapp-handoff-link.service.ts`) and an approved action that failed
 * (`approvals.ts`).
 *
 * Not here: `marketing_opt_in_confirmation` / `marketing_opt_out_confirmation`.
 * Those are real OUTBOUND texts sent to the customer that carry the event as
 * a tag - a message, and drawn as one.
 */
export const SYSTEM_EVENTS = [
  'agent_claimed',
  'agent_transferred',
  'department_transferred',
  'returned_to_ai',
  // stop-ai (3e7bae17): written with no name - nothing says who stopped it.
  'ai_stopped',
  'ai_bot_escalation',
  'flow_ended_handoff',
  'visitor_requested_human',
  'auto_closed',
  'whatsapp_app_takeover',
  'continued_on_whatsapp',
  'continued_from_website',
  'approval_execution_failed',
] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

/**
 * What this row records: a known event, `'other'` for a system row we have
 * no words for, or `null` for a message.
 *
 * ★★ A SYSTEM ROW IS NEVER A CUSTOMER BUBBLE (Omer, 2026-10-11). An unknown
 * event used to fall to "Something was sent here that we can't show yet" -
 * an empty bubble on the customer's side for something the platform did.
 * It is now a neutral divider ("System update"): it claims only that the
 * system wrote a row, which `messageType: "system"` is the proof of, and
 * names nothing it does not know.
 *
 * `department_transferred` is included although this product never offers a
 * department transfer: the platform writes it, other clients can cause it,
 * and a divider that skipped it would leave an unexplained gap in the thread
 * exactly where somebody needs to know the conversation moved.
 *
 * An unknown event on a row that is NOT `system` stays a message: that is
 * the shape of the marketing confirmations, text the customer received.
 */
export function systemEventOf(message: InboxMessage): SystemEvent | 'other' | null {
  const event = message.metadata?.systemEvent?.trim();
  if (event && (SYSTEM_EVENTS as readonly string[]).includes(event)) return event as SystemEvent;
  return message.messageType?.trim().toLowerCase() === 'system' ? 'other' : null;
}

/** Why the AI handed a conversation to the team, in words we have - or null. */
export type EscalationReason =
  | 'daily_budget'
  | 'budget'
  | 'customer_asked'
  | 'ai_paused'
  | 'ai_inactive'
  | 'ai_failed'
  | 'message_limit';

/**
 * `ai_bot_escalation`'s reason, from its code - never from
 * `escalationSummary`, which is the platform's English ("Token budget
 * exceeded (tenant_day): 1203/1000."). Codes read off their writers: the
 * budget's `budget_exceeded:<scope>` (only `tenant_day` exists), the
 * incoming worker's `agent_paused`, `customer_requested_human`,
 * `ai_service_failure`, `hard_message_ceiling`, `autonomous_message_cap`,
 * and the AI's `agent_inactive:<status>`. Anything else - `ai_decided`, a
 * free-text reason the model gave - is no reason line, not a guessed one.
 */
export function escalationReasonOf(message: InboxMessage): EscalationReason | null {
  const code = message.metadata?.escalationCase?.trim();
  if (!code) return null;
  if (code === 'budget_exceeded:tenant_day') return 'daily_budget';
  if (code.startsWith('budget_exceeded')) return 'budget';
  if (code.startsWith('agent_inactive')) return 'ai_inactive';
  const exact: Record<string, EscalationReason> = {
    customer_requested_human: 'customer_asked',
    agent_paused: 'ai_paused',
    ai_service_failure: 'ai_failed',
    hard_message_ceiling: 'message_limit',
    autonomous_message_cap: 'message_limit',
  };
  return Object.hasOwn(exact, code) ? exact[code]! : null;
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
 * literal string `"[reaction message]"` - which is what an agent sees today -
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
 * the body - `[revoke message]`, `[edit message]`, `[unsupported message]`.
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
 * `looseObject` because the route sends a good deal more - departments,
 * counts, phone - and none of it is wanted here. A strict object would strip
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
   * to a deactivated colleague SUCCEEDS - and leaves the conversation
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
 * Excludes themselves - "transfer to me" is what holding it already means -
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
 * `template` is required and `""` is a real answer - the route writes
 * `(await readDurableSetting(...)) || ""`, so "no greeting configured" and
 * "a greeting configured" are the same field with different contents. A
 * default here would turn a route that stopped sending it into a confident
 * "nothing will be sent", which is the one thing the screen must not say
 * without knowing.
 */
export const autoGreetingSchema = z.object({ template: z.string() });
