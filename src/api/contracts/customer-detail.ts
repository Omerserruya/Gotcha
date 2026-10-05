import { z } from 'zod';

/**
 * Screen 04b — one customer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREE READS, THREE DIFFERENT DOORS, AND NONE OF THEM IS KEYED ON A CUSTOMER
 * ════════════════════════════════════════════════════════════════════════════
 *   the timeline   `GET /api/identity/:id/timeline`        by CONTACT id
 *   the brief      `POST /api/customer-summary`            by CONVERSATION id
 *   the memory     `GET .../customer-context?externalId=`  by PHONE
 *
 * All three describe the same person. Only one takes the id the list hands
 * us, and the other two are reached from what the first returns. That is why
 * the loader is ordered rather than parallel.
 */

/* ── The timeline ────────────────────────────────────────────────────────── */

/**
 * ★★ THE OLD SHAPE WAS NOT TRUNCATED — IT WAS THINNED, AND THAT IS WORSE.
 *
 * Until 2026-09-24 this route took 50 conversations and the newest **5
 * messages of each**, then merged and sorted them. So a 300-message thread
 * contributed five, and the output was a plausible, well-ordered stream
 * **with holes in the middle of every conversation**.
 *
 * A truncated history is visibly short. A thinned one looks complete and is
 * undetectable from the response — and the honest-limit sentence this screen
 * was built with would have named the WRONG limit, describing recent activity
 * over a stream that was missing the middle.
 *
 * ★ AND IT EXCLUDED IMPORTED HISTORY ENTIRELY. `applyLiveByDefault`
 * (`packages/shared/src/lib/prisma.ts:243`) injects `origin: "LIVE"` into any
 * bulk read that does not mention origin, and this route never did. For any
 * customer whose WhatsApp history was imported, the timeline showed none of
 * it — a long-standing customer rendered as brand new, confidently, with no
 * marker.
 *
 * ── THE STANDING RULE FOR THIS AREA ──
 * One guard produces both failures, and it will empty the
 * `evidenceConversationIds` link target too. **Anything reading a customer's
 * past must decide about origin explicitly**, and a screen that has not
 * thought about it should be assumed to be showing a truncated life.
 */

/** Where a message came from. `null` on rows written before the column. */
export const MESSAGE_ORIGINS = ['LIVE', 'HISTORICAL_IMPORT'] as const;
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

export const TIMELINE_EVENT_TYPES = ['message', 'handover', 'ai_action'] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const timelineEventSchema = z.object({
  /**
   * Three kinds now, where there was one. The design asks for five —
   * conversations, orders, returns, AI actions and notes — and `coverage`
   * below says what became of the other two rather than leaving the stream
   * to imply they never happened.
   */
  type: z.enum(TIMELINE_EVENT_TYPES),
  /** On every event now; the cursor is built from it. */
  id: z.string().default(''),
  /** Null on rows whose conversation could not be resolved. */
  channel: z.string().nullable().default(null),
  conversationId: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).nullable().default(null),
  /**
   * ⚠ NULL ON HANDOVERS AND AI ACTIONS, AND MUST NOT BE FALLEN BACK TO.
   *
   * Backend deliberately did not compose summary sentences into this field,
   * and the reason is worth copying: **a sentence they compose is not data,
   * and in this field it would be indistinguishable from a real message
   * body.** The legacy `CustomerTimeline.tsx` renders `body ?? "(no body)"`,
   * so those events read as empty messages there.
   *
   * Render a handover from `handover` and an AI action from `action`.
   */
  body: z.string().nullable().default(null),
  createdAt: z.string(),
  /**
   * ★ IMPORTED IS NOT THE SAME AS OBSERVED.
   *
   * An imported message is something we were TOLD about, not something we
   * watched happen. The screen labels it, because a merchant reading a
   * history has a right to know which parts the product witnessed.
   */
  origin: z.enum(MESSAGE_ORIGINS).nullable().default(null),
  /** Present on `handover` events. Who took the conversation, and why. */
  handover: z
    .object({
      from: z.string().nullable().default(null),
      to: z.string(),
      actorUserId: z.string().nullable().default(null),
      reason: z.string().nullable().default(null),
    })
    .nullish()
    .default(null),
  /** Present on `ai_action` events. What the AI did and whether it worked. */
  action: z
    .object({
      tool: z.string(),
      success: z.boolean().default(false),
      triggeredBy: z.string().nullable().default(null),
      durationMs: z.number().nullable().default(null),
      approvedBy: z.string().nullable().default(null),
    })
    .nullish()
    .default(null),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

/**
 * ★★ WHAT THE STREAM COVERS — INCLUDING WHERE IT IS AVAILABLE AND STILL
 * INCOMPLETE.
 *
 * `available: true` is not the same as complete. `ai_action` carries a
 * `detail` saying *"ToolExecution records catalog HTTP tools only. An action
 * taken through an adapter, such as a Shopify refund, is not recorded
 * here."*
 *
 * So a merchant reading the AI-actions stream sees a plausible, complete
 * list that omits a whole class of action — Backend's own comment says the
 * gap is invisible from the data. A screen that renders the events and drops
 * the detail is the calm wrong value with the explanation deleted.
 */
export const coverageEntrySchema = z.object({
  available: z.boolean().default(false),
  reason: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
});
export type CoverageEntry = z.infer<typeof coverageEntrySchema>;

export const coverageSchema = z.record(z.string(), coverageEntrySchema).default({});
export type TimelineCoverage = z.infer<typeof coverageSchema>;

/**
 * Everything the stream cannot fully tell you, in one list.
 *
 * Both kinds together, because a merchant does not care which is which: a
 * source that is absent and a source that is present-but-partial are equally
 * reasons not to read this stream as the whole story.
 */
export function coverageCaveats(
  coverage: TimelineCoverage,
): readonly { readonly type: string; readonly detail: string }[] {
  return Object.entries(coverage)
    .filter(([, entry]) => !entry.available || entry.detail)
    .map(([type, entry]) => ({ type, detail: entry.detail ?? '' }))
    .filter((c) => c.detail !== '');
}

export const timelineSchema = z.object({
  /**
   * The EFFECTIVE contact. The route follows `mergedIntoId`, so a person
   * opened by a merged-away id resolves to the survivor — and the name shown
   * must be this one, not the one the list held.
   */
  contact: z
    .object({
      id: z.string(),
      displayName: z.string().nullable().default(null),
      externalId: z.string().default(''),
      channel: z.string().default(''),
      /** When the contact was made — 04b's "with you since". */
      createdAt: z.string().nullable().catch(null).default(null),
    })
    .nullable()
    .default(null),
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ EVERY CHANNEL THIS PERSON USES — A PROJECTION, NOT A ROW DUMP
   * ════════════════════════════════════════════════════════════════════════
   * Five named fields per handle, with a `source` discriminator:
   *
   *   linked   a live sibling contact, from the `personId` walk
   *   merged   a preserved alias from a prior merge
   *
   * A handle that is both appears once and the live row wins, because it
   * carries a `contactId` the alias cannot.
   *
   * ── THIS REPLACED A `metadata.aliases` PARSE, AND THE REASON MATTERS ──
   * We read the handles out of the contact's raw `metadata` because the
   * route sent the whole row. The obvious fix — "return the siblings you
   * already compute" — would have been **worse than what it replaced**:
   * `findSiblingContacts` selects no columns, so each sibling arrives
   * carrying its own `metadata` blob, and returning them raw would ship the
   * customer's phone number **once per linked channel instead of once.**
   *
   * A five-field projection cannot do that. `metadata` is no longer read
   * here at all, which is what lets the route stop sending it.
   *
   * ── REQUIRED, NOT DEFAULTED ──
   * Present on every response including empty ones, so absence means the
   * service is older than this contract. That fails the parse loudly rather
   * than rendering an empty channel list, which would say "she uses one
   * channel" about somebody who uses four.
   */
  identityChannels: z.array(
    z.object({
      contactId: z.string().nullable().default(null),
      channel: z.string(),
      externalId: z.string(),
      displayName: z.string().nullable().default(null),
      source: z.enum(['linked', 'merged']),
    }),
  ),
  events: z.array(timelineEventSchema).default([]),
  /** One cursor over the person's events. `limit` defaults to 50, caps at 200. */
  page: z
    .object({
      limit: z.number().default(50),
      /** Which sources this response actually used. */
      types: z.array(z.string()).default([]),
      nextCursor: z.string().nullable().default(null),
      hasMore: z.boolean().default(false),
    })
    .default({ limit: 50, types: [], nextCursor: null, hasMore: false }),
  coverage: coverageSchema,
  /**
   * The REAL counts, which is what lets the screen say "50 of 1,284" rather
   * than implying it holds everything.
   *
   * `conversationScanTruncated` is set when the 500-conversation `IN` cap
   * bit. A bounded read that discloses its bound is fine; one that quietly
   * drops the oldest threads is the defect this whole block is about.
   */
  totals: z
    .object({
      conversations: z.number().default(0),
      messages: z.number().default(0),
      handovers: z.number().default(0),
      aiActions: z.number().default(0),
      conversationScanTruncated: z.boolean().default(false),
    })
    .default({
      conversations: 0,
      messages: 0,
      handovers: 0,
      aiActions: 0,
      conversationScanTruncated: false,
    }),
});
export type CustomerTimeline = z.infer<typeof timelineSchema>;

/** Distinct conversations represented in the page we were served. */
export function conversationsIn(events: readonly TimelineEvent[]): readonly string[] {
  return Array.from(new Set(events.map((e) => e.conversationId)));
}

/**
 * How many of this person's messages are on screen, out of how many exist.
 *
 * Both numbers, always. "Showing 50" is the sentence that made the old shape
 * survivable; "50 of 1,284" is the one that is true.
 */
export function shownOfTotal(timeline: CustomerTimeline): {
  readonly shown: number;
  readonly total: number;
} {
  /*
   * Every kind the response actually used, not just messages. Counting only
   * messages against a stream that now contains three kinds would report
   * "50 of 1,284" over a list whose other entries are uncounted.
   */
  const { messages, handovers, aiActions } = timeline.totals;
  const used = new Set(timeline.page.types);
  const total =
    (used.size === 0 || used.has('message') ? messages : 0) +
    (used.has('handover') ? handovers : 0) +
    (used.has('ai_action') ? aiActions : 0);
  return { shown: timeline.events.length, total };
}

/** Are we looking at part of it? Trust the server's flag over arithmetic. */
export function isPartialHistory(timeline: CustomerTimeline): boolean {
  return timeline.page.hasMore || timeline.events.length < shownOfTotal(timeline).total;
}

/** Events we were told about rather than watched happen. */
export function importedEvents(events: readonly TimelineEvent[]): readonly TimelineEvent[] {
  return events.filter((e) => e.origin === 'HISTORICAL_IMPORT');
}

/**
 * The most recent conversation, which is the KEY TO THE BRIEF and to notes.
 *
 * `POST /api/customer-summary` and the CRM panel both require a
 * `conversationId`. A customer with no conversations has neither, and that
 * is a fact about them rather than a failure to report.
 */
export function newestConversationId(events: readonly TimelineEvent[]): string | null {
  let best: TimelineEvent | null = null;
  for (const e of events) if (!best || e.createdAt > best.createdAt) best = e;
  return best?.conversationId ?? null;
}

/* ── The brief ───────────────────────────────────────────────────────────── */

/**
 * The written character summary — 04b's opening, and the one place the
 * design uses serif italic.
 *
 * Persisted in `customer_briefs` and rewritten by the post-chat subscriber
 * and the voice-postcall worker at conversation close, which is exactly the
 * design's *"regenerated on material change"*. This screen only ever READS
 * it: `refresh` would make a live model call on page load.
 */
export const briefSchema = z.object({
  ok: z.boolean().default(false),
  summary: z.string().nullable().default(null),
  signals: z.array(z.string()).default([]),
  generated_at: z.string().nullable().default(null),
  cached: z.boolean().default(false),
  meta: z
    .object({
      conversation_count: z.number().nullable().default(null),
      channels: z.array(z.string()).default([]),
      tone: z.string().nullable().default(null),
      mood: z.string().nullable().default(null),
      recommended_behaviors: z.array(z.string()).default([]),
      /**
       * ★ `no_conversations` COMES BACK AS A SUCCESS WITH A CANNED SUMMARY.
       *
       * The route answers `ok: true` and a literal string — "New customer
       * with no recorded prior interactions." — rather than an error or a
       * null. That is the right call on their side: a contact with no
       * history is an ordinary state, not a failure.
       *
       * But it is NOT a written character study, and rendering it in the
       * serif italic this screen reserves for one would present a constant
       * as though a model had read this person's history and concluded it.
       * `hasBrief` checks this field for exactly that reason.
       */
      reason: z.string().nullable().default(null),
    })
    .default({
      conversation_count: null,
      channels: [],
      tone: null,
      mood: null,
      recommended_behaviors: [],
      reason: null,
    }),
});
export type CustomerBrief = z.infer<typeof briefSchema>;

/**
 * Is there a brief worth rendering?
 *
 * `ok: true` with a null summary is a real answer — the row exists and the
 * prose has not been written — and it must not render as an empty italic
 * paragraph, which reads as a summary that says nothing about them.
 */
export function hasBrief(brief: CustomerBrief | null): boolean {
  // ★ A canned "new customer" string is not a character study. See `reason`.
  if (brief?.meta.reason === 'no_conversations') return false;
  return !!brief?.summary?.trim();
}

/**
 * Has this person never written to us at all?
 *
 * A real, ordinary state — somebody imported from a CRM who has never sent a
 * message — and NOT an edge case. Four of this page's sections are then
 * unreachable rather than empty, and the page has to say which.
 *
 * Read from the brief's own `reason` rather than inferred from an empty
 * timeline: the timeline can also be empty because its read failed, and
 * those must not render the same sentence.
 */
export function hasNeverWritten(brief: CustomerBrief | null): boolean {
  return brief?.meta.reason === 'no_conversations';
}

/* ── What GOTCHA remembers ───────────────────────────────────────────────── */

/**
 * ★ BLOCK-LEVEL PROVENANCE, NOT PER-FACT TRACEABILITY.
 *
 * `CustomerHistoricalMemory.facts` is stored as
 * `[{ text, category, confidence, evidenceConversationIds[], firstSeenAt,
 * lastSeenAt }]` — and `evidenceConversationIds` is the exact thing 04b asks
 * for: *"each traceable to where it was learned"*.
 *
 * It reached no route when this screen was built, and Backend has since
 * added it. So the ids are here and they are real.
 *
 * ★★ AND THE SCREEN STILL DRAWS NO LINK, ON PURPOSE.
 *
 * Those conversations carry `origin: "HISTORICAL_IMPORT"`, and
 * `applyLiveByDefault` injects `origin: "LIVE"` into bulk reads — **so a read
 * that does not name an origin returns ZERO ROWS.** A link that looks
 * followable would open an empty conversation.
 *
 * That is the exact failure the block-level statement was chosen to avoid,
 * arriving from the other direction: not a missing field, but a present one
 * whose destination is empty unless whatever serves it passes
 * `withHistoricalRecords`. Nobody here has loaded one and watched messages
 * come back, so the link is not drawn. A marker that resolves to nothing is
 * worse than an honest statement that the trace exists and is not yet
 * followable.
 *
 * The model's own comment is worth keeping in view — it stores durable
 * observations only, because *"'is waiting for a package' was true for a
 * week in March and would be a lie the moment it is read back"*.
 */
export const memoryFactSchema = z.object({
  text: z.string(),
  category: z.string().nullable().default(null),
  confidence: z.string().nullable().default(null),
  /**
   * ★ NOW RETURNED — AND DECLARED HERE OR IT IS STRIPPED.
   *
   * Backend added it after this screen reported it missing. Third field
   * today that had to be NAMED to arrive, after `source` and `taxed`: a
   * strict `z.object` discards what the consumer never asked for, so a new
   * field is invisible until somebody writes it down.
   *
   * Real `Conversation.id` values — `identity.stage.ts:208-213` queries the
   * `Message` table by them, which is proof rather than inference. `[]` when
   * there are none; never absent.
   */
  evidenceConversationIds: z.array(z.string()).default([]),
});
export type MemoryFact = z.infer<typeof memoryFactSchema>;

export const memorySchema = z.object({
  context: z
    .object({
      summary: z.string().nullable().default(null),
      facts: z.array(memoryFactSchema).default([]),
      messageCount: z.number().nullable().default(null),
      /** e.g. `historical_whatsapp_import`. The block's provenance. */
      source: z.string().nullable().default(null),
      learnedAt: z.string().nullable().default(null),
      /**
       * ★ WHEN THE EVIDENCE WAS OBSERVED — AT BLOCK LEVEL, DELIBERATELY.
       *
       * `firstSeenAt` / `lastSeenAt` exist per fact and Backend refused to
       * return them there, because both come from `transcript[0]` and
       * `transcript[last]` of the whole conversation — so **every fact in a
       * row carries identical values.** Per fact they would read as "this
       * preference was first observed on 2 March", which the data cannot
       * support and which nothing in the shape would reveal.
       *
       * Worth copying as a rule: a field that is free to return is not
       * therefore honest to display.
       */
      evidenceWindow: z
        .object({
          from: z.string().nullable().default(null),
          to: z.string().nullable().default(null),
        })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
});
export type CustomerMemory = z.infer<typeof memorySchema>;

export function hasMemory(memory: CustomerMemory | null): boolean {
  return (memory?.context?.facts.length ?? 0) > 0 || !!memory?.context?.summary?.trim();
}

/* ── Notes, which live in the merchant's CRM ─────────────────────────────── */

/**
 * ★ "GOTCHA DOES NOT STORE NOTES" IS TRUE. "NOTES ARE NOT RECORDED" IS FALSE.
 *
 * This screen shipped saying notes were not recorded, on the strength of
 * `POST /conversations/:id/notes` being a demo stub that echoes and persists
 * nothing. The stub is real and so is the capability — it is somewhere else:
 * `crm-panel.ts:690` calls `adapter.createNote`, a real audited write, and
 * `recent_crm_notes` is already rendered in the legacy UI.
 *
 * So a note lives in the merchant's CRM, and the repair for not having notes
 * is one a merchant can actually perform: connect a CRM, and link this
 * contact to a record in it. Two different repairs, hence two sentences —
 * the 14d shape, which DOES apply here after all.
 *
 * ⚠ AND THERE IS NO AUTHOR. `CrmActivity` is
 * `{ id, kind, body, occurred_at, source_interaction_id }`. So 04f's *"notes
 * are attributed and dated"* is dated and anonymous on this path, and no
 * amount of screen work changes that — it is one of four things the CRM
 * shape cannot hold, alongside a visibility flag, an edit history and pending
 * AI suggestions.
 */
export const crmNoteSchema = z.object({
  id: z.string(),
  kind: z.enum(['note', 'task', 'call', 'email', 'meeting']).default('note'),
  body: z.string(),
  occurred_at: z.string().nullable().default(null),
});
export type CrmNote = z.infer<typeof crmNoteSchema>;

export const crmContextSchema = z.object({
  recent_crm_notes: z.array(crmNoteSchema).default([]),
  link_meta: z
    .object({ outcome: z.string().nullable().default(null) })
    .nullable()
    .default(null),
});
export type CrmContext = z.infer<typeof crmContextSchema>;

/**
 * Why notes cannot be written, or `null` when they can.
 *
 * The two 409s the write answers with, read back as the two states BEFORE
 * anybody presses anything — because a control that fails on click teaches a
 * merchant the page is broken rather than that their CRM is not connected.
 *
 *   no_crm        the adapter is a stub: nothing is connected
 *   no_link       a CRM exists, this contact is not linked to a record in it
 *
 * Two, not one. Sending somebody to connect a CRM they already have is the
 * 14d mistake, and it is worse here because the repair is on a different
 * screen from the one they would be sent to.
 */
export type NotesBlocker = 'no_crm' | 'no_link';

export function notesBlockedBy(context: CrmContext | null): NotesBlocker | null {
  if (context === null) return null;
  const outcome = context.link_meta?.outcome ?? null;
  if (outcome === 'no_crm_link' || outcome === 'not_found') return 'no_link';
  /*
   * `search_only` means the adapter cannot write — a read-only or stub
   * connector. Treated as "no CRM" because the repair is the same: connect
   * one that can take a note.
   */
  if (outcome === 'search_only' || outcome === null) return 'no_crm';
  return null;
}

/* ── The handles we can actually name ────────────────────────────────────── */

export interface ChannelHandle {
  readonly channel: string;
  readonly externalId: string;
}

/**
 * Every channel this person uses.
 *
 * ★ THE CAPTION CHANGED WITH THE DATA. This used to be "channels we've
 * joined up" — the contact's own handle plus whatever a prior merge left
 * behind — because live siblings were computed by the route and never
 * returned. `identityChannels` carries both kinds with a `source` saying
 * which, so the list is now complete and the screen can say so.
 *
 * Deduplication is the route's: a handle that is both linked and merged
 * arrives once, as the linked row.
 */
export function channelHandles(timeline: CustomerTimeline | null): readonly ChannelHandle[] {
  return (timeline?.identityChannels ?? [])
    .filter((c) => c.channel.trim() !== '' && c.externalId.trim() !== '')
    .map((c) => ({ channel: c.channel, externalId: c.externalId }));
}
