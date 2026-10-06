'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { ChannelType } from '@/api/contracts/channels';

import styles from './Channels.module.css';
import { ChannelTile } from './ChannelTile';
import { ConnectPanel } from './ConnectPanel';
import { channelName } from '@/api/contracts/inbox';

/**
 * A channel that could be connected, and the panel that connects it.
 *
 * The only client component on this screen. The list itself is server-rendered
 * - it is read-only, and `GET /api/channels` returns a `platformMeta` blob that
 * has no business in a browser payload - so interactivity is pushed down to
 * the one row that needs it rather than dragging the table with it.
 *
 * The panel opens INSIDE the row, which is what the design means by
 * *"inline"*: connecting a channel is a thing you do to that row, not a
 * separate page you are taken to and returned from.
 */
export function ConnectableRow({
  channel,
  notSetUp = false,
}: {
  readonly channel: ChannelType;
  /** Its provider has no app credentials on the server: drawn, not a dead-end button. */
  readonly notSetUp?: boolean;
}) {
  const t = useTranslations('channels');
  const [open, setOpen] = useState(false);

  return (
    <li
      className={[styles.row, styles.rowOpen].join(' ')}
      data-testid={`channel-connectable-${channel}`}
      data-kind="connectable"
    >
      <ChannelTile channel={channel} />
      <div className={styles.identity}>
        {/* No fallback here either: an unlisted channel rendered `name.X`. */}
        <span className={styles.name}>{channelName(channel, t) ?? t('name.other')}</span>
        <span className={styles.detail}>{t(`pitch.${channel}` as 'pitch.WHATSAPP')}</span>
      </div>

      {notSetUp ? (
        <span
          className={styles.notSetUp}
          title={t('connect.start.not_configured', { channel: channelName(channel, t) ?? '' })}
          data-testid={`connect-not-set-up-${channel}`}
        >
          {t('connect.notSetUp')}
        </span>
      ) : open ? null : (
        <button
          type="button"
          className={styles.connectOpen}
          data-testid={`connect-open-${channel}`}
          onClick={() => setOpen(true)}
        >
          {t('connect.open')}
        </button>
      )}

      {open ? <ConnectPanel channel={channel} onClose={() => setOpen(false)} /> : null}
    </li>
  );
}
