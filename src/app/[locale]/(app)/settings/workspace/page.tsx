import { getTranslations } from 'next-intl/server';

import { FactRows } from '@/features/workspace/FactRows';
import { Languages } from '@/features/workspace/Languages';
import { ScanPanel } from '@/features/workspace/ScanPanel';
import { loadLanguages } from '@/features/workspace/load-languages';
import { loadWorkspace } from '@/features/workspace/load-workspace';
import { ProhibitedClaims } from '@/features/workspace/ProhibitedClaims';
import { VoiceEditor } from '@/features/workspace/VoiceEditor';
import styles from '@/features/workspace/Workspace.module.css';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Workspace — screen 11.
 *
 * *"The facts every AI employee quotes to a customer, plus how the business
 * sounds."* Three independent reads, and a failure in one does not blank the
 * others: an owner who can still fix their opening hours is better served than
 * one shown a single error for all three.
 *
 * Deliberately contains no AI behaviour. That lives in Studio, and the
 * sidebar says so.
 */
export default async function Page() {
  const t = await getTranslations('workspace');
  const [{ workspace, voice, claims }, languages] = await Promise.all([
    loadWorkspace(),
    loadLanguages(),
  ]);

  /*
    11, measured: the scan banner (its sentence, the "From website" legend,
    "Scan again"), the facts as one table with the marking ON the rows, then
    "How GOTCHA should sound" beside "Never say". The separate "where these
    details came from" section is gone: its facts live on the chips and on
    the scan control.
  */
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {workspace ? <ScanPanel domain={workspace.websiteDomain ?? null} /> : null}
      {workspace ? <FactRows workspace={workspace} /> : <p>{t('unavailable')}</p>}
      <div className={styles.cards}>
        {voice ? <VoiceEditor voice={voice} /> : <p>{t('voice.unavailable')}</p>}
        {claims ? <ProhibitedClaims claims={claims.claims} /> : <p>{t('claims.unavailable')}</p>}
      </div>
      {/*
        Screen 11d's content (which languages are arriving), not 11's — kept
        here until 11d is measured and it moves to the Language row's edit.
      */}
      <Languages
        share={languages.share}
        systemLocale={languages.systemLocale}
        myLocale={languages.myLocale}
        storedLanguage={workspace?.languages[0] ?? null}
      />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.workspace');
