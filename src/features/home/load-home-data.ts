import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { tenantGateFrom, type TenantGate } from '@/api/client/tenant-gate';
import {
  analyticsOverviewSchema,
  activityFeedSchema,
  analyticsQueueSchema,
  inFlightSchema,
  insightsSchema,
  channelPerformanceSchema,
  queueItemsSchema,
  timeSavedSchema,
  usageAllowanceSchema,
  type AnalyticsOverview,
  type AnalyticsQueue,
  type ActivityEvent,
  type ChannelPerformance,
  type InFlight,
  type Insight,
  type QueueItems,
  type TimeSaved,
  type UsageAllowance,
} from '@/api/contracts/analytics';
import {
  intelligenceReviewsSchema,
  type IntelligenceReview,
} from '@/api/contracts/intelligence-reviews';
import { presenceRosterSchema, type AgentPresence } from '@/api/contracts/presence';
import { teamSchema, type Team } from '@/api/contracts/team';
import { unreadCountSchema } from '@/api/contracts/notifications';
import {
  analyticsEndpoints,
  intelligenceReviewEndpoints,
  usageEndpoints,
  notificationEndpoints,
  presenceEndpoints,
} from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Home's data, fetched on the server.
 *
 * Each figure is independently nullable. A single failing endpoint must not
 * blank the page: Home is the first thing an operator sees each morning, and
 * one dead analytics query is not a reason to show them nothing. The sections
 * that resolved render; the ones that did not say so.
 *
 * The two calls run in parallel — they are unrelated, and sequencing them
 * would double the wait for no benefit.
 */
export interface HomeData {
  readonly overview: AnalyticsOverview | null;
  readonly channels: ChannelPerformance | null;
  readonly queue: AnalyticsQueue | null;
  /**
   * The ranked "needs you now" list.
   *
   * Null means the call failed, which is not the same as an empty queue: one
   * says "we could not find out", the other says "nobody is waiting". The
   * screen must not render the second when it means the first.
   */
  readonly queueItems: QueueItems | null;
  /** What GOTCHA has done, newest first. Null when the call failed. */
  readonly activity: readonly ActivityEvent[] | null;
  /**
   * Seconds saved, with the arithmetic. The `basis` travels with it: this is
   * the easiest figure in the product to inflate, and a platform average must
   * not be shown with the confidence of a measured one.
   */
  readonly timeSaved: TimeSaved | null;
  /** What GOTCHA is doing right now — present tense, unlike `activity`. */
  readonly inFlight: InFlight | null;
  /** Conversation headroom. `limit` null means the plan is uncapped. */
  readonly allowance: UsageAllowance | null;
  /**
   * "Worth knowing". `kind` + `values`; the wording is ours.
   *
   * Null when the call failed, empty when nothing stands out — a distinction
   * the screen keeps, because "nothing to report" is a real and good state.
   */
  readonly insights: readonly Insight[] | null;
  readonly team: Team | null;
  /**
   * Presence, keyed by agent id.
   *
   * A separate call from `/api/analytics/agents` - one is workload, the other
   * availability, and the frontend joins them. Empty when it fails: a missing
   * dot is a smaller lie than a wrong one.
   */
  readonly presence: ReadonlyMap<string, AgentPresence>;
  /**
   * Things GOTCHA learned that two sources disagree about. Only `conflict`
   * reviews: `low_confidence` and `scope_review` are a different question and
   * belong on a different surface.
   */
  readonly conflicts: readonly IntelligenceReview[];
  /**
   * Whether nothing is waiting on a person.
   *
   * Derived, because the backend has no such signal. `waiting` counts
   * unassigned OPEN/WAITING conversations tenant-wide — the nearest thing to
   * "needs somebody", though not the same as it, since no classification of
   * "needing a person" exists.
   */
  readonly isQuiet: boolean;
  /** Unread notifications — the "2 signals" pill. Null when unavailable. */
  readonly signals: number | null;
  /**
   * Set when the platform refused because the tenant itself is gated.
   *
   * Per-endpoint degradation is right for one dead query and wrong for this:
   * every call fails at once, and the result is a page that looks like a
   * working product with nothing in it. That reads as "you have no work",
   * which is a lie. Home renders the reason instead.
   */
  readonly gate: TenantGate | null;
}

/** Today, as the backend expects it: ISO instants bounding the local day. */
function today(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: start.toISOString(), to: now.toISOString() };
}

export async function loadHomeData(): Promise<HomeData> {
  const api = serverApi();
  const range = today();

  let gate: TenantGate | null = null;

  /**
   * Logs the failure, remembers a tenant gate, and yields the section's
   * fallback so one dead endpoint still cannot blank the page.
   */
  const degrade =
    <T>(event: string, value: T) =>
    (cause: unknown): T => {
      gate ??= tenantGateFrom(cause);
      logger.warn(event, { cause });
      return value;
    };

  const [
    overview,
    channels,
    queue,
    queueItems,
    activity,
    timeSaved,
    inFlight,
    allowance,
    insights,
    team,
    conflicts,
    signals,
    presence,
  ] = await Promise.all([
    api
      .get({
        endpoint: analyticsEndpoints.overview(),
        query: range,
        payload: analyticsOverviewSchema,
      })
      .catch(degrade('home.overview_failed', null)),
    api
      .get({
        endpoint: analyticsEndpoints.channelPerformance(),
        query: range,
        payload: channelPerformanceSchema,
      })
      .catch(degrade('home.channels_failed', null)),
    api
      .get({ endpoint: analyticsEndpoints.queue(), payload: analyticsQueueSchema })
      .catch(degrade('home.queue_failed', null)),
    api
      .get({
        endpoint: analyticsEndpoints.queueItems(),
        // The design's card shows four rows and then "N more waiting".
        query: { limit: 4 },
        payload: queueItemsSchema,
        // `data` is a sibling of `nextCursor` and `totalWaiting`, not the payload.
        raw: true,
      })
      .catch(degrade('home.queue_items_failed', null)),
    api
      .get({
        endpoint: analyticsEndpoints.activity(),
        // The design's card lists four; one more proves there is a next page.
        query: { limit: 5 },
        payload: activityFeedSchema,
        // `data` is a sibling of `nextCursor`, not the payload.
        raw: true,
      })
      .then((feed) => feed.data)
      .catch(degrade<readonly ActivityEvent[] | null>('home.activity_failed', null)),
    api
      .get({
        endpoint: analyticsEndpoints.timeSaved(),
        query: range,
        payload: timeSavedSchema,
      })
      .catch(degrade('home.time_saved_failed', null)),
    api
      .get({ endpoint: analyticsEndpoints.inFlight(), payload: inFlightSchema })
      .catch(degrade('home.in_flight_failed', null)),
    api
      .get({ endpoint: usageEndpoints.allowance(), payload: usageAllowanceSchema })
      .catch(degrade('home.allowance_failed', null)),
    api
      .get({ endpoint: analyticsEndpoints.insights(), payload: insightsSchema })
      .catch(degrade<readonly Insight[] | null>('home.insights_failed', null)),
    api
      .get({ endpoint: analyticsEndpoints.agents(), payload: teamSchema })
      .catch(degrade('home.team_failed', null)),
    api
      .get({
        endpoint: intelligenceReviewEndpoints.list(),
        payload: intelligenceReviewsSchema,
        // `{ ok, pending, reviews }` — `data` is not the payload here.
        raw: true,
      })
      .then((result) => result.reviews.filter((review) => review.reason === 'conflict'))
      .catch(degrade<readonly IntelligenceReview[]>('home.reviews_failed', [])),
    api
      .get({
        endpoint: notificationEndpoints.unreadCount(),
        payload: unreadCountSchema,
        raw: true,
      })
      .then((result) => result.count)
      .catch(degrade<number | null>('home.signals_failed', null)),
    api
      .get({ endpoint: presenceEndpoints.roster(), payload: presenceRosterSchema })
      .catch(degrade<readonly AgentPresence[]>('home.presence_failed', [])),
  ]);

  return {
    overview,
    channels,
    queue,
    queueItems,
    activity,
    timeSaved,
    inFlight,
    allowance,
    insights,
    team,
    conflicts,
    // Unknown counts as busy: showing the calm screen when we cannot tell
    // would be the more damaging mistake of the two.
    signals,
    presence: new Map(presence.map((entry) => [entry.agentId, entry])),
    isQuiet: queue !== null && queue.waiting === 0,
    gate,
  };
}
