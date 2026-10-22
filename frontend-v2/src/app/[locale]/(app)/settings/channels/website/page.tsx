import { getTranslations } from 'next-intl/server';

import { WEBCHAT_TABS, type WebchatTab } from '@/api/contracts/webchat';
import { asConfig } from '@/api/contracts/website-widget';
import { loadWebsiteWidget, loadWidgetAssignment } from '@/features/webchat/load-website-widget';
import { WebchatSettings } from '@/features/webchat/WebchatSettings';
import styles from '@/features/webchat/Webchat.module.css';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * 13g-13j - Settings · Channels · Website widget, one tab at a time (`?tab=`).
 * One widget for the workspace (website-widget-v1): the web chat and the
 * Shopify live chat, set up here once and installed in many places.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly tab?: string }>;
}) {
  const t = await getTranslations('channels.webchat');
  const asked = (await searchParams)?.tab;
  const tab: WebchatTab = WEBCHAT_TABS.find((name) => name === asked) ?? 'appearance';
  const [read, assignment] = await Promise.all([
    loadWebsiteWidget({ installTab: tab === 'install' }),
    // Who answers (§4): its card is on the Conversation tab only.
    tab === 'conversation' ? loadWidgetAssignment() : Promise.resolve(null),
  ]);

  if (read.widget === null) {
    return (
      <div className={styles.page}>
        <p className={styles.rowHint} role="status" data-testid="webchat-unread">
          {t('unread')}
        </p>
      </div>
    );
  }
  return (
    <WebchatSettings
      initial={asConfig(read.widget.settings)}
      assigned={read.widget.assignedEmployee}
      install={read.install}
      shopifyData={read.shopifyData}
      shopifyAvailability={read.shopifyAvailability}
      business={read.business}
      website={read.website}
      tab={tab}
      // Stage B's numbers - absent from a stage A service, which keeps its parts unavailable.
      handoffNumbers={read.widget.whatsappNumbers ?? null}
      assignment={assignment}
    />
  );
}

export const generateMetadata = pageMetadata('settings.channels');
