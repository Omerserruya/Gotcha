import { getTranslations } from 'next-intl/server';

import { AutomationDetail } from '@/features/automations/AutomationDetail';
import { AutomationRail } from '@/features/automations/AutomationRail';
import { NewAutomation } from '@/features/automations/create/NewAutomation';
import styles from '@/features/automations/Automations.module.css';
import { loadAutomations } from '@/features/automations/load-automations';
import { StudioSplit } from '@/features/studio/StudioSplit';
import { Link } from '@/i18n/navigation';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · Automations - screen 09.
 *
 * ── A COUNT, AND NO HISTORY ──
 * `runCount` is an `Int` and **there are no run-record models of any kind**.
 * So the screen can say how many times an automation ran and never which
 * times or what happened - and it **says so**, above the list, because a
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
 * **No "₪12,400 recovered"** - attributed revenue, its fifth appearance
 * across five screens, still with no inputs anywhere.
 *
 * **No dry-run, no natural-language rule assembly, no watch-only mode.**
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly automation?: string;
    /** 21: the New automation sheet. */
    readonly create?: string;
  }>;
} = {}) {
  const t = await getTranslations('automations');
  const automations = await loadAutomations();
  const params = (await searchParams) ?? {};
  const wanted = params.automation;
  const selected = automations?.find((a) => a.id === wanted) ?? automations?.[0] ?? null;

  /*
    09, measured: 02's header with "New automation" on the right, then the
    list (330) beside the selected automation (`28px 36px`, gap 18). With
    none, the frame is still drawn - the list empty in its shape, the
    detail saying so - rather than one sentence on an empty page.
  */
  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      flush
      title={t('title')}
      description={
        /*
          02's line is a summary from data ("Five running. They handled
          1,204 things this week…"). From what is read: how many are on and
          off, and how often they ran - in all, never "this week".
        */
        automations && automations.length > 0
          ? t('summary', {
              running: automations.filter((a) => a.isActive).length,
              off: automations.filter((a) => !a.isActive).length,
              runs: automations.reduce((sum, a) => sum + a.runCount, 0),
            })
          : t('description')
      }
      actions={
        // 21: the New automation sheet over this screen.
        <Link
          href={{ pathname: '/studio/automations', query: { create: '1' } }}
          className={styles.create}
          data-testid="create-automation"
          scroll={false}
        >
          {t('create')}
        </Link>
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
            <AutomationDetail automation={selected} />
          )
        }
      />
      {params.create === '1' ? <NewAutomation /> : null}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
