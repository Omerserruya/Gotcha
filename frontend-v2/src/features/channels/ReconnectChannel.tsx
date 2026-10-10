'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { ChannelType } from '@/api/contracts/channels';

import { startChannelConnect } from './actions';
import styles from './Channels.module.css';

/**
 * A connected row's Reconnect, for an account whose messages cannot arrive
 * (`needsReconnect`): the channel's own Connect, run again. The OAuth
 * callbacks find the account by its key, update it, and retry the
 * subscription, clearing the code when it works (auth 4061f669) - so this is
 * the same path as the Connect row, not a second one.
 */
export function ReconnectChannel({
  id,
  channel,
  name,
}: {
  /** The channel account's id. */
  readonly id: string;
  readonly channel: ChannelType;
  /** The channel's name in the reader's language. */
  readonly name: string;
}) {
  const t = useTranslations('channels');
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        className={styles.rowDisconnect}
        disabled={isPending}
        aria-label={t('reconnect.label', { channel: name })}
        data-testid={`channel-reconnect-${id}`}
        onClick={() =>
          startTransition(async () => {
            setProblem(null);
            const start = await startChannelConnect(channel);
            if (start.ok) {
              window.location.assign(start.url);
              return;
            }
            setProblem(t(`connect.start.${start.reason}`, { channel: name }));
          })
        }
      >
        {isPending ? t('connect.opening') : t('reconnect.action')}
      </button>
      {problem ? (
        <span
          className={styles.footProblem}
          role="alert"
          data-testid={`channel-reconnect-problem-${id}`}
        >
          {problem}
        </span>
      ) : null}
    </>
  );
}
