import { getTranslations } from 'next-intl/server';

import { loadSignUpSettings } from '@/features/console/load-signup-settings';
import { SignUpSettings } from '@/features/console/SignUpSettings';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

/** Self sign-up's switch and trial (Omer, 2026-11-22). System admins only, as every console page. */
export default async function Page() {
  // The layout draws the unread state; the page reads nothing behind it.
  if ((await requireConsole()) !== 'open') return null;
  const [t, settings] = await Promise.all([
    getTranslations('console.signup'),
    loadSignUpSettings(),
  ]);
  return (
    <SettingsSection title={t('pageTitle')} description={t('description')}>
      <SignUpSettings settings={settings} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.signup', 'console');
