import { getLocale, getTranslations } from 'next-intl/server';

import type { Channel, VoiceChannel } from '@/api/contracts/channels';

import styles from './Channels.module.css';
import { ConnectableRow } from './ConnectableRow';
import { buildChannelRows, isTroubled, type ConnectedRow } from './rows';

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
}: {
  readonly channels: readonly Channel[];
  readonly voice: readonly VoiceChannel[];
  readonly voiceOffered: boolean;
  readonly windowDays: number;
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
    return parts.join(' · ');
  };

  return (
    <ul className={styles.list} data-testid="channel-list">
      {rows.map((row) => {
        if (row.kind === 'connectable') {
          // The one interactive row, and the only client component here.
          return <ConnectableRow key={`connectable:${row.channel}`} channel={row.channel} />;
        }

        const troubled = isTroubled(row);
        return (
          <li
            key={row.id}
            className={[styles.row, troubled ? styles.rowTroubled : ''].join(' ').trim()}
            data-testid={`channel-${row.id}`}
            data-kind="connected"
            data-troubled={troubled ? 'yes' : 'no'}
          >
            <div className={styles.identity}>
              <span className={styles.name}>{t(`name.${row.channel}` as 'name.WHATSAPP')}</span>
              <span className={styles.detail} data-testid={`channel-detail-${row.id}`}>
                {detail(row)}
              </span>
              {/*
                The platform's own words, not ours. A paraphrase would be a
                second, vaguer copy of a message the platform already wrote —
                and "Shopify Chat app was uninstalled from the store" tells
                someone exactly what to go and do.
              */}
              {row.error ? (
                <span className={styles.error} data-testid={`channel-error-${row.id}`}>
                  {row.error}
                </span>
              ) : null}
            </div>

            <span
              className={[styles.status, troubled ? styles.statusTroubled : styles.statusGood]
                .join(' ')
                .trim()}
              data-testid={`channel-status-${row.id}`}
            >
              {t(`status.${row.status}` as 'status.CONNECTED')}
            </span>

            {/*
              Who answers this channel. The only routing a channel can store:
              `ChannelAccount` has no AI employee and no team, so the design's
              "Customer Support AI / Sales AI / Support team" is not a control
              that was dropped — it is one the data cannot express.
            */}
            <span className={styles.mode} data-testid={`channel-mode-${row.id}`}>
              {row.responseMode ? t(`mode.${row.responseMode}` as 'mode.AI_AUTO_REPLY') : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
