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
