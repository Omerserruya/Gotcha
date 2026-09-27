import { getFormatter, getTranslations } from 'next-intl/server';

import type { AnalyticsOverview, ChannelPerformance } from '@/api/contracts/analytics';
import { Text } from '@/design-system/primitives/text/Text';

import styles from './Home.module.css';
import { CHANNEL_SPLIT_DAYS } from './load-home-data';

/**
 * The day in four figures, and where it came from.
 *
 * The design's arrangement exactly: counts divided by hairlines with the
 * channel split taking the remaining width, the whole strip ruled above and
 * below. No cards and no grid of tiles — the brief rules both out by name.
 *
 * The fourth figure is "waiting on approval", which analytics does not serve.
 * Rather than substitute a number that happens to be available, the slot keeps
 * its label and shows an em dash: the shape of the day stays legible, and the
 * gap is visible rather than papered over.
 */
export async function MetricStrip({
  overview,
  channels,
  pendingApproval,
  isQuiet,
}: {
  overview: AnalyticsOverview;
  channels: ChannelPerformance | null;
  /** Null while no endpoint serves it. See docs/api-gaps.md. */
  pendingApproval: number | null;
  isQuiet: boolean;
}) {
  const t = await getTranslations('home.metrics');
  /*
   * ★ THE PAGE'S LOCALE, NOT THE PROCESS'S.
   *
   * This was `new Intl.NumberFormat()` with no locale at all. In a server
   * component that means Node's default — `en-US` here — for every reader in
   * every language, and it would follow whatever `LANG` the container happens
   * to be started with.
   *
   * Invisible in this case rather than harmless: `1,234,567.5` is identical in
   * `en-US` and `he-IL`, so nothing on screen disagreed. It is the same defect
   * as the two loud ones next door (`TeamPanel`'s clock, `ChangePlanGate`'s
   * date) and it was found by the same sweep, which is why it is fixed rather
   * than excused.
   */
  const format = await getFormatter();

  /*
   * The labels change with the day.
   *
   * On a quiet morning the strip stops reporting throughput and starts
   * confirming there is nothing outstanding: "conversations so far" rather
   * than "today", "needing you" rather than "by your team". And the AI share
   * reads "all of them" instead of a percentage — 100% is a number you have to
   * parse, "all of them" is the thing you wanted to know.
   */
  const everythingHandled =
    isQuiet && overview.totalConversations > 0 && overview.humanHandledCount === 0;

  return (
    <div className={styles.strip}>
      <Metric
        label={isQuiet ? t('conversationsSoFar') : t('conversations')}
        value={format.number(overview.totalConversations)}
      />

      <Metric
        label={t('handledByGotcha')}
        value={format.number(overview.aiHandledCount)}
        share={
          everythingHandled
            ? t('allOfThem')
            : overview.aiHandledPct > 0
              ? `${Math.round(overview.aiHandledPct)}%`
              : undefined
        }
      />

      <Metric
        label={isQuiet ? t('needingYou') : t('byYourTeam')}
        value={format.number(overview.humanHandledCount)}
      />

      <Metric
        label={t('waitingOnApproval')}
        value={pendingApproval === null ? '—' : format.number(pendingApproval)}
      />

      {channels && channels.length > 0 ? (
        <ChannelSplit
          channels={channels}
          label={t('whereItCameFrom', { days: CHANNEL_SPLIT_DAYS })}
        />
      ) : null}
    </div>
  );
}

function Metric({ label, value, share }: { label: string; value: string; share?: string }) {
  return (
    <div className={styles.metric}>
      <Text role="micro" tone="subtle" as="span">
        {label}
      </Text>
      <span className={styles.metricValue}>
        <Text role="title" as="span" numeric>
          {value}
        </Text>
        {share ? <span className={styles.share}>{share}</span> : null}
      </span>
    </div>
  );
}

/**
 * Channel distribution as one 8px bar.
 *
 * A bar reads as proportion at a glance and stays legible at any width; a pie
 * of six slices does neither. Each channel keeps a fixed colour so the same
 * hue means the same channel wherever it appears.
 */
function ChannelSplit({ channels, label }: { channels: ChannelPerformance; label: string }) {
  const total = channels.reduce((sum, channel) => sum + channel.conversationCount, 0);
  if (total === 0) return null;

  const share = (count: number) => Math.round((count / total) * 100);

  return (
    <div className={styles.channels}>
      <Text role="micro" tone="subtle" as="span">
        {label}
      </Text>
      <div className={styles.bar} role="presentation">
        {channels.map((channel, index) => (
          <span
            key={channel.channel}
            style={{
              inlineSize: `${(channel.conversationCount / total) * 100}%`,
              backgroundColor: `var(--channel-${(index % 6) + 1})`,
            }}
          />
        ))}
      </div>
      <div className={styles.legend}>
        {channels.map((channel) => (
          // The channel code is a backend identifier, shown as-is: a
          // translation key per channel would go stale the moment a new one
          // is connected.
          <span key={channel.channel}>
            {channel.channel} {share(channel.conversationCount)}%
          </span>
        ))}
      </div>
    </div>
  );
}
