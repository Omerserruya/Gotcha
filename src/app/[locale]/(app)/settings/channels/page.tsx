import { getTranslations } from 'next-intl/server';

import { numberCount } from '@/api/contracts/whatsapp-numbers';

import { ChannelList } from '@/features/channels/ChannelList';
import { ImportPanel, LearningRow, ReportPanel } from '@/features/channels/LearnPanels';
import { loadChannels } from '@/features/channels/load-channels';
import { loadHistoryImport, loadWhatsAppNumbers } from '@/features/channels/load-whatsapp';
import { WhatsAppNumbers } from '@/features/channels/WhatsAppNumbers';
import { WhatsAppPanel } from '@/features/channels/WhatsAppPanel';
import { pageMetadata } from '@/shell/page-metadata';
import { Drawer } from '@/shell/Drawer';
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
  readonly searchParams?: Promise<{
    readonly panel?: string;
    /** 13e / 13f: which import, and which view of it. */
    readonly import?: string;
    readonly view?: string;
    readonly tab?: string;
  }>;
} = {}) {
  const t = await getTranslations('channels');
  const tw = await getTranslations('channels.whatsapp');
  const params = (await searchParams) ?? {};
  const panel = params.panel === 'whatsapp';
  const [{ channels, voice, voiceOffered, windowDays }, whatsapp] = await Promise.all([
    loadChannels(),
    // 13b's reads only when its panel is open.
    panel
      ? Promise.all([loadWhatsAppNumbers(), loadHistoryImport(params.import)])
      : Promise.resolve(null),
  ]);
  const learn = whatsapp?.[1].status ?? null;
  const first = whatsapp?.[0]?.data[0] ?? null;
  const name = first?.name ?? first?.phoneNumber ?? tw('panelTitle');
  /*
    13e / 13f replace 13b while one is open — the same drawer shell, their
    own head. A view with no import to show falls back to 13b.
  */
  const view =
    learn && params.view === 'report' && whatsapp?.[1].candidates
      ? 'report'
      : learn && params.view === 'progress'
        ? 'progress'
        : null;

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
      {view === 'progress' && learn ? (
        <Drawer
          title={tw('learn.setting', { name })}
          line={first?.phoneNumber ?? undefined}
          closeHref="/settings/channels?panel=whatsapp"
          width={600}
          testId="drawer-import"
        >
          <ImportPanel status={learn} receiving={first?.health?.receiving === true} />
        </Drawer>
      ) : view === 'report' && learn && whatsapp?.[1].candidates ? (
        <Drawer
          title={tw('learn.learned', { name })}
          line={tw('learn.nothingUsed')}
          closeHref="/settings/channels?panel=whatsapp"
          width={860}
          testId="drawer-report"
        >
          <ReportPanel
            status={learn}
            candidates={whatsapp[1].candidates}
            bulkMinConfidence={whatsapp[1].bulkMinConfidence}
            tab={params.tab}
          />
        </Drawer>
      ) : null}

      {whatsapp && view === null ? (
        <WhatsAppPanel
          line={
            whatsapp[0] ? tw('panelLine', { count: numberCount(whatsapp[0]) }) : tw('description')
          }
        >
          <WhatsAppNumbers
            numbers={whatsapp[0]}
            responseModes={Object.fromEntries(
              (channels ?? [])
                .filter((channel) => channel.channel === 'WHATSAPP')
                .map((channel) => [channel.id, channel.responseMode]),
            )}
          />
          {/* 13e / 13f are reached from here, while there is an import. */}
          {learn ? <LearningRow status={learn} /> : null}
        </WhatsAppPanel>
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.channels');
