import { Phone } from 'lucide-react';

import { channelMark } from '@/features/inbox/channel-marks';

import styles from './Channels.module.css';

/**
 * 02's 34px tile on EVERY channel row - connected, connectable or calls -
 * so the names line up down the list: the channel's mark on its own surface.
 */
export function ChannelTile({ channel }: { readonly channel: string }) {
  if (channel === 'VOICE') {
    return (
      <span className={styles.tile} data-tone="web" aria-hidden="true">
        <Phone size={17} strokeWidth={1.75} />
      </span>
    );
  }
  const { Icon, tone } = channelMark(channel);
  return (
    <span className={styles.tile} data-tone={tone} aria-hidden="true">
      <Icon size={17} strokeWidth={1.75} />
    </span>
  );
}
