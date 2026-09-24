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
 * ★ THE CAPS, AND WHY THEY ARE EXPORTED RATHER THAN BURIED.
 *
 * `identity.ts:233,237` — the route takes 50 conversations and the newest 5
 * messages of each. So the "unified timeline" is **the last five messages of
 * the last fifty conversations**, with nothing in the payload saying so.
 *
 * A screen rendering that under the design's words — *"every channel in one
 * thread"*, *"her whole history"* — makes a claim of completeness the data
 * cannot support, and it is the calm wrong value at the scale of a whole
 * screen: nothing looks broken, the stream reads convincingly, and messages
 * six through n of every conversation are simply not there.
 *
 * They are constants here so the screen can say the number rather than
 * gesture at it, and so this comment is the one place either has to change.
 */
export const TIMELINE_CONVERSATION_CAP = 50;
export const TIMELINE_MESSAGES_PER_CONVERSATION = 5;

/**
 * ★ AND `type` HAS EXACTLY ONE MEMBER.
 *
 * `identity.ts:244` emits `type: "message" as const` and nothing else. The
 * design asks for one stream mixing conversations, orders, returns, AI
 * actions and notes; the route carries messages.
 *
 * Typed as the literal rather than a wider union, so the day a second kind
 * arrives the parse fails loudly here instead of the screen silently
 * rendering an unknown event as a message — the `roles.2.source` lesson,
 * applied in the direction where the narrow enum is correct because the
 * producer's own union is narrow.
 */
export const timelineEventSchema = z.object({
  type: z.literal('message'),
  channel: z.string(),
  conversationId: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  body: z.string().nullable().default(null),
  createdAt: z.string(),
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
});
export type CustomerTimeline = z.infer<typeof timelineSchema>;

/** Distinct conversations represented in the stream. */
export function conversationsIn(events: readonly TimelineEvent[]): readonly string[] {
  return Array.from(new Set(events.map((e) => e.conversationId)));
}

/**
 * Did we hit the conversation cap? Then there are older conversations that
 * are not here at all.
 *
 * `>=` rather than `===`: the route's `take` makes more impossible, and an
 * equality test would quietly stop working if the cap ever rose.
 */
export function moreConversationsExist(events: readonly TimelineEvent[]): boolean {
  return conversationsIn(events).length >= TIMELINE_CONVERSATION_CAP;
}

/**
 * Conversations that hit the per-conversation message cap, so we are showing
 * only their tail.
 *
 * A conversation with exactly five messages here either HAD five or had five
 * hundred — the payload cannot distinguish them, which is precisely why the
 * screen must not imply it can.
 */
export function truncatedConversations(events: readonly TimelineEvent[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.conversationId, (counts.get(e.conversationId) ?? 0) + 1);
  return Array.from(counts.entries())
    .filter(([, n]) => n >= TIMELINE_MESSAGES_PER_CONVERSATION)
    .map(([id]) => id);
}

/**
 * The most recent conversation, which is the KEY TO THE BRIEF.
 *
 * `POST /api/customer-summary` requires a `conversationId` and resolves the
 * person from it — the route's own words are *"persistent, customer-level
 * behavioural intelligence, not a per-conversation summary"*, reached
 * through a conversation-shaped door.
 *
 * So a customer with no conversations has no brief, and that is a fact about
 * them rather than a failure to report.
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
 * **It reaches no route.** The reachable endpoint projects each fact down to
 * `{ text, category, confidence }` (`historical-import.ts:540-543`), and the
 * field appears twice in the whole monorepo, both in the WRITER. The
 * endpoint that returns the row whole is keyed on an import-internal id we
 * cannot reach from a contact.
 *
 * So the schema carries what arrives, the screen states the set's source and
 * date, and it says plainly that a single fact cannot be traced yet. Not a
 * greyed link: a traceability marker that cannot be followed would be worse
 * than an honest block-level statement.
 *
 * The model's own comment is worth keeping in view — it stores durable
 * observations only, because *"'is waiting for a package' was true for a
 * week in March and would be a lie the moment it is read back"*.
 */
export const memoryFactSchema = z.object({
  text: z.string(),
  category: z.string().nullable().default(null),
  confidence: z.string().nullable().default(null),
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
    })
    .nullable()
    .default(null),
});
export type CustomerMemory = z.infer<typeof memorySchema>;

export function hasMemory(memory: CustomerMemory | null): boolean {
  return (memory?.context?.facts.length ?? 0) > 0 || !!memory?.context?.summary?.trim();
}
