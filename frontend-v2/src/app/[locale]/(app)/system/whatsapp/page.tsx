import { getTranslations } from 'next-intl/server';

import { senderCanSend } from '@/api/contracts/platform-whatsapp';
import {
  loadPlatformSender,
  loadPlatformTemplates,
} from '@/features/console/platform-whatsapp/load-platform-whatsapp';
import { PlatformAlerts } from '@/features/console/platform-whatsapp/PlatformAlerts';
import { PlatformNumber } from '@/features/console/platform-whatsapp/PlatformNumber';
import { PlatformTemplates } from '@/features/console/platform-whatsapp/PlatformTemplates';
import { pageMetadata } from '@/shell/page-metadata';
import { requireConsole } from '@/shell/require-console';
import { SettingsSection } from '@/shell/SettingsSection';

import styles from '@/features/console/Console.module.css';
import pageStyles from '@/features/console/platform-whatsapp/PlatformWhatsApp.module.css';

/**
 * Console · GOTCHA's WhatsApp number (Omer, 2026-11-15): the platform alerts'
 * sender. Three parts on one page, read together: the number, its templates,
 * and which alerts go out. Each read that fails says so in its own place; a
 * failed read is never drawn as "nothing connected".
 */
export default async function Page() {
  await requireConsole();
  const [t, sender, templates] = await Promise.all([
    getTranslations('console.platformWhatsApp'),
    loadPlatformSender(),
    loadPlatformTemplates(),
  ]);
  const hasNumber =
    sender !== undefined && sender.status !== 'DISCONNECTED' && sender.number !== null;
  const canSend = sender !== undefined && senderCanSend(sender.status);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <div className={pageStyles.page}>
        {sender ? (
          <PlatformNumber sender={sender} />
        ) : (
          <p className={styles.notice} data-testid="platform-unread">
            {t('unread')}
          </p>
        )}
        {templates ? (
          <>
            <PlatformTemplates templates={templates} canSubmit={hasNumber} />
            <PlatformAlerts templates={templates} canSend={canSend} hasNumber={hasNumber} />
          </>
        ) : (
          <p className={styles.notice} data-testid="platform-templates-unread">
            {t('templates.unread')}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('sections.whatsapp', 'console');
