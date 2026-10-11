import { AlertTriangle } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import {
  OAUTH_PLATFORMS,
  type Channel,
  type ChannelType,
  type VoiceChannel,
} from '@/api/contracts/channels';

import styles from './Channels.module.css';
import { ChannelTile } from './ChannelTile';
import { ConnectableRow } from './ConnectableRow';
import { DisconnectChannel } from './DisconnectChannel';
import { ReconnectChannel } from './ReconnectChannel';
import {
  buildChannelRows,
  canDisconnect,
  isTroubled,
  needsReconnect,
  type ChannelRow,
  type ConnectedRow,
  type WidgetRow,
} from './rows';
import { channelName } from '@/api/contracts/inbox';
import type { ChannelErrorReason } from '@/api/contracts/platform-errors';
import {
  WIDGET_CHANNELS,
  WIDGET_PATH,
  isLive,
  type WidgetInstall,
} from '@/api/contracts/website-widget';
import { UnavailableStatus } from '@/design-system/primitives/unavailable/Unavailable';
import rowLink from '@/design-system/styles/row-link.module.css';
import { Link } from '@/i18n/navigation';

/**
 * *"Each channel shows its identity and its real volume, so the list doubles
 * as a health check."*
 *
 * A server component: the whole list is read-only, and `GET /api/channels`
 * carries a `platformMeta` blob that has no business in a browser payload even
 * though the contract already strips it.
 *
 * The volume number is the reason this is a health check rather than a
 * settings list - so when it could not be loaded the row says nothing rather
 * than showing a zero. "No conversations" and "we could not ask" are different
 * facts and only one of them is reassuring.
 */
export async function ChannelList({
  channels,
  voice,
  voiceOffered,
  windowDays,
  providers = null,
  install = null,
}: {
  readonly channels: readonly Channel[];
  readonly voice: readonly VoiceChannel[];
  readonly voiceOffered: boolean;
  readonly windowDays: number;
  /** Which OAuth providers are set up (`/api/channels/config`); `null` when unread. */
  readonly providers?: Readonly<Record<string, boolean>> | null;
  /** Where the Website widget is installed; `null` when unread. */
  readonly install?: WidgetInstall | null;
}) {
  const t = await getTranslations('channels');
  // The platform's error in the reader's words - never its raw English.
  const tp = await getTranslations('common.platformError');
  const errorWords = (reason: ChannelErrorReason | null) => (reason ? tp(reason) : null);
  const locale = await getLocale();
  const rows = buildChannelRows(channels, voice, voiceOffered, locale);
  const number = new Intl.NumberFormat(locale);

  /**
   * The line under the name: identity, then the two numbers.
   *
   * "12 open now · 1,480 started in the last 30 days" - the snapshot for
   * triage and the window for health.
   *
   * The two are DIFFERENT MEASURES and the copy says so. One is open right
   * now, whatever it started; the other is what arrived in the window,
   * whatever its status. Captioning them as one measure at two zoom levels
   * would be wrong - a conversation running since August is in neither the
   * September window nor, if it closed, the open count.
   *
   * The window is NAMED, never called "this week" over a longer figure: a
   * number that silently changes meaning is worse than one that is wider than
   * you expected.
   */
  const detail = (row: ConnectedRow): string => {
    const parts: string[] = [];
    if (row.identity) parts.push(row.identity);
    if (row.openConversations != null) {
      parts.push(t('openNow', { count: row.openConversations }));
    }
    if (row.windowConversations != null) {
      parts.push(
        t('inWindow', { count: number.format(row.windowConversations), days: windowDays }),
      );
    }
    return parts.join(' · ');
  };
  const troubledRows = rows
    .flatMap((row): readonly ChannelRow[] => (row.kind === 'widget' ? row.parts : [row]))
    .filter((row): row is ConnectedRow => row.kind === 'connected' && isTroubled(row));
  /** A widget part is named as the widget: there is no "Shopify live chat" any more. */
  const nameOf = (channel: ChannelType) =>
    (WIDGET_CHANNELS as readonly ChannelType[]).includes(channel)
      ? t('widgetRow.name')
      : (channelName(channel, t) ?? t('name.other'));

  return (
    <>
      {/*
        02's warning above the list: the channel that needs attention, in the
        platform's own words - one banner, the first that is troubled; the
        rest still say so on their rows.
      */}
      {troubledRows[0] ? (
        <section className={styles.banner} data-testid="channel-banner">
          <AlertTriangle className={styles.bannerIcon} size={18} aria-hidden="true" />
          <span className={styles.bannerText}>
            <span className={styles.bannerTitle}>
              {t('banner.title', { channel: nameOf(troubledRows[0].channel) })}
            </span>
            <span className={styles.bannerBody}>
              {errorWords(troubledRows[0].error) ??
                t(`status.${troubledRows[0].status}` as 'status.CONNECTED')}
            </span>
          </span>
          {troubledRows.length > 1 ? (
            <span className={styles.bannerMore}>
              {t('banner.more', { count: troubledRows.length - 1 })}
            </span>
          ) : null}
        </section>
      ) : null}
      <ul className={styles.list} data-testid="channel-list">
        {rows.map((row) => {
          if (row.kind === 'widget') {
            return (
              <WidgetListRow
                key="widget"
                row={row}
                errorWords={errorWords}
                install={install}
                t={t}
                number={number}
                windowDays={windowDays}
              />
            );
          }
          if (row.kind === 'connectable') {
            // The one interactive row, and the only client component here.
            return (
              <ConnectableRow
                key={`connectable:${row.channel}`}
                channel={row.channel}
                notSetUp={notSetUp(row.channel, providers)}
              />
            );
          }

          const troubled = isTroubled(row);
          /*
            WhatsApp's whole row opens its Settings. A row whose action is
            Disconnect stays as it is: a click anywhere on a row must never
            start taking a channel down.
          */
          const opens = row.channel === 'WHATSAPP';
          return (
            <li
              key={row.id}
              className={[styles.row, opens ? rowLink.row : ''].join(' ').trim()}
              data-testid={`channel-${row.id}`}
              data-kind="connected"
              data-troubled={troubled ? 'yes' : 'no'}
            >
              <ChannelTile channel={row.channel} />
              <div className={styles.identity}>
                {/*
                ★★ THIS HAD NO FALLBACK AT ALL. A channel absent from
                `channels.json` rendered `name.TELEGRAM` - the KEY, not even the
                enum - because next-intl returns the key it could not resolve.
                The other nine sites at least degraded to the platform's word.
              */}
                <span className={styles.name}>
                  {channelName(row.channel, t) ?? t('name.other')}
                </span>
                <span className={styles.detail} data-testid={`channel-detail-${row.id}`}>
                  {detail(row)}
                </span>
              </div>

              <span
                className={[
                  styles.status,
                  troubled ? styles.statusTroubled : styles.statusGood,
                  // Above the row's link while it carries words on its `title`.
                  opens && row.error ? rowLink.above : '',
                ]
                  .join(' ')
                  .trim()}
                data-testid={`channel-status-${row.id}`}
                // The platform's own words, on the state they explain; the banner
                // above tells the first of them out loud.
                title={errorWords(row.error) ?? undefined}
              >
                {/* A broken connection is not "Connected", in any colour. */}
                {troubled ? t('chipTrouble') : t(`status.${row.status}` as 'status.CONNECTED')}
              </span>

              {/* 02's "Settings" on the row: WhatsApp's numbers, health and repairs (13b). */}
              {opens ? (
                <Link
                  href={{ pathname: '/settings/channels', query: { panel: 'whatsapp' } }}
                  className={`${styles.settingsLink} ${rowLink.link}`}
                  data-testid={`channel-settings-${row.id}`}
                >
                  {t('rowSettings')}
                </Link>
              ) : canDisconnect(row) ? (
                /*
                  Disconnect, after a confirmation in the channel's name
                  (POST /api/channels/:id/disconnect; conversations are kept).
                  Reconnect beside it when messages cannot arrive.
                */
                <span className={styles.rowActions}>
                  {needsReconnect(row) ? (
                    <ReconnectChannel
                      id={row.id}
                      channel={row.channel}
                      name={channelName(row.channel, t) ?? t('name.other')}
                    />
                  ) : null}
                  <DisconnectChannel
                    id={row.id}
                    name={channelName(row.channel, t) ?? t('name.other')}
                    identity={row.identity}
                  />
                </span>
              ) : (
                /*
                  Nothing to set (checked 2026-10-08): the platform's only
                  channel settings are WhatsApp's numbers and the web chat's
                  widget - for Instagram, Messenger, email and the rest it has
                  connect, disconnect and a status read, no setting. A status,
                  saying so - never a panel of things that write nowhere.
                */
                <UnavailableStatus
                  tag={t('rowSettingsNone.tag')}
                  why={t('rowSettingsNone.why')}
                  testid={`channel-settings-${row.id}`}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * The Website widget's one row: where it is installed, how much it carries,
 * and whether it is live - the installs' to say. Unread installs fall back to
 * the accounts' own status; a troubled account is "Needs attention" in its
 * platform's words, as any row.
 */
function WidgetListRow({
  row,
  errorWords,
  install,
  t,
  number,
  windowDays,
}: {
  readonly row: WidgetRow;
  readonly install: WidgetInstall | null;
  readonly t: Awaited<ReturnType<typeof getTranslations<'channels'>>>;
  readonly errorWords: (reason: ChannelErrorReason | null) => string | null;
  readonly number: Intl.NumberFormat;
  readonly windowDays: number;
}) {
  const troubled = row.parts.find(isTroubled) ?? null;
  const sum = (pick: (part: ConnectedRow) => number | null) => {
    const known = row.parts.map(pick).filter((n): n is number => n != null);
    return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
  };
  const open = sum((part) => part.openConversations);
  const started = sum((part) => part.windowConversations);
  /*
    Where it runs: each shop by its domain, then the site the code was last
    seen on - both the installs' to say. Never the accounts' names: dev's
    Shopify account is called "Shopify Live Chat", the product that is gone.
  */
  const places = [
    ...(install?.shopify.map((shop) => shop.shopDomain) ?? []),
    install?.code?.lastHost ?? null,
  ].filter((place): place is string => Boolean(place));
  const detail =
    row.parts.length === 0
      ? t('widgetRow.nowhere')
      : [
          ...places,
          ...(open != null ? [t('openNow', { count: open })] : []),
          ...(started != null
            ? [t('inWindow', { count: number.format(started), days: windowDays })]
            : []),
        ].join(' · ');
  const live = row.parts.length === 0 ? false : install ? isLive(install) : null;
  return (
    <li
      // The whole row opens the widget's settings.
      className={`${styles.row} ${rowLink.row}`}
      data-testid="channel-widget"
      data-kind="widget"
      data-troubled={troubled ? 'yes' : 'no'}
    >
      <ChannelTile channel="WEBCHAT" />
      <div className={styles.identity}>
        <span className={styles.name}>{t('widgetRow.name')}</span>
        <span className={styles.detail} data-testid="channel-detail-widget">
          {detail}
        </span>
      </div>
      <span
        className={[
          styles.status,
          // Not live yet is a step to take, not a fault: neither green nor alarmed.
          troubled ? styles.statusTroubled : live === false ? '' : styles.statusGood,
          // Above the row's link while it carries words on its `title`.
          troubled?.error ? rowLink.above : '',
        ]
          .join(' ')
          .trim()}
        data-testid="channel-status-widget"
        title={errorWords(troubled?.error ?? null) ?? undefined}
      >
        {troubled
          ? t('chipTrouble')
          : live === null
            ? t(
                `status.${row.parts.some((p) => p.status === 'CONNECTED') ? 'CONNECTED' : (row.parts[0]?.status ?? 'PENDING')}` as 'status.CONNECTED',
              )
            : live
              ? t('webchat.live')
              : t('webchat.notLive')}
      </span>
      <Link
        href={WIDGET_PATH}
        className={`${styles.settingsLink} ${rowLink.link}`}
        data-testid="channel-settings-widget"
      >
        {t('rowSettings')}
      </Link>
    </li>
  );
}

/**
 * A provider whose app credentials are absent can never complete OAuth - drawn
 * "not set up" from the start, not a Connect that dead-ends. Unread: live.
 */
function notSetUp(
  channel: ChannelType,
  providers: Readonly<Record<string, boolean>> | null,
): boolean {
  const platform = (OAUTH_PLATFORMS as Partial<Record<ChannelType, string>>)[channel];
  return platform !== undefined && providers?.[platform] === false;
}
