import { getTranslations } from 'next-intl/server';

import { ChannelList } from '@/features/channels/ChannelList';
import { ImportProgress } from '@/features/channels/ImportProgress';
import { KnowledgeReview } from '@/features/channels/KnowledgeReview';
import { loadChannels } from '@/features/channels/load-channels';
import { loadHistoryImport, loadWhatsAppNumbers } from '@/features/channels/load-whatsapp';
import { WhatsAppNumbers } from '@/features/channels/WhatsAppNumbers';
import { WhatsAppPanel } from '@/features/channels/WhatsAppPanel';
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
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly panel?: string }>;
} = {}) {
  const t = await getTranslations('channels');
  const tw = await getTranslations('channels.whatsapp');
  const panel = (await searchParams)?.panel === 'whatsapp';
  const [{ channels, voice, voiceOffered, windowDays }, whatsapp] = await Promise.all([
    loadChannels(),
    // 13b's reads only when its panel is open.
    panel ? Promise.all([loadWhatsAppNumbers(), loadHistoryImport()]) : Promise.resolve(null),
  ]);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {channels ? (
        <ChannelList
          channels={channels}
          voice={voice}
          voiceOffered={voiceOffered}
          windowDays={windowDays}
        />
      ) : (
        <p>{t('unavailable')}</p>
      )}

      {/*
        13b: WhatsApp's settings as a panel OVER this page (`?panel=whatsapp`),
        not a page of its own — reached from the WhatsApp row's "Settings".
      */}
      {whatsapp ? (
        <WhatsAppPanel
          line={
            whatsapp[0] ? tw('panelLine', { count: whatsapp[0].data.length }) : tw('description')
          }
        >
          <WhatsAppNumbers numbers={whatsapp[0]} />
          {/* Only when there is an import to report on — see ImportProgress. */}
          {whatsapp[1].status !== null ? <ImportProgress status={whatsapp[1].status} /> : null}
          {/*
            13f. The suggestions belong to an IMPORT; `candidates === null` is a
            failed read and the panel is withheld rather than shown empty. The
            server's floor passes through UNDEFAULTED — `?? 0` would pass every
            confidence.
          */}
          {whatsapp[1].status !== null && whatsapp[1].candidates !== null ? (
            <KnowledgeReview
              candidates={whatsapp[1].candidates}
              bulkMinConfidence={whatsapp[1].bulkMinConfidence}
            />
          ) : null}
        </WhatsAppPanel>
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.channels');
