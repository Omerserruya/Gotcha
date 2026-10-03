import { getTranslations } from 'next-intl/server';

import { pageMetadata } from '@/shell/page-metadata';
import styles from '@/shell/SettingsSection.module.css';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · developer.
 *
 * The section's frame is real - title, description and the sidebar entry that
 * reaches it. The content is built section by section against what the backend
 * serves; see docs/settings-contract.md for which parts are blocked and why.
 */
export default async function Page() {
  const t = await getTranslations('navigation');
  return (
    <SettingsSection
      title={t('settings.developer')}
      description={t('settingsDescription.developer')}
      actions={
        // 02's "Read the docs ↗". No developer documentation is published, so
        // it is drawn and says so rather than linking nowhere.
        <span
          className={styles.actionQuiet}
          aria-disabled="true"
          title={t('settingsDocsNone')}
          data-testid="developer-docs"
        >
          {t('settingsDocs')}
        </span>
      }
    />
  );
}

export const generateMetadata = pageMetadata('settings.developer');
