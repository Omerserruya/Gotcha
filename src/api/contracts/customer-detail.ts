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

export const timelineEventSchema = z.object({
  /**
   * `identity.ts` emits `type: "message"` and nothing else. The design asks
   * for one stream mixing conversations, orders, returns, AI actions and
   * notes; the route carries messages.
   *
   * Typed as the literal rather than a wider union, so a second kind fails
   * the parse here instead of rendering as a message body nobody questions.
   */
  type: z.literal('message'),
  channel: z.string(),
  conversationId: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
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
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

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
    })
    .nullable()
    .default(null),
  events: z.array(timelineEventSchema).default([]),
  /** One cursor over the person's messages. `limit` defaults to 50, caps at 200. */
  page: z
    .object({
      limit: z.number().default(50),
      nextCursor: z.string().nullable().default(null),
      hasMore: z.boolean().default(false),
    })
    .default({ limit: 50, nextCursor: null, hasMore: false }),
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
      conversationScanTruncated: z.boolean().default(false),
    })
    .default({ conversations: 0, messages: 0, conversationScanTruncated: false }),
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
  return { shown: timeline.events.length, total: timeline.totals.messages };
}

/** Are we looking at part of it? Trust the server's flag over arithmetic. */
export function isPartialHistory(timeline: CustomerTimeline): boolean {
  return timeline.page.hasMore || timeline.events.length < timeline.totals.messages;
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
    })
    .default({
      conversation_count: null,
      channels: [],
      tone: null,
      mood: null,
      recommended_behaviors: [],
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
  return !!brief?.summary?.trim();
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
