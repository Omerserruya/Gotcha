import { serverApi } from '@/api/client/server-api';
import {
  agentLoadListSchema,
  askedAboutListSchema,
  type AgentLoad,
  type AskedAbout,
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
}

export async function loadAnalytics(): Promise<AnalyticsData> {
  const api = serverApi();

  const [agents, topics] = await Promise.all([
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
  ]);

  return { agents, topics };
}
