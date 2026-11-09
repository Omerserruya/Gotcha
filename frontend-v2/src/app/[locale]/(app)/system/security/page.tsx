import { getTranslations } from 'next-intl/server';

import { ConsoleSecurity } from '@/features/console/ConsoleSecurity';
import { loadMySecurity } from '@/features/console/load-my-security';
import { authOrigin } from '@/shell/mfa/read-mfa-gate';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

/** Console · Security: the admin's own two-step sign-in (Omer, 2026-11-09). */
export default async function Page() {
  await requireConsole();
  const [t, security] = await Promise.all([getTranslations('console.security'), loadMySecurity()]);
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <ConsoleSecurity security={security} authOrigin={authOrigin()} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.security', 'console');
