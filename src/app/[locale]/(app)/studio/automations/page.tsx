import { getTranslations } from 'next-intl/server';

import { AutomationList } from '@/features/automations/AutomationList';
import styles from '@/features/automations/Automations.module.css';
import { loadAutomations } from '@/features/automations/load-automations';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · Automations — screen 09.
 *
 * ── A COUNT, AND NO HISTORY ──
 * `runCount` is an `Int` and **there are no run-record models of any kind**.
 * So the screen can say how many times an automation ran and never which
 * times or what happened — and it **says so**, above the list, because a
 * reader who is not told will assume the history is one click away.
 *
 * That also means *"stop-reason clustering → suggested branch"* has nothing
 * to cluster, which follows from the absence rather than being a second gap.
 *
 * ── WHAT ELSE IS ABSENT ──
 * **No "this week".** The counter is cumulative and has no clock, so
 * *"Ran 46 times this week"* and *"handled 1,204 things this week"* are not
 * derivable from anything.
 *
 * **No "paused by you on 12 Aug".** `isActive` is a boolean with no actor and
 * no timestamp.
 *
 * **No "₪12,400 recovered"** — attributed revenue, its fifth appearance
 * across five screens, still with no inputs anywhere.
 *
 * **No dry-run, no natural-language rule assembly, no watch-only mode.**
 */
export default async function Page() {
  const t = await getTranslations('automations');
  const automations = await loadAutomations();

  if (automations === null) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <p data-testid="automations-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  if (automations.length === 0) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <div className={styles.empty} data-testid="automations-empty">
          <p className={styles.emptyLead}>{t('none')}</p>
          {/* The consequence, not just the absence. */}
          <p className={styles.emptyBody}>{t('noneBody')}</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t('title')} description={t('description')}>
      <div className={styles.screen} data-testid="automations-screen">
        <p className={styles.noHistory} data-testid="no-history">
          {t('noHistory')}
        </p>
        <AutomationList automations={automations} />
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
