import { getTranslations } from 'next-intl/server';

import styles from '@/features/analytics/Analytics.module.css';
import { AskedAbout } from '@/features/analytics/AskedAbout';
import { loadAnalytics } from '@/features/analytics/load-analytics';
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
 * What remains is two panels, so there is no tab row: two tabs where one holds
 * a single panel is ceremony, and one of them would have been named for a
 * section that does not exist.
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
export default async function Page() {
  const t = await getTranslations('analytics');
  const { agents, topics } = await loadAnalytics();

  return (
    <PageContainer layout="screen" title={t('title')} description={t('description')}>
      <div className={styles.screen} data-testid="analytics-screen">
        <AskedAbout topics={topics} />
        <TeamLoad agents={agents} />

        {/*
          ★★ THE SECTION THAT IS NOT HERE, SAID ON THE SCREEN.
          A reader arriving from the design looks for "what GOTCHA did" and
          finds two panels. An absence that explains itself only has to
          explain itself once — and the alternative was a tab with nothing
          behind it, which explains nothing and looks finished.
        */}
        <p className={styles.note} data-testid="analytics-no-gotcha-section">
          {t('noGotchaSection')}
        </p>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.analytics');
