import { MessageCircle } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { WIDGET_PATH } from '@/api/contracts/website-widget';
import { numberCount } from '@/api/contracts/whatsapp-numbers';

import { ChannelList } from '@/features/channels/ChannelList';
import channelStyles from '@/features/channels/Channels.module.css';
import {
  ChatsPanel,
  ImportPanel,
  LearningRow,
  ProfilesPanel,
  ReportPanel,
} from '@/features/channels/LearnPanels';
import { loadChannels } from '@/features/channels/load-channels';
import {
  loadEvidence,
  loadExclusions,
  loadHistoryImport,
  loadImportedThread,
  loadProfilePreview,
  loadChannelsConfig,
  loadNumberEvents,
  loadWhatsAppNumbers,
} from '@/features/channels/load-whatsapp';
import { tabOf } from '@/features/channels/whatsapp-tabs';
import { ActivityTab, ContactsTab, TemplatesTab } from '@/features/channels/WhatsAppTabContent';
import { loadTemplates } from '@/features/outreach/load-templates';
import { ChannelLanding } from '@/features/channels/ChannelLanding';
import { ConnectWhatsApp } from '@/features/channels/ConnectWhatsApp';
import { channelLandingOf } from '@/features/channels/landing';
import { WhatsAppNumbers } from '@/features/channels/WhatsAppNumbers';
import { WhatsAppPanel } from '@/features/channels/WhatsAppPanel';
import { loadWidgetInstall } from '@/features/webchat/load-website-widget';
import { redirect } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';
import { Drawer } from '@/shell/Drawer';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Channels - screen 13.
 *
 * *"Where customers reach you. Connecting is a two-step task, not an
 * integration form."*
 *
 * The list first, and captured before any connect flow exists. Three things
 * the design draws are absent because nothing behind them can store a value -
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
    /** 13f's "See the chats": which suggestion, and which of its chats is open. */
    readonly candidate?: string;
    readonly conversation?: string;
    /** The way back from a channel's provider (backend ecd64c4d). */
    readonly connected?: string;
    readonly count?: string;
    readonly pending?: string;
    readonly platform?: string;
    readonly error?: string;
    readonly tab?: string;
    /** The web chat's old embed link: its code is the widget's Install tab now. */
    readonly embed?: string;
  }>;
} = {}) {
  const t = await getTranslations('channels');
  const tw = await getTranslations('channels.whatsapp');
  const params = (await searchParams) ?? {};
  if (params.embed) {
    redirect({
      href: { pathname: WIDGET_PATH, query: { tab: 'install' } },
      locale: await getLocale(),
    });
  }
  const landing = channelLandingOf(params);
  const panel = params.panel === 'whatsapp';
  const [{ channels, voice, voiceOffered, windowDays }, whatsapp, config, install] =
    await Promise.all([
      loadChannels(),
      // 13b's reads only when its panel is open.
      panel
        ? Promise.all([loadWhatsAppNumbers(), loadHistoryImport(params.import)])
        : Promise.resolve(null),
      // 13c's launches and which providers are set up: one read, every view.
      loadChannelsConfig(),
      // The Website widget's one row: live or not is where it is installed.
      loadWidgetInstall(),
    ]);
  const learn = whatsapp?.[1].status ?? null;
  const first = whatsapp?.[0]?.data[0] ?? null;
  // Dev's one number is unprofiled: its name is on that list, not on `data`.
  const unprofiled = whatsapp?.[0]?.unprofiled[0] ?? null;
  const name = first?.name ?? unprofiled?.name ?? first?.phoneNumber ?? tw('panelTitle');
  // The number. Who answers is the automations' to say, not the channel's.
  const learnLine = first?.phoneNumber ?? unprofiled?.phoneNumber ?? undefined;
  const tile = (
    <span className={channelStyles.learnTile} aria-hidden="true">
      <MessageCircle size={20} strokeWidth={1.75} />
    </span>
  );
  /*
    13e / 13f replace 13b while one is open - the same drawer shell, their
    own head. A view with no import to show falls back to 13b.
  */
  // 13f's "See the chats": the suggestion must be one of this import's.
  const asked =
    learn && params.view === 'chats' && params.candidate
      ? (whatsapp?.[1].candidates?.find((c) => c.id === params.candidate) ?? null)
      : null;
  const view =
    params.view === 'connect' && whatsapp
      ? 'connect'
      : asked
        ? 'chats'
        : learn && params.view === 'profiles'
          ? 'profiles'
          : learn && params.view === 'report' && whatsapp?.[1].candidates
            ? 'report'
            : learn && params.view === 'progress'
              ? 'progress'
              : null;
  // 13b's open tab (`?tab=`), when 13b itself is what is open.
  const panelTab = tabOf(view === null ? params.tab : undefined);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {/* Always mounted: after the URL is tidied its sentence must stay. */}
      <ChannelLanding landing={landing} />
      {channels ? (
        <ChannelList
          channels={channels}
          voice={voice}
          voiceOffered={voiceOffered}
          windowDays={windowDays}
          providers={config.providers}
          install={install}
        />
      ) : (
        <p>{t('unavailable')}</p>
      )}

      {/*
        13b: WhatsApp's settings as a panel OVER this page (`?panel=whatsapp`),
        not a page of its own - reached from the WhatsApp row's "Settings".
      */}
      {view === 'connect' && whatsapp ? (
        // 13c → 13d: Connect WhatsApp, one sheet, four steps.
        <Drawer
          title={tw('wizard.title')}
          line={tw('wizard.line')}
          lead={tile}
          closeHref="/settings/channels?panel=whatsapp"
          width={600}
          testId="drawer-connect"
        >
          <ConnectWhatsApp
            launches={config.launches}
            closeHref="/settings/channels?panel=whatsapp"
          />
        </Drawer>
      ) : view === 'progress' && learn ? (
        <Drawer
          title={tw('learn.setting', { name })}
          line={learnLine}
          lead={tile}
          closeHref="/settings/channels?panel=whatsapp"
          width={600}
          testId="drawer-import"
        >
          <ImportPanel
            status={learn}
            receiving={first?.health?.receiving === true}
            coexistence={first?.usesBusinessApp === true}
          />
        </Drawer>
      ) : view === 'profiles' && learn ? (
        <Drawer
          title={tw('profiles.title')}
          line={tw('learn.nothingUsed')}
          lead={tile}
          closeHref="/settings/channels?panel=whatsapp"
          width={860}
          testId="drawer-profiles"
        >
          <ProfilesPanel status={learn} profiles={await loadProfilePreview(learn.id)} />
        </Drawer>
      ) : view === 'chats' && learn && asked ? (
        <Drawer
          title={tw('chats.title')}
          line={tw('learn.nothingUsed')}
          lead={tile}
          closeHref="/settings/channels?panel=whatsapp"
          width={860}
          testId="drawer-chats"
        >
          <ChatsPanel
            status={learn}
            candidate={asked}
            evidence={await loadEvidence(asked.id)}
            open={params.conversation ?? null}
            thread={params.conversation ? await loadImportedThread(params.conversation) : null}
          />
        </Drawer>
      ) : view === 'report' && learn && whatsapp?.[1].candidates ? (
        <Drawer
          title={tw('learn.learned', { name })}
          line={tw('learn.nothingUsed')}
          lead={tile}
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
          tab={panelTab}
          numbers={(whatsapp[0]?.data ?? []).map((n) => ({ id: n.id, phoneNumber: n.phoneNumber }))}
          unprofiled={(whatsapp[0]?.unprofiled ?? []).map((u) => u.channelAccountId)}
        >
          {panelTab === 'templates' ? (
            <TemplatesTab templates={(await loadTemplates()).templates} />
          ) : panelTab === 'contacts' ? (
            <ContactsTab
              exclusions={await loadExclusions()}
              // Every number a rule can be on: profiled ones with a channel account, and
              // dev's unprofiled one (a channel account and nothing else).
              numbers={[
                ...(whatsapp[0]?.data ?? []).flatMap((n) =>
                  n.channelAccountId
                    ? [{ id: n.channelAccountId, label: n.phoneNumber ?? n.name ?? tw('aNumber') }]
                    : [],
                ),
                ...(whatsapp[0]?.unprofiled ?? []).map((u) => ({
                  id: u.channelAccountId,
                  label: u.phoneNumber ?? u.name ?? tw('aNumber'),
                })),
              ]}
            />
          ) : panelTab === 'activity' ? (
            <ActivityTab events={await loadNumberEvents(whatsapp[0]?.data ?? [])} />
          ) : (
            <>
              <WhatsAppNumbers
                numbers={whatsapp[0]}
                connectable={
                  config.launches.coexistence?.configured === true ||
                  config.launches.newNumber?.configured === true
                }
              />
              {/* 13e / 13f are reached from here, while there is an import. */}
              {learn ? <LearningRow status={learn} /> : null}
            </>
          )}
        </WhatsAppPanel>
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.channels');
