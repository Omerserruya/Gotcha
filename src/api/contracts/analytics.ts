import { z } from 'zod';

/**
 * Analytics contracts.
 *
 * Shapes confirmed against the backend. Two things to carry in mind when
 * reading anything from here:
 *
 *   1. **These are enveloped.** `/api/analytics/*` answers `{ data: … }`,
 *      unlike `/api/auth/me` which answers bare. The transport unwraps either.
 *   2. **Freshness differs per endpoint.** `overview` and
 *      `channel-performance` query Postgres live; `dashboard`, `agents` and
 *      `daily` read Redis counters written by the event pipeline. Two figures
 *      from different sources can disagree on the same screen, so a surface
 *      that shows both should not imply they were measured together.
 */

/** Milliseconds, or null where the backend has nothing to average. */
const durationMs = z.number().nullable().optional();

/**
 * A percentage change, or null where there is no prior period to compare
 * against. The backend emits `null` from a guarded division rather than
 * omitting the key, so `.optional()` alone does not accept it.
 */
const percentDelta = z.number().nullable().optional();

/**
 * `GET /api/analytics/overview?from&to`.
 *
 * The AI/human split Home's metric strip is built on.
 *
 * `humanHandledCount` is derived as `total − aiHandled` rather than measured,
 * so it absorbs anything the pipeline failed to attribute. It is honest as a
 * headline and should not be used as evidence about a specific agent.
 */
export const analyticsOverviewSchema = z.looseObject({
  totalConversations: z.number().default(0),
  resolvedConversations: z.number().default(0),
  resolutionRate: z.number().default(0),
  avgResponseTimeMs: durationMs,
  avgResolutionTimeMs: durationMs,
  aiHandledCount: z.number().default(0),
  humanHandledCount: z.number().default(0),
  aiHandledPct: z.number().default(0),
  totalMessages: z.number().default(0),
  /**
   * Approvals still waiting on a person.
   *
   * Deliberately not filtered by the query's date range — an approval raised
   * last week that nobody has answered is still waiting today, and scoping it
   * to "today" would report zero on the morning it matters most.
   */
  pendingApprovalCount: z.number().default(0),
  /**
   * Change against the preceding period of equal length.
   *
   * `null` means the comparison could not be made - the prior period had a
   * zero denominator, which is the normal state for a tenant in its first
   * period. That is NOT the same as 0%, and must not be rendered as "no
   * change": there is no baseline to have changed from.
   */
  deltas: z
    .looseObject({
      totalConversationsPct: percentDelta,
      resolvedConversationsPct: percentDelta,
      totalMessagesPct: percentDelta,
    })
    .optional(),
  period: z.looseObject({ from: z.string(), to: z.string() }).optional(),
});

export type AnalyticsOverview = z.infer<typeof analyticsOverviewSchema>;

/** `GET /api/analytics/channel-performance?from&to`. */
export const channelPerformanceSchema = z.array(
  z.looseObject({
    channel: z.string(),
    conversationCount: z.number().default(0),
    messageCount: z.number().default(0),
    avgResolutionTimeMs: durationMs,
  }),
);

export type ChannelPerformance = z.infer<typeof channelPerformanceSchema>;

/**
 * `GET /api/analytics/queue`.
 *
 * Two scalars, not a list. The design's "Needs you now" wants a risk-ranked
 * set of rows with intent and wait time per conversation; this endpoint cannot
 * supply it. See docs/api-gaps.md — that section of Home is blocked on a
 * backend contract, not on frontend work.
 */
export const analyticsQueueSchema = z.looseObject({
  waiting: z.number().default(0),
  avgWaitTimeMs: durationMs,
});

export type AnalyticsQueue = z.infer<typeof analyticsQueueSchema>;

/**
 * `GET /api/analytics/queue/items?limit&cursor` — Home's ranked "needs you now".
 *
 * `data` sits beside `nextCursor` and `totalWaiting`, so requests use `raw`.
 *
 * The ranking is the server's and is never recomputed here. Two surfaces
 * ordering the same queue independently disagree the moment either changes,
 * and an operator who sees a different first row on Home than in the inbox
 * stops trusting both.
 */
export const QUEUE_URGENCIES = ['high', 'medium', 'low', 'none'] as const;
export type QueueUrgency = (typeof QUEUE_URGENCIES)[number];

/**
 * The intents the ranker weighs. Kept as a plain string in the contract: a new
 * intent on the backend must not fail the parse and blank the whole list, so
 * the UI falls back to a neutral label for one it does not recognise.
 */
export const CONVERSATION_INTENTS = [
  'FRUSTRATED',
  'COMPLAINT',
  'HIGH_INTENT',
  'REFUND',
  'SHIPPING_ISSUE',
  'RETURN',
  'ORDER_CHANGE',
  'PRODUCT_QUESTION',
  'WAITING_EXTERNAL',
  'OTHER',
] as const;
export type ConversationIntent = (typeof CONVERSATION_INTENTS)[number];

export const queueItemSchema = z.looseObject({
  conversationId: z.string(),
  customer: z.looseObject({
    /**
     * The channel identifier, because a conversation is not guaranteed a
     * contact record. `name` stays null rather than being filled with a phone
     * number dressed up as a name.
     */
    id: z.string(),
    name: z.string().nullable().optional(),
  }),
  /** The platform's ChannelType, uppercase, as every other endpoint returns. */
  channel: z.string(),
  preview: z.string().default(''),
  intent: z.string(),
  waitingSince: z.string(),
  urgency: z.enum(QUEUE_URGENCIES).catch('none'),
  /** 1-based, assigned by the server's ranker. */
  rank: z.number(),
});

export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueItemsSchema = z.looseObject({
  data: z.array(queueItemSchema),
  nextCursor: z.string().nullable().optional(),
  /** The full queue depth, not the page length. */
  totalWaiting: z.number().default(0),
});

export type QueueItems = z.infer<typeof queueItemsSchema>;

/**
 * `GET /api/analytics/activity?limit&cursor` — what GOTCHA has been doing.
 *
 * Merges completed tool executions with approvals still waiting on a person,
 * so the pending refund appears beside the completed ones — that is the only
 * entry an operator can still change the outcome of.
 *
 * The server emits `kind` + `values` and never a rendered sentence: this
 * product runs in Hebrew as often as English, and a pre-composed English line
 * cannot be translated. The wording, the clause order and the text direction
 * are the client's.
 *
 * `data` sits beside `nextCursor`, so requests use `raw`. The cursor is a
 * timestamp — the merged stream has no single id sequence to seek on.
 */
export const ACTIVITY_OUTCOMES = ['completed', 'failed', 'awaiting_approval'] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

export const ACTIVITY_SUBJECT_TYPES = [
  'order',
  'customer',
  'contact',
  'lead',
  'deal',
  'conversation',
  'none',
] as const;

export const activityEventSchema = z.looseObject({
  id: z.string(),
  at: z.string(),
  outcome: z.enum(ACTIVITY_OUTCOMES).catch('completed'),
  /**
   * `<noun>.<outcome>`, e.g. `refund.completed`. An unmapped tool falls back to
   * its own slug as the noun, which reads plainly and is honest about not
   * having been mapped — so this cannot be a closed enum.
   */
  kind: z.string(),
  values: z.record(z.string(), z.unknown()).default({}),
  subject: z.looseObject({
    type: z.enum(ACTIVITY_SUBJECT_TYPES).catch('none'),
    /** The identifier a human recognises — an order NUMBER, not an id. */
    id: z.string().nullable().optional(),
  }),
  conversationId: z.string().nullable().optional(),
});

export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityFeedSchema = z.looseObject({
  data: z.array(activityEventSchema),
  nextCursor: z.string().nullable().optional(),
});

export type ActivityFeed = z.infer<typeof activityFeedSchema>;

/**
 * `GET /api/analytics/time-saved?from&to`.
 *
 * `basis` is not decoration and must not be dropped when this is rendered.
 * This figure sits on the product's first screen and is the easiest number in
 * the product to inflate, so it ships with everything needed to reconstruct
 * it. `source` says whether it came from this tenant's own history or the
 * platform default — the screen must not imply the precision of the first when
 * it is showing the second.
 */
export const timeSavedSchema = z.looseObject({
  secondsSaved: z.number().default(0),
  basis: z
    .looseObject({
      conversationsHandled: z.number().default(0),
      secondsPerConversation: z.number().default(0),
      source: z.enum(['measured', 'platform_default']).catch('platform_default'),
      sampleSize: z.number().default(0),
      method: z.string(),
      period: z.looseObject({ from: z.string(), to: z.string() }).optional(),
    })
    .optional(),
});

export type TimeSaved = z.infer<typeof timeSavedSchema>;

/**
 * `GET /api/analytics/in-flight` — the dark card's opening line.
 *
 * Present tense, unlike `activity`, which is what happened in order. Tools are
 * grouped by SUBJECT rather than by tool name: the sentence says "checking 4
 * orders", not "4 executions of get_order".
 */
export const inFlightSchema = z.looseObject({
  /** Conversations the AI is mid-way through right now. */
  conversationsHandling: z.number().default(0),
  toolsRunning: z
    .array(z.looseObject({ subject: z.string(), count: z.number().default(0) }))
    .default([]),
  /** Must agree with `overview.pendingApprovalCount`. */
  awaitingApproval: z.number().default(0),
});

export type InFlight = z.infer<typeof inFlightSchema>;

/**
 * `GET /api/usage/allowance` — conversation headroom this period.
 *
 * `limit` is null on an uncapped plan and on a tenant with no plan at all: the
 * honest answer there is that there is no limit to report, not a limit of zero.
 *
 * `projectedExhaustionAt` is the server's, deliberately. A client run-rate
 * would put a different date on Home than the one billing acts on, and it is
 * null rather than guessed when the period has barely started or the pace
 * finishes inside the allowance.
 */
export const usageAllowanceSchema = z.looseObject({
  used: z.number().default(0),
  limit: z.number().nullable().optional(),
  periodStart: z.string(),
  periodEnd: z.string(),
  projectedExhaustionAt: z.string().nullable().optional(),
});

export type UsageAllowance = z.infer<typeof usageAllowanceSchema>;

/**
 * `GET /api/analytics/insights` — "Worth knowing".
 *
 * Now `kind` + `values`, not prose. The earlier shape returned composed English
 * sentences with the numbers already interpolated, which could not be rendered
 * on a Hebrew screen at all.
 *
 * `id` is stable and unchanged across that reshape, so dismissals did not reset.
 */
export const INSIGHT_IMPACTS = ['high', 'medium', 'low'] as const;

export const insightSchema = z.looseObject({
  id: z.string(),
  /** `<noun>.<observation>`, e.g. `intent.automatable`. */
  kind: z.string(),
  values: z.record(z.string(), z.unknown()).default({}),
  impact: z.enum(INSIGHT_IMPACTS).catch('medium'),
  /** False means there is nothing to do about it, only to know it. */
  actionable: z.boolean().default(false),
});

export type Insight = z.infer<typeof insightSchema>;

export const insightsSchema = z.array(insightSchema);

/**
 * `GET /api/analytics/quiet-day?limit` — "Worth an hour, while it is quiet".
 *
 * Merged and ranked server-side, for the same reason the queue is: two
 * surfaces ordering the same list disagree the moment either changes.
 *
 * `effect` is the important field. Three sources REMOVE future work — answer
 * the question, resolve the conflict, stock the product, and those
 * conversations stop arriving. Dormant customers are the opposite: acting on
 * them creates conversations, which is the entire point of them. Ranking an
 * opportunity by how much work it removes would put the most valuable item
 * last for being valuable, so the two are not ordered against each other and
 * `wouldRemoveConversations` is null on an opportunity rather than a number
 * meaning something else.
 *
 * `sources` says which inputs the ranking actually saw. A list that silently
 * omits one reads as "there is nothing there", which is a different claim.
 */
export const QUIET_DAY_EFFECTS = ['removes_work', 'creates_opportunity'] as const;
export type QuietDayEffect = (typeof QUIET_DAY_EFFECTS)[number];

export const quietDayItemSchema = z.looseObject({
  id: z.string(),
  source: z.string(),
  effect: z.enum(QUIET_DAY_EFFECTS).catch('removes_work'),
  /** Null on an opportunity. Absent is not zero. */
  wouldRemoveConversations: z.number().nullable().optional(),
  /** The counts the estimate was built from, so it can be argued with. */
  basis: z.record(z.string(), z.number()).default({}),
  /** `<source>.<detail>`. Codes and figures only; the sentence is ours. */
  kind: z.string(),
  values: z.record(z.string(), z.unknown()).default({}),
  rank: z.number(),
});

export type QuietDayItem = z.infer<typeof quietDayItemSchema>;

export const quietDaySchema = z.looseObject({
  weekKey: z.string().optional(),
  sources: z.record(z.string(), z.boolean()).default({}),
  data: z.array(quietDayItemSchema).default([]),
});

export type QuietDay = z.infer<typeof quietDaySchema>;

/* ── Screen 06's metric strip ────────────────────────────────────────────── */

/**
 * A headline figure, with its comparison only where one genuinely exists.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THREE OF THE DESIGN'S FIVE METRICS HAVE NO COMPARISON, AND ONE PAIRING
 *    IS A TRAP
 * ════════════════════════════════════════════════════════════════════════════
 * The design draws five: conversations +12%, handled-without-you +4, first
 * reply −18s, resolved flat, time saved +6h. `deltas` carries exactly three
 * percentages — `totalConversationsPct`, `resolvedConversationsPct`,
 * `totalMessagesPct` — and nothing else.
 *
 * ── THE TRAP ──
 * `resolvedConversationsPct` is the change in the **count** of resolved
 * conversations. The design's "Resolved · 94%" is the **rate**. Putting that
 * delta beside that figure prints a count's movement under a percentage, and
 * they can move in opposite directions: a week with twice the volume and the
 * same rate shows +100% beside a number that did not change.
 *
 * So a delta is bound to the metric it was computed for, here, once —
 * rather than at each render site where the pairing could drift.
 *
 * ── AND THE UNIT IS A PERCENTAGE ──
 * The design says the comparison is *"stated in the same unit as the
 * metric"*. It is not: what exists is a percentage, for all three. Rendering
 * "up 140 conversations" would mean reconstructing the prior period as
 * `current / (1 + pct/100)` — **a derived number a reader cannot tell from a
 * recorded one**, with rounding error, in a headline. The screen says the
 * comparison in the unit it exists in.
 */
export interface HeadlineMetric {
  readonly key: string;
  readonly value: number;
  /**
   * Percent change against the preceding period of equal length.
   *
   * `null` means no comparison could be made — the prior period had a zero
   * denominator, which is the normal state for a tenant in its first period.
   * **Not the same as 0%**, and the screen must not render it as "no change":
   * there is no baseline to have changed from.
   *
   * `undefined` means this metric has no comparison at all. Also not zero,
   * and a different sentence again — one is "we could not compare", the
   * other is "nobody computes this".
   */
  readonly deltaPct?: number | null;
}

/**
 * The metrics screen 06 can actually show, each with its own delta or none.
 *
 * Deliberately not every field on the overview: this returns what a merchant
 * asked for on the strip, in the order the design puts them, minus the ones
 * whose comparison does not exist and plus nothing invented.
 */
export function headlineMetrics(overview: AnalyticsOverview): readonly HeadlineMetric[] {
  const deltas = overview.deltas;
  return [
    {
      key: 'conversations',
      value: overview.totalConversations,
      deltaPct: deltas?.totalConversationsPct ?? null,
    },
    {
      /*
       * ★ THE COUNT, NOT THE RATE — because the count is what the delta
       * belongs to. `resolutionRate` is on the same response and has no
       * comparison, so pairing them would be the trap above.
       */
      key: 'resolved',
      value: overview.resolvedConversations,
      deltaPct: deltas?.resolvedConversationsPct ?? null,
    },
    { key: 'messages', value: overview.totalMessages, deltaPct: deltas?.totalMessagesPct ?? null },
    // No delta exists for either of these. `undefined`, not null.
    { key: 'handledWithoutYou', value: overview.aiHandledPct },
    { key: 'waitingOnYou', value: overview.pendingApprovalCount },
  ];
}

/** Does this metric have a comparison at all? */
export function hasComparison(metric: HeadlineMetric): boolean {
  return metric.deltaPct !== undefined && metric.deltaPct !== null;
}

/* ── Screen 06c · the team's workload ────────────────────────────────────── */

/**
 * `GET /api/analytics/agents` — `analytics:workspace:read`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ EVERY FIELD HERE COVERS A DIFFERENT PERIOD, AND TWO OF THEM ARE TODAY
 * ════════════════════════════════════════════════════════════════════════════
 * `getAgentStats` reads Prisma for the people and **Redis day-keys** for the
 * numbers: `analytics:{tenant}:agent:{id}:{today}`. So:
 *
 *   activeConversations   open RIGHT NOW. Not "handled", not a period at all
 *   claimedToday          today. Resets at midnight
 *   avgResponseTimeMs     today, averaged over a Redis list
 *
 * Screen 06's header says *"Last 7 days, compared with the week before"*.
 * **That header cannot sit above these figures**, and the screen labels each
 * number with the period it actually covers rather than inheriting one.
 *
 * ── AND IT IS HUMANS ONLY ──
 * `where: { role: "AGENT" }` selects human users. AI employees are not in
 * this list, which the design puts *"in the same table — colleagues in the
 * workload, not a separate report"*. A real absence a reader notices, so the
 * screen states it rather than letting the table imply the team is smaller
 * than it is.
 *
 * ── `email` IS DELIBERATELY NOT NAMED ──
 * The route returns it and `z.object` strips what it does not name. A
 * workload table is not a directory, and an address on this screen is one
 * copy-paste from being used for something it was not collected for.
 */
export const agentLoadSchema = z.object({
  agentId: z.string(),
  name: z.string().nullable().default(null),
  /** Open right now. A queue depth, not a throughput. */
  activeConversations: z.number().default(0),
  /** Today only, from a Redis day-key. */
  claimedToday: z.number().default(0),
  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ `avgResponseTimeMs` IS DELIBERATELY NOT NAMED HERE. DO NOT ADD IT.
   * ════════════════════════════════════════════════════════════════════════
   * The route sends it and `z.object` strips it, which is the point: a field
   * that parses cleanly, carries a plausible name and is rendered by nothing
   * is a trap for whoever builds the next team panel. They would find it
   * defaulted, typed and apparently supported, and none of what follows
   * lives anywhere they would look.
   *
   * IT IS NOT A REPLY TIME. `analytics.worker.ts:38-46`:
   *
   *   claim_time      set ONCE when a conversation is claimed, `EX` 7 days
   *   agent_response  pushes `now − claim_time` on EVERY agent message
   *
   * `claim_time` is **never deleted** — one `set`, one `get`, no `del`
   * anywhere. So the second reply measures from the original claim, the
   * tenth reports hours, and the average **grows with how long a
   * conversation runs rather than with how slow anybody is.**
   *
   * Three more ways it is not what it sounds like:
   *
   *   · it starts at the CLAIM, so a conversation that sat unclaimed for
   *     forty minutes and was answered in ten seconds reports 10s, and the
   *     customer's real wait is invisible
   *   · it counts every agent response, not the first
   *   · it needs a `claim_time` key, so AI-answered conversations contribute
   *     nothing — on this product, most of them
   *
   * ── AND BESIDE A PERSON'S NAME IT IS UNFAIR, NOT MERELY WRONG ──
   * A number rising with conversation length makes whoever handles the long
   * difficult cases look slowest. It shipped on 06c as "Average reply
   * today" and was removed.
   *
   * ── IF YOU NEED THIS FIGURE ──
   * Compute the real one: first OUTBOUND after each INBOUND, from
   * `Message.createdAt` and `direction`. The messages table supports it, it
   * covers AI replies, and it needs no event stream.
   */
});
export type AgentLoad = z.infer<typeof agentLoadSchema>;

export const agentLoadListSchema = z.array(agentLoadSchema);

/**
 * Ordered for reading, not for ranking.
 *
 * ★ BY NAME. Sorting by volume would build the leaderboard out of the row
 * order even with no outcome column present — the top of a sorted list reads
 * as the best or the worst of something, and this data cannot support either
 * claim. Alphabetical says only "here is the team".
 */
export function byName(agents: readonly AgentLoad[]): readonly AgentLoad[] {
  return [...agents].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

/**
 * ★ REMOVED WITH THE COLUMN IT SUPPORTED.
 *
 * `avgResponseTimeMs` is not a reply time — see the field's own note — so
 * there is no "nobody has replied yet" to report. Kept as a named export
 * would have left a helper pointing at a metric the screen must not show.
 */

/* ── 06's "What people ask about" panel ──────────────────────────────────── */

/**
 * `GET /api/analytics/top-questions` — `analytics:dashboard:read`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A "TOPIC" IS A `groupBy`, NOT A THING THE PRODUCT HOLDS
 * ════════════════════════════════════════════════════════════════════════════
 * `getTopQuestions` is
 * `conversationIntelligence.groupBy({ by: ["detectedIntent"] })` over a date
 * range, with a fallback that scans 1,000 inbound message bodies. **There is
 * no `Topic` model in the schema.** The grouping is recomputed on every
 * request from one unconstrained column.
 *
 * That is why 06e became this panel rather than a screen: rename and merge
 * have nowhere to persist to, and the next request would regroup from the
 * raw column and show the old name back.
 *
 * ── AND THE LABELS ARE MODEL-WRITTEN, SO NEAR-DUPLICATES ARE EXPECTED ──
 * `detectedIntent` is `String?` — nullable, no enum. "where is my order",
 * "order status" and "where's my package" are three rows with three counts.
 * The panel's caption says GOTCHA did the grouping, so a reader seeing two
 * rows that look like one question knows we know, rather than concluding the
 * counts are broken.
 *
 * ── `automatable` IS DELIBERATELY NOT NAMED ──
 * The route sends it, and it is `count > 5` — a threshold relabelled as a
 * property of the topic. Rendered as *"GOTCHA could handle this"* it asserts
 * a capability from a frequency; rendered as *"asked more than 5 times"* it
 * is a worse way of printing the count in the next column. Third field this
 * week whose name describes a verdict while its value records a count, after
 * `confidence` on a candidate and `lastTestedAt` on a connection.
 */
export const askedAboutSchema = z.object({
  /** The model's own label. Rendered verbatim; we did not write it. */
  question: z.string().nullable().default(null),
  count: z.number().default(0),
});
export type AskedAbout = z.infer<typeof askedAboutSchema>;

export const askedAboutListSchema = z.array(askedAboutSchema);

/**
 * The rows worth showing: those with a label.
 *
 * A null `detectedIntent` is excluded by the route's own `where`, but the
 * fallback path can produce an unlabelled row. An unnamed topic is not a
 * topic — it is a count with nothing to attach to — and inventing a name
 * for it would be the one thing this panel must not do.
 */
export function namedTopics(rows: readonly AskedAbout[]): readonly AskedAbout[] {
  return rows.filter((r) => (r.question ?? '').trim().length > 0);
}

/** `GET /api/analytics/ai-performance?from&to` — the fields 06b reads. */
export const aiPerformanceSchema = z.looseObject({
  totalAIMessages: z.number().default(0),
  totalHumanMessages: z.number().default(0),
  approvals: z
    .looseObject({
      requested: z.number().default(0),
      approved: z.number().default(0),
      rejected: z.number().default(0),
      pending: z.number().default(0),
      expired: z.number().default(0),
    })
    .default({ requested: 0, approved: 0, rejected: 0, pending: 0, expired: 0 }),
});
export type AiPerformance = z.infer<typeof aiPerformanceSchema>;

/**
 * `GET /api/analytics/unanswered-questions?from&to&limit` → `{ period, data }`.
 * The route returns at most 50 rows and no total, so a full page is "50 or
 * more", never 50.
 */
export const UNANSWERED_PAGE = 50;
export const unansweredQuestionsSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        id: z.string(),
        question: z.string(),
        askCount: z.number().default(1),
      }),
    )
    .default([]),
});
export type UnansweredQuestions = z.infer<typeof unansweredQuestionsSchema>;

/**
 * `GET /api/analytics/hourly?date=YYYY-MM-DD` — one day's messages by hour.
 * ⚠ The hours are UTC: the worker keys them `timestamp.slice(0, 13)` of an
 * ISO string. Convert before saying "11:00" to anyone.
 */
export const hourlySchema = z.array(
  z.looseObject({
    hour: z.string(),
    inbound: z.number().default(0),
    outbound: z.number().default(0),
  }),
);
export type Hourly = z.infer<typeof hourlySchema>;

/**
 * The busiest hour across days of `/hourly`, by inbound messages, as an
 * instant (UTC) — `null` when nothing came in. The caller formats it in the
 * reader's time zone.
 */
export function busiestHour(
  days: readonly { readonly date: string; readonly hours: Hourly }[],
): Date | null {
  const byLocal = new Map<string, { at: Date; inbound: number }>();
  let best: { at: Date; inbound: number } | null = null;
  for (const day of days) {
    for (const slot of day.hours) {
      if (slot.inbound <= 0) continue;
      const at = new Date(`${day.date}T${slot.hour}:00Z`);
      if (Number.isNaN(at.getTime())) continue;
      // Summed by hour of day, across the days — the same hour on each.
      const key = String(at.getUTCHours());
      const entry = byLocal.get(key) ?? { at, inbound: 0 };
      entry.inbound += slot.inbound;
      byLocal.set(key, entry);
      if (!best || entry.inbound > best.inbound) best = entry;
    }
  }
  return best?.at ?? null;
}

/**
 * `GET /api/analytics/product-demand?limit` → `{ weekKey, data }`: what people
 * searched the catalogue for this ISO week and did not find.
 *
 * ⚠ `askedBy` IS NOT PEOPLE. The writer (`recordProductDemand`) increments it
 * on every ask that carries an asker key, with no de-duplication — so it is a
 * count of keyed asks, and a screen must never say "N people". `askCount` is
 * the asks; that is the figure shown. Terms are stored lowercased.
 */
export const productDemandSchema = z.looseObject({
  weekKey: z.string().default(''),
  data: z
    .array(
      z.looseObject({
        id: z.string(),
        term: z.string(),
        askCount: z.number().default(1),
        inCatalogue: z.boolean().default(false),
        weeksRunning: z.number().default(1),
      }),
    )
    .default([]),
});
export type ProductDemand = z.infer<typeof productDemandSchema>;
