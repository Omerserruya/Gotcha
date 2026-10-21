import { getLocale, getTranslations } from 'next-intl/server';

import { FactRows } from '@/features/workspace/FactRows';
import { HoursDrawer } from '@/features/workspace/HoursDrawer';
import { LanguageDrawer } from '@/features/workspace/LanguageDrawer';
import { loadLanguages } from '@/features/workspace/load-languages';
import { loadIdleSetup } from '@/features/workspace/load-idle';
import { loadDepartmentSlas, loadSlaSetup } from '@/features/workspace/load-sla-setup';
import { loadWebsiteScan, loadWorkspace } from '@/features/workspace/load-workspace';
import { placeLabels } from '@/features/workspace/zones';
import { ProhibitedClaims } from '@/features/workspace/ProhibitedClaims';
import { IdleDrawer } from '@/features/workspace/IdleDrawer';
import { IdleRow } from '@/features/workspace/IdleRow';
import { SlaDrawer } from '@/features/workspace/SlaDrawer';
import { SlaRow } from '@/features/workspace/SlaRow';
import { VoiceEditor } from '@/features/workspace/VoiceEditor';
import styles from '@/features/workspace/Workspace.module.css';
import { pageMetadata } from '@/shell/page-metadata';
import { Drawer } from '@/shell/Drawer';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Workspace - screen 11.
 *
 * *"The facts every AI employee quotes to a customer, plus how the business
 * sounds."* Three independent reads, and a failure in one does not blank the
 * others: an owner who can still fix their opening hours is better served than
 * one shown a single error for all three.
 *
 * Deliberately contains no AI behaviour. That lives in Studio, and the
 * sidebar says so.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly panel?: string }>;
}) {
  const t = await getTranslations('workspace');
  // The time zone and currency words, built here so the browser never recomputes them (zones.ts).
  const locale = await getLocale();
  const panel = (await searchParams)?.panel;
  const [{ workspace, voice, claims }, languages, scan, sla, idle] = await Promise.all([
    loadWorkspace(),
    loadLanguages(),
    loadWebsiteScan(),
    loadSlaSetup(),
    loadIdleSetup(),
  ]);
  // W2: the departments' own targets - read only with the drawer open.
  const slaDepartments =
    panel === 'sla' && sla.kind === 'owner' ? await loadDepartmentSlas() : null;

  /*
    11, measured: the facts as one table with the marking ON the rows, then
    "How GOTCHA should sound" beside "Never say". The scan banner ("Scan
    again") moved to Studio · Knowledge, beside the website (Omer,
    2026-10-11); the website row's "Scan again" leads there.

    No business drawer (11b): name, what you sell and address edit in their
    own rows, so the drawer only repeated them (Omer, 2026-10-11).
  */
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {workspace ? (
        <FactRows
          workspace={workspace}
          scan={scan}
          systemLocale={languages.systemLocale}
          places={placeLabels(locale, workspace)}
          sla={<SlaRow setup={sla} />}
          idle={<IdleRow setup={idle} />}
        />
      ) : (
        <p>{t('unavailable')}</p>
      )}
      <div className={styles.cards}>
        {voice ? <VoiceEditor voice={voice} /> : <p>{t('voice.unavailable')}</p>}
        {claims ? <ProhibitedClaims claims={claims.claims} /> : <p>{t('claims.unavailable')}</p>}
      </div>

      {/* 11c, 11d: the facts' drawers, opened from their rows' Edit. */}
      {workspace && panel === 'hours' ? (
        <Drawer
          title={t('hoursDrawer.title')}
          line={t('hoursDrawer.line')}
          closeHref="/settings/workspace"
          testId="drawer-hours"
        >
          <HoursDrawer workspace={workspace} />
        </Drawer>
      ) : workspace && panel === 'language' ? (
        <Drawer
          title={t('languageDrawer.title')}
          line={t('languageDrawer.line')}
          closeHref="/settings/workspace"
          width={620}
          testId="drawer-language"
        >
          <LanguageDrawer systemLocale={languages.systemLocale} />
        </Drawer>
      ) : panel === 'sla' && sla.kind === 'owner' ? (
        <Drawer
          title={t('slaDrawer.title')}
          line={t('slaDrawer.line')}
          closeHref="/settings/workspace"
          testId="drawer-sla"
        >
          <SlaDrawer settings={sla.settings} departments={slaDepartments} />
        </Drawer>
      ) : panel === 'idle' && idle.kind === 'owner' ? (
        <Drawer
          title={t('idleDrawer.title')}
          line={t('idleDrawer.line')}
          closeHref="/settings/workspace"
          testId="drawer-idle"
        >
          <IdleDrawer settings={idle.settings} />
        </Drawer>
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.workspace');
