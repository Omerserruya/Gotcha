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
import { WebChatEmbed } from './WebChatEmbed';
import { buildChannelRows, isTroubled, type ConnectedRow } from './rows';
import { channelName } from '@/api/contracts/inbox';
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
 * settings list — so when it could not be loaded the row says nothing rather
 * than showing a zero. "No conversations" and "we could not ask" are different
 * facts and only one of them is reassuring.
 */
export async function ChannelList({
  channels,
  voice,
  voiceOffered,
  windowDays,
  providers = null,
  embed = null,
}: {
  readonly channels: readonly Channel[];
  readonly voice: readonly VoiceChannel[];
  readonly voiceOffered: boolean;
  readonly windowDays: number;
  /** Which OAuth providers are set up (`/api/channels/config`); `null` when unread. */
  readonly providers?: Readonly<Record<string, boolean>> | null;
  /** The web chat whose embed code is open (`?embed=<id>`). */
  readonly embed?: string | null;
}) {
  const t = await getTranslations('channels');
  const locale = await getLocale();
  const rows = buildChannelRows(channels, voice, voiceOffered, locale);
  const number = new Intl.NumberFormat(locale);

  /**
   * The line under the name: identity, then the two numbers.
   *
   * "12 open now · 1,480 started in the last 30 days" — the snapshot for
   * triage and the window for health.
   *
   * The two are DIFFERENT MEASURES and the copy says so. One is open right
   * now, whatever it started; the other is what arrived in the window,
   * whatever its status. Captioning them as one measure at two zoom levels
   * would be wrong — a conversation running since August is in neither the
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
    // Who answers it — the one routing a channel stores — at the line's end,
    // where 02 has no column for it.
    if (row.responseMode) parts.push(t(`mode.${row.responseMode}` as 'mode.AI_AUTO_REPLY'));
    return parts.join(' · ');
  };
  const troubledRows = rows.filter(
    (row): row is ConnectedRow => row.kind === 'connected' && isTroubled(row),
  );

  return (
    <>
      {/*
        02's warning above the list: the channel that needs attention, in the
        platform's own words — one banner, the first that is troubled; the
        rest still say so on their rows.
      */}
      {troubledRows[0] ? (
        <section className={styles.banner} data-testid="channel-banner">
          <AlertTriangle className={styles.bannerIcon} size={18} aria-hidden="true" />
          <span className={styles.bannerText}>
            <span className={styles.bannerTitle}>
              {t('banner.title', {
                channel: channelName(troubledRows[0].channel, t) ?? t('name.other'),
              })}
            </span>
            <span className={styles.bannerBody}>
              {troubledRows[0].error ?? t(`status.${troubledRows[0].status}` as 'status.CONNECTED')}
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
          return (
            <li
              key={row.id}
              className={
                row.channel === 'WEBCHAT' && embed === row.id
                  ? `${styles.row} ${styles.rowWithEmbed}`
                  : styles.row
              }
              data-testid={`channel-${row.id}`}
              data-kind="connected"
              data-troubled={troubled ? 'yes' : 'no'}
            >
              <ChannelTile channel={row.channel} />
              <div className={styles.identity}>
                {/*
                ★★ THIS HAD NO FALLBACK AT ALL. A channel absent from
                `channels.json` rendered `name.TELEGRAM` — the KEY, not even the
                enum — because next-intl returns the key it could not resolve.
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
                className={[styles.status, troubled ? styles.statusTroubled : styles.statusGood]
                  .join(' ')
                  .trim()}
                data-testid={`channel-status-${row.id}`}
                // The platform's own words, on the state they explain; the banner
                // above tells the first of them out loud.
                title={row.error ?? undefined}
              >
                {/* A broken connection is not "Connected", in any colour. */}
                {troubled ? t('chipTrouble') : t(`status.${row.status}` as 'status.CONNECTED')}
              </span>

              {/* 02's "Settings" on the row: WhatsApp's numbers, health and repairs (13b). */}
              {row.channel === 'WEBCHAT' && row.widgetId ? (
                // Web chat's settings are its embed code — reachable any time after Create.
                <Link
                  href={
                    embed === row.id
                      ? '/settings/channels'
                      : { pathname: '/settings/channels', query: { embed: row.id } }
                  }
                  className={styles.settingsLink}
                  aria-expanded={embed === row.id}
                  data-testid={`channel-settings-${row.id}`}
                  scroll={false}
                >
                  {t('rowSettings')}
                </Link>
              ) : row.channel === 'WHATSAPP' ? (
                <Link
                  href={{ pathname: '/settings/channels', query: { panel: 'whatsapp' } }}
                  className={styles.settingsLink}
                  data-testid={`channel-settings-${row.id}`}
                >
                  {t('rowSettings')}
                </Link>
              ) : (
                // Only WhatsApp has a settings panel (13b) yet: drawn, and it says so.
                <span
                  className={styles.settingsLink}
                  aria-disabled="true"
                  title={t('rowSettingsNotYet')}
                  data-testid={`channel-settings-${row.id}`}
                >
                  {t('rowSettings')}
                </span>
              )}
              {row.channel === 'WEBCHAT' && row.widgetId && embed === row.id ? (
                <div className={styles.embedRow}>
                  <WebChatEmbed widgetId={row.widgetId} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * A provider whose app credentials are absent can never complete OAuth — drawn
 * "not set up" from the start, not a Connect that dead-ends. Unread: live.
 */
function notSetUp(
  channel: ChannelType,
  providers: Readonly<Record<string, boolean>> | null,
): boolean {
  const platform = (OAUTH_PLATFORMS as Partial<Record<ChannelType, string>>)[channel];
  return platform !== undefined && providers?.[platform] === false;
}
