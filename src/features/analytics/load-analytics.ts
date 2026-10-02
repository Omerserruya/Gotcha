import { serverApi } from '@/api/client/server-api';
import { toolUsageListSchema, type ToolUsage } from '@/api/contracts/capabilities';
import {
  aiPerformanceSchema,
  unansweredQuestionsSchema,
  UNANSWERED_PAGE,
  type AiPerformance,
  type UnansweredQuestions,
  agentLoadListSchema,
  analyticsOverviewSchema,
  askedAboutListSchema,
  insightsSchema,
  timeSavedSchema,
  type AgentLoad,
  type AnalyticsOverview,
  type AskedAbout,
  type Insight,
  type TimeSaved,
} from '@/api/contracts/analytics';
import { analyticsEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What screen 06 reads.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TWO PANELS, TWO INDEPENDENT FAILURES, AND NO HEADLINE
 * ════════════════════════════════════════════════════════════════════════════
 * Both reads are gated on permissions an ordinary agent may not hold —
 * `analytics:workspace:read` for the team, `analytics:dashboard:read` for the
 * questions — so a 403 on one must not take the other with it. `null` means we
 * could not read it, never "there is none", and each panel says so itself.
 *
 * ── WHAT IS NOT HERE, AND WHY ──
 * **No headline metric strip.** `MetricStrip` exists and is live on screen 01.
 * Mounting it here too would put two renderings of the same numbers on two
 * screens, and the day one of them gains a qualifier the other would quietly
 * disagree.
 *
 * **No "what GOTCHA did" section.** It was held on an escalation aggregation
 * and the aggregation does not exist: `ConversationHandover.reason` is a
 * four-value code — `escalation | takeover | assignment | routing` — with no
 * route over it, and nothing counts machine causes. The tab is left out rather
 * than shipped empty.
 *
 * **No sales section.** Cancelled.
 */
export interface AnalyticsData {
  readonly agents: readonly AgentLoad[] | null;
  readonly topics: readonly AskedAbout[] | null;
  /**
   * 06's figures for the last seven days. `overview` computes its own prior
   * period of the same length, so its deltas are "against the week before" —
   * which is what the subline says.
   */
  readonly overview: AnalyticsOverview | null;
  readonly timeSaved: TimeSaved | null;
  /** The findings — the same `insights` Home's "Worth knowing" reads. */
  readonly insights: readonly Insight[] | null;
}

/** The week the screen describes: the last seven days, to now. */
export function lastSevenDays(now: Date = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
  };
}

export async function loadAnalytics(): Promise<AnalyticsData> {
  const api = serverApi();

  const week = lastSevenDays();
  const [agents, topics, overview, timeSaved, insights] = await Promise.all([
    api
      .get({ endpoint: analyticsEndpoints.agents(), payload: agentLoadListSchema })
      .catch((cause: unknown) => {
        logger.warn('analytics.agents_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: analyticsEndpoints.topQuestions(), payload: askedAboutListSchema })
      .catch((cause: unknown) => {
        logger.warn('analytics.top_questions_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: analyticsEndpoints.overview(),
        payload: analyticsOverviewSchema,
        query: week,
      })
      .catch((cause: unknown) => {
        logger.warn('analytics.overview_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: analyticsEndpoints.timeSaved(), payload: timeSavedSchema, query: week })
      .catch((cause: unknown) => {
        logger.warn('analytics.time_saved_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: analyticsEndpoints.insights(), payload: insightsSchema })
      .catch((cause: unknown) => {
        logger.warn('analytics.insights_failed', { cause });
        return null;
      }),
  ]);

  return { agents, topics, overview, timeSaved, insights };
}

/** What 06b reads: the week, from five routes. Each `null` when its read failed. */
export interface GotchaData {
  readonly overview: AnalyticsOverview | null;
  readonly timeSaved: TimeSaved | null;
  readonly tools: readonly ToolUsage[] | null;
  readonly ai: AiPerformance | null;
  readonly unanswered: UnansweredQuestions | null;
}

export async function loadGotcha(): Promise<GotchaData> {
  const api = serverApi();
  const week = lastSevenDays();
  const failing =
    <T>(event: string) =>
    (cause: unknown): T | null => {
      logger.warn(event, { cause });
      return null;
    };
  const [overview, timeSaved, tools, ai, unanswered] = await Promise.all([
    api
      .get({
        endpoint: analyticsEndpoints.overview(),
        payload: analyticsOverviewSchema,
        query: week,
      })
      .catch(failing<AnalyticsOverview>('analytics.overview_failed')),
    api
      .get({ endpoint: analyticsEndpoints.timeSaved(), payload: timeSavedSchema, query: week })
      .catch(failing<TimeSaved>('analytics.time_saved_failed')),
    api
      .get({ endpoint: analyticsEndpoints.toolUsage(), payload: toolUsageListSchema, query: week })
      .catch(failing<ToolUsage[]>('analytics.tool_usage_failed')),
    api
      .get({
        endpoint: analyticsEndpoints.aiPerformance(),
        payload: aiPerformanceSchema,
        query: week,
      })
      .catch(failing<AiPerformance>('analytics.ai_performance_failed')),
    api
      .get({
        endpoint: analyticsEndpoints.unansweredQuestions(),
        payload: unansweredQuestionsSchema,
        query: { ...week, limit: UNANSWERED_PAGE },
        // `{ period, data }`: unwrapping would hand the array to an object schema.
        raw: true,
      })
      .catch(failing<UnansweredQuestions>('analytics.unanswered_failed')),
  ]);
  return { overview, timeSaved, tools, ai, unanswered };
}
