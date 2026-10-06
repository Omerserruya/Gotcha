import { getTranslations } from 'next-intl/server';

import { WEBCHAT_TABS, type WebchatTab } from '@/api/contracts/webchat';
import { loadWebchat } from '@/features/webchat/load-webchat';
import { WebchatSettings } from '@/features/webchat/WebchatSettings';
import styles from '@/features/webchat/Webchat.module.css';
import { pageMetadata } from '@/shell/page-metadata';

/** 13g-13j - Settings · Channels · Web chat, one tab at a time (`?tab=`). */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<{ readonly tab?: string }>;
}) {
  const t = await getTranslations('channels.webchat');
  const { id } = await params;
  const asked = (await searchParams)?.tab;
  const tab: WebchatTab = WEBCHAT_TABS.find((name) => name === asked) ?? 'appearance';
  const read = await loadWebchat(id);

  if (read.config === null) {
    return (
      <div className={styles.page}>
        <p className={styles.rowHint} role="status" data-testid="webchat-unread">
          {read.missing ? t('notFound') : t('unread')}
        </p>
      </div>
    );
  }
  return (
    <WebchatSettings
      // A new widget is a new editor: its saving state is not carried across.
      key={id}
      id={id}
      initial={read.config}
      widget={read.widget}
      employees={read.employees}
      business={read.business}
      tab={tab}
    />
  );
}

export const generateMetadata = pageMetadata('settings.channels');
