import { getTranslations } from 'next-intl/server';

import styles from './Home.module.css';

/**
 * The line above the greeting.
 *
 * Both faces of Home carry one, and they say different things: on a busy
 * morning it counts what is unresolved, on a quiet one it confirms that
 * nothing is. It is the first thing read, so it has to be true — which is why
 * "everything is running" is only shown when something actually checked.
 *
 * The design also puts "last handover 3 hours ago" on the right. There is no
 * handover timestamp anywhere in the platform — `Conversation.handledBy` is a
 * string with no transition history — so it is absent rather than invented.
 */
export async function StatusStrip({
  waiting,
  signals,
  isQuiet,
}: {
  /** Conversations sitting unassigned. Null when the count failed to load. */
  waiting: number | null;
  /** Unread notifications. Null when unavailable. */
  signals: number | null;
  isQuiet: boolean;
}) {
  const t = await getTranslations('home.status');

  return (
    <div className={styles.statusStrip}>
      <span
        className={[styles.statusPill, isQuiet ? styles.statusCalm : undefined]
          .filter(Boolean)
          .join(' ')}
      >
        <span className={styles.statusDot} aria-hidden="true" />
        {/*
          `signals === null` is "we could not find out", and it used to render
          as `noSignals` — the reassuring answer, to a count nobody obtained.

          This file's own opening paragraph forbids that: "it is the first
          thing read, so it has to be true — which is why 'everything is
          running' is only shown when something actually checked." The
          component said the right thing and then did the other one.

          Same shape as the billing screen rounding an unread failure count to
          zero. A null collapsed into the calm value is the version nobody
          reports, because the screen looks fine.
        */}
        {isQuiet
          ? t('nothingNeedsYou')
          : signals === null
            ? t('signalsUnknown')
            : signals > 0
              ? t('signals', { count: signals })
              : t('noSignals')}
      </span>

      {waiting !== null ? (
        <span className={styles.statusMeta}>
          <span>{t('waitingOnYou', { count: waiting })}</span>
        </span>
      ) : null}
    </div>
  );
}
