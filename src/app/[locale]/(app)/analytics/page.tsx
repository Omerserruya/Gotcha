import { getTranslations } from 'next-intl/server';

import styles from '@/features/analytics/Analytics.module.css';
import { AskedAbout } from '@/features/analytics/AskedAbout';
import { AnalyticsTabs, parseAnalyticsTab } from '@/features/analytics/AnalyticsTabs';
import {
  AloneChart,
  GotchaHero,
  GotchaStrip,
  lastSevenDayDates,
  WhatItDid,
  WhereStopped,
} from '@/features/analytics/GotchaTab';
import {
  loadAnalytics,
  loadGotcha,
  loadSales,
  loadTeam,
  loadTopics,
} from '@/features/analytics/load-analytics';
import {
  HowTheySound,
  TopicByDay,
  TopicsHero,
  TopicTable,
  UnansweredCard,
} from '@/features/analytics/TopicsTab';
import {
  AskedNotGot,
  MoneySources,
  SalesHero,
  SalesStrip,
  WhatYouLost,
} from '@/features/analytics/SalesTab';
import {
  HandoverCard,
  TeamHero,
  TeamStrip,
  TeamTable,
  teamSubline,
} from '@/features/analytics/TeamTab';
import { KpiStrip, WhatChanged } from '@/features/analytics/OperationSummary';
import { TeamLoad } from '@/features/analytics/TeamLoad';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Analytics — screen 06.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS SCREEN DID NOT EXIST UNTIL NOW, AND EVERY TEST PASSED
 * ════════════════════════════════════════════════════════════════════════════
 * `TeamLoad` and `AskedAbout` were built, tested and **imported by nothing**;
 * this route was still the placeholder stub. The panels render correctly when
 * a test renders them, and nothing anywhere asked whether a page did — the
 * same shape as three i18n catalogues that no loader enumerated. Both were
 * complete artefacts, absent at runtime.
 *
 * ── WHAT THE DESIGN ASKED FOR AND WHAT IS HERE ──
 * The design's tab row is **Overview · GOTCHA · Team**, with Sales alongside.
 * Two of those four are gone and the reasons are not the same:
 *
 *   Sales     cancelled.
 *   GOTCHA    held on an escalation aggregation that does not exist.
 *             `ConversationHandover.reason` is a four-value code — escalation,
 *             takeover, assignment, routing — with no route over it, and
 *             nothing counts machine causes. **An empty tab inside an
 *             assembled screen is the defect this commit removes**, so it is
 *             left out and said here instead of drawn.
 *   Topics    folded in as a panel rather than a section: a "topic" is a
 *             `groupBy` over one unconstrained column with no model behind it,
 *             so rename and merge have nowhere to persist.
 *   Team      here, as a panel.
 *
 * (Superseded 2026-10-02: 06b–06e exist now, each its own tab, and the tab
 * row is drawn — a tab that leads somewhere is not ceremony.)
 *
 * ── AND NO HEADLINE NUMBERS ──
 * `MetricStrip` is live on screen 01. A second rendering of the same figures
 * here would be two screens to keep in step, and the day one gains a qualifier
 * the other contradicts it.
 *
 * ★ Both panels are async server components and they are SIBLINGS, which
 *   keeps both visible to the structural test — it does not run a nested
 *   async component. (React does: the deployed inbox renders nested async components inside `<Suspense>` (8bb92d6, measured in a browser).)
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly tab?: string }>;
} = {}) {
  const t = await getTranslations('analytics');
  const tab = parseAnalyticsTab((await searchParams)?.tab);
  /*
    02's tabs — drawn now that each leads somewhere, which was the only
    reason they were not. The same row on every tab.
  */
  const tabs = <AnalyticsTabs current={tab} />;

  /* 06b — what GOTCHA did, and where it stopped. Its own reads. */
  if (tab === 'gotcha') {
    const data = await loadGotcha();
    return (
      <PageContainer
        layout="screen"
        fill
        actions={tabs}
        title={t('gotcha.title')}
        description={t('gotcha.subline')}
      >
        <div className={styles.gScreen} data-testid="analytics-gotcha">
          <div className={styles.gTop}>
            <GotchaHero data={data} />
            <WhereStopped data={data} />
          </div>
          <GotchaStrip data={data} />
          <div className={styles.gBottom}>
            <AloneChart days={lastSevenDayDates(new Date())} />
            <WhatItDid tools={data.tools} integrations={data.integrations} />
          </div>
        </div>
      </PageContainer>
    );
  }

  /* 06c — the team, without a leaderboard. */
  if (tab === 'team') {
    const data = await loadTeam();
    return (
      <PageContainer
        layout="screen"
        fill
        actions={tabs}
        title={t('teamTab.title')}
        description={await teamSubline(data)}
      >
        <div className={styles.gScreen} data-testid="analytics-team">
          <div className={styles.gTop}>
            <TeamHero agents={data.agents} />
            <HandoverCard />
          </div>
          <TeamStrip data={data} />
          <TeamTable agents={data.agents} aiEmployees={data.aiEmployees} />
        </div>
      </PageContainer>
    );
  }

  /* 06d — what conversations were worth; only unmet demand is recorded. */
  if (tab === 'sales') {
    const { demand } = await loadSales();
    return (
      <PageContainer
        layout="screen"
        fill
        actions={tabs}
        title={t('sales.title')}
        description={t('sales.subline')}
      >
        <div className={styles.gScreen} data-testid="analytics-sales">
          <div className={styles.gTop}>
            <SalesHero />
            <WhatYouLost demand={demand} />
          </div>
          <SalesStrip />
          <div className={styles.gBottom}>
            <MoneySources />
            <AskedNotGot demand={demand} />
          </div>
        </div>
      </PageContainer>
    );
  }

  /* 06e — what people ask about, this week against the week before. */
  if (tab === 'topics') {
    const data = await loadTopics();
    return (
      <PageContainer
        layout="screen"
        fill
        actions={tabs}
        title={t('topics.title')}
        description={t('topics.subline')}
      >
        <div className={styles.gScreen} data-testid="analytics-topics">
          <div className={styles.gTop}>
            <TopicsHero data={data} />
            <UnansweredCard data={data} />
          </div>
          <div className={styles.gBottom}>
            <TopicTable data={data} />
            <div className={styles.eColumn}>
              <TopicByDay data={data} days={lastSevenDayDates(new Date())} />
              <HowTheySound />
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }

  const { agents, topics, overview, timeSaved, insights } = await loadAnalytics();

  return (
    /*
      06, measured: the title is a question answered — "How the operation is
      doing" — over the period it covers, with 02's tabs on its right.
    */
    <PageContainer
      layout="screen"
      fill
      actions={tabs}
      title={t('screenTitle')}
      description={t('screenSubline')}
    >
      <div className={styles.screen} data-testid="analytics-screen">
        <WhatChanged insights={insights} />
        <KpiStrip overview={overview} timeSaved={timeSaved} />
        {/*
          02's bottom row: a wide card and a 330px one. The wide one is
          "Conversations a day" in 02 — the platform counts MESSAGES a day and
          does not split GOTCHA from the team, so that chart is not drawn, and
          the team's load takes its place. "What people ask about" is 02's own
          right-hand card.

          Siblings, not nested: the structural test cannot see inside a nested
          async component (it does not run one).
        */}
        <div className={styles.bottomRow}>
          <TeamLoad agents={agents} />
          <AskedAbout topics={topics} />
        </div>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.analytics');
