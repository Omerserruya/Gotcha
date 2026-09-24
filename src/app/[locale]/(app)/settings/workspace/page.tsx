import { getTranslations } from 'next-intl/server';

import { FactRows } from '@/features/workspace/FactRows';
import { FieldProvenance } from '@/features/workspace/FieldProvenance';
import { Languages } from '@/features/workspace/Languages';
import { ScanPanel } from '@/features/workspace/ScanPanel';
import { loadLanguages } from '@/features/workspace/load-languages';
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
  const [{ workspace, voice, claims }, languages] = await Promise.all([
    loadWorkspace(),
    loadLanguages(),
  ]);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {workspace ? <FactRows workspace={workspace} /> : <p>{t('unavailable')}</p>}
      {/*
        Screen 11b. Below the facts, because it is ABOUT them — a reader who
        meets the provenance badges before the values they describe has to
        hold both in their head to make sense of either.
      */}
      {workspace ? <FieldProvenance workspace={workspace} /> : null}
      {/*
        Screen 11b, UNDER the badges it acts on. A "Scan again" button above
        the account of what is marked would ask somebody to press it before
        they know what it will and will not touch.

        Beside FieldProvenance rather than inside it: this is a client
        component and that one is a server component, and nesting made the
        server component untestable — the same async-children lesson as
        screen 13's cards, in the other direction.
      */}
      {workspace ? <ScanPanel domain={workspace.websiteDomain ?? null} /> : null}
      {/* Screen 11d. Below the facts, because it explains the Language row. */}
      <Languages
        share={languages.share}
        systemLocale={languages.systemLocale}
        myLocale={languages.myLocale}
        storedLanguage={workspace?.languages[0] ?? null}
      />
      {voice ? <VoiceEditor voice={voice} /> : <p>{t('voice.unavailable')}</p>}
      {claims ? <ProhibitedClaims claims={claims.claims} /> : <p>{t('claims.unavailable')}</p>}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.workspace');
