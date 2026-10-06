'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { channelName } from '@/api/contracts/inbox';
import { useRouter } from '@/i18n/navigation';

import type { ChannelLanding as Landing } from './landing';
import styles from './Channels.module.css';

/**
 * The sentence the way back earns - "Instagram connected - 1 account." -
 * over the list, which already shows the row as connected. No new screen
 * (Omer: a screen after a callback only from a detailed design). Held in
 * state from the first render, then the URL is tidied; WhatsApp's way back
 * keeps its panel open, as 13b is its designed place.
 */
export function ChannelLanding({
  landing,
}: {
  /**
   * `null` once the URL is tidied - and the page keeps this mounted then, so
   * the sentence held in state outlives the re-render (08b's lesson).
   */
  readonly landing: Landing | null;
}) {
  const t = useTranslations('channels');
  const router = useRouter();
  const [said, setSaid] = useState<Landing | null>(landing);

  useEffect(() => {
    if (landing === null) return;
    router.replace(
      landing.channel === 'WHATSAPP' && landing.outcome === 'connected'
        ? '/settings/channels?panel=whatsapp'
        : '/settings/channels',
      { scroll: false },
    );
  }, [landing, router]);

  if (!said) return null;
  const name = channelName(said.channel, t) ?? t('name.other');
  const ok = said.outcome === 'connected';
  return (
    <p
      className={styles.landing}
      role="status"
      data-outcome={ok ? 'ok' : 'problem'}
      data-testid="channel-landing"
    >
      <span>
        {said.outcome === 'connected'
          ? said.pending
            ? t('landing.pending', { channel: name })
            : said.count === null
              ? t('landing.connected', { channel: name })
              : t('landing.connectedCount', { channel: name, count: said.count })
          : t(`landing.error.${said.outcome}`, { channel: name })}
      </span>
      <button
        type="button"
        className={styles.landingClose}
        aria-label={t('connect.close')}
        onClick={() => setSaid(null)}
      >
        ×
      </button>
    </p>
  );
}
