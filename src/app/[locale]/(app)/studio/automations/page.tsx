import { getTranslations } from 'next-intl/server';

import { AutomationList } from '@/features/automations/AutomationList';
import { AutomationRail } from '@/features/automations/AutomationRail';
import styles from '@/features/automations/Automations.module.css';
import { loadAutomations } from '@/features/automations/load-automations';
import { StudioSplit } from '@/features/studio/StudioSplit';
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
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly automation?: string }>;
} = {}) {
  const t = await getTranslations('automations');
  const automations = await loadAutomations();
  const wanted = (await searchParams)?.automation;
  const selected = automations?.find((a) => a.id === wanted) ?? automations?.[0] ?? null;

  /*
    09, measured: 02's header with "New automation" on the right, then the
    list (330) beside the selected automation (`28px 36px`, gap 18). With
    none, the frame is still drawn — the list empty in its shape, the
    detail saying so — rather than one sentence on an empty page.
  */
  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      flush
      title={t('title')}
      description={t('description')}
      actions={
        // 21 (New automation) is not built yet: drawn, and it says so.
        <span
          className={styles.create}
          aria-disabled="true"
          title={t('createNotYet')}
          data-testid="create-automation"
        >
          {t('create')}
        </span>
      }
    >
      <StudioSplit
        label={t('rail.label')}
        detailPad="snug"
        list={
          automations && selected ? (
            <AutomationRail automations={automations} selectedId={selected.id} />
          ) : null
        }
        detail={
          automations === null ? (
            <p data-testid="automations-unavailable">{t('unavailable')}</p>
          ) : selected === null ? (
            <div className={styles.empty} data-testid="automations-empty">
              <p className={styles.emptyLead}>{t('none')}</p>
              {/* The consequence, not just the absence. */}
              <p className={styles.emptyBody}>{t('noneBody')}</p>
            </div>
          ) : (
            <>
              <p className={styles.noHistory} data-testid="no-history">
                {t('noHistory')}
              </p>
              {/* S1: the selected automation's card; S2 draws WHEN/THEN. */}
              <AutomationList automations={[selected]} />
            </>
          )
        }
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
