import { getFormatter, getTranslations } from 'next-intl/server';

import { Text } from '@/design-system/primitives/text/Text';
import { TenantGateNotice } from '@/features/tenant-gate/TenantGateNotice';

import { ActivityCard } from './ActivityCard';
import { CommandSurface } from './CommandSurface';
import { QueueList } from './QueueList';
import { QuietWork } from './QuietWork';
import styles from './Home.module.css';
import { loadHomeData } from './load-home-data';
import { MetricStrip } from './MetricStrip';
import { StatusStrip } from './StatusStrip';
import { TeamPanel } from './TeamPanel';
import { WorthKnowing } from './WorthKnowing';

/**
 * Home — screens 01 and 01b.
 *
 * One screen with two faces. When something is waiting it leads with the
 * queue; when nothing is, it becomes a different screen — "nothing urgent is a
 * state worth designing". The greeting changes, the suggestions change, and
 * the queue is replaced by work worth doing while it is quiet.
 *
 * Quiet is derived here, from `/api/analytics/queue` reaching zero. There is
 * no backend signal for it, and unknown counts as busy: showing the calm
 * screen when we cannot tell would be the more damaging of the two mistakes.
 *
 * Three regions the design draws have no data behind them and are named as
 * such rather than omitted or filled with plausible figures: the ranked queue,
 * GOTCHA's activity stream, and three of the four quiet-day cards.
 */
export async function HomeScreen() {
  const t = await getTranslations('home');
  const format = await getFormatter();
  const {
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
    isQuiet,
    signals,
    presence,
    gate,
  } = await loadHomeData();

  /*
   * The tenant is locked out commercially, so every figure below would be
   * absent for the same reason. Rendering the product's frame around nothing
   * would read as "no work waiting" - which is a different, and false,
   * statement. Say what is actually true instead.
   */
  if (gate) {
    return (
      <div className={styles.page}>
        <TenantGateNotice gate={gate} />
      </div>
    );
  }

  const now = new Date();
  // From the viewer's clock: "good morning" at 9pm is worse than no greeting.
  const partOfDay = now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening';

  return (
    <div className={styles.page}>
      <StatusStrip waiting={queue?.waiting ?? null} signals={signals} isQuiet={isQuiet} />

      <header className={styles.greeting}>
        <Text role="serifInline" tone="subtle" as="p">
          {format.dateTime(now, 'greeting')}
        </Text>
        <Text role="hero" as="h1" className={styles.greetingHeading}>
          {isQuiet ? t('greeting.quiet') : t(`greeting.${partOfDay}`)}
        </Text>
        <Text role="body" tone="muted" className={styles.greetingSummary}>
          {!overview
            ? t('summaryUnavailable')
            : isQuiet
              ? t('summaryQuiet')
              : t('summary', {
                  total: overview.totalConversations,
                  handled: overview.aiHandledCount,
                })}
        </Text>
      </header>

      {/* The suggestions change with the mood: a quiet morning is the moment
          to do the work nobody schedules. */}
      <CommandSurface tone={isQuiet ? 'quiet' : 'busy'} />

      {overview ? (
        <MetricStrip
          overview={overview}
          channels={channels}
          pendingApproval={overview.pendingApprovalCount}
          isQuiet={isQuiet}
        />
      ) : null}

      <div className={styles.columns}>
        <section className={styles.queueColumn}>
          {isQuiet ? (
            <QuietWork conflicts={conflicts} />
          ) : (
            <>
              <div className={styles.sectionHeader}>
                <Text role="label" as="h2">
                  {t('needsYou.title')}
                </Text>
                <Text role="caption" tone="subtle" as="span">
                  {t('needsYou.sortedBy')}
                </Text>
              </div>
              {queueItems && queueItems.data.length > 0 ? (
                <QueueList
                  items={queueItems.data}
                  totalWaiting={queueItems.totalWaiting}
                  now={now}
                />
              ) : (
                <div className={styles.queueCard}>
                  <p className={styles.emptyNote} style={{ paddingInline: 16 }}>
                    {/* Null is "we could not find out"; empty is "nobody is
                        waiting". Saying the second when we mean the first would
                        tell an operator their queue is clear when it may not be. */}
                    {queueItems ? t('needsYou.empty') : t('needsYou.unavailable')}
                  </p>
                </div>
              )}
            </>
          )}
        </section>

        <aside className={styles.asideColumn}>
          <ActivityCard
            events={activity}
            timeSaved={timeSaved}
            inFlight={inFlight}
            allowance={allowance}
            now={now}
          />

          <WorthKnowing insights={insights} />

          {team && team.length > 0 ? <TeamPanel team={team} presence={presence} /> : null}
        </aside>
      </div>
    </div>
  );
}
