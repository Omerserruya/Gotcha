import { getTranslations } from 'next-intl/server';

import { ChannelList } from '@/features/channels/ChannelList';
import { loadChannels } from '@/features/channels/load-channels';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Channels — screen 13.
 *
 * *"Where customers reach you. Connecting is a two-step task, not an
 * integration form."*
 *
 * The list first, and captured before any connect flow exists. Three things
 * the design draws are absent because nothing behind them can store a value —
 * a per-channel owner, a per-channel greeting and hours, and a Connect button
 * for phone calls. See `contracts/channels.ts`.
 */
export default async function Page() {
  const t = await getTranslations('channels');
  const { channels, windowDays } = await loadChannels();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {channels ? (
        <ChannelList channels={channels} windowDays={windowDays} />
      ) : (
        <p>{t('unavailable')}</p>
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.channels');
