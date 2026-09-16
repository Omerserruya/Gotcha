import { getTranslations } from 'next-intl/server';

import { FactRows } from '@/features/workspace/FactRows';
import { loadWorkspace } from '@/features/workspace/load-workspace';
import { ProhibitedClaims } from '@/features/workspace/ProhibitedClaims';
import { VoiceEditor } from '@/features/workspace/VoiceEditor';
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
  const { workspace, voice, claims } = await loadWorkspace();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {workspace ? <FactRows workspace={workspace} /> : <p>{t('unavailable')}</p>}
      {voice ? <VoiceEditor voice={voice} /> : <p>{t('voice.unavailable')}</p>}
      {claims ? <ProhibitedClaims claims={claims.claims} /> : <p>{t('claims.unavailable')}</p>}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.workspace');
