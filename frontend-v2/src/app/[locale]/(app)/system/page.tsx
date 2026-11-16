import { getTranslations } from 'next-intl/server';

import { ConsoleHome } from '@/shell/ConsoleHome';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * The console's home: what it is, and the sections that exist - each a link
 * with one line on what it is for. Legacy's dashboard of platform figures
 * (`/api/system/stats`) is not here yet.
 */
export default async function Page() {
  // The layout draws the unread state; the page reads nothing behind it.
  if ((await requireConsole()) !== 'open') return null;
  const t = await getTranslations('console.home');
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <ConsoleHome />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('console');
