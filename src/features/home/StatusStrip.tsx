import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

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
  dayOne = null,
}: {
  /** Conversations sitting unassigned. Null when the count failed to load. */
  waiting: number | null;
  /** Unread notifications. Null when unavailable. */
  signals: number | null;
  isQuiet: boolean;
  /**
   * 01c: not live yet. The pill says so — and only so: nothing restricts who
   * GOTCHA answers before going live, so 02's "replies only to your team" is
   * not said. The right side is the trial, when there is one.
   */
  dayOne?: {
    readonly trialDays: number | null;
    /** `SETUP_CALL_URL`; null when unset — then there is no link. */
    readonly setupCallUrl?: string | null;
  } | null;
}) {
  const t = await getTranslations('home.status');

  if (dayOne) {
    return (
      <div className={styles.statusStrip}>
        <span
          className={[styles.statusPill, styles.statusSetup].join(' ')}
          data-testid="setup-pill"
        >
          <span className={styles.statusDot} aria-hidden="true" />
          {t('notLive')}
        </span>
        {dayOne.trialDays != null ? (
          <span className={styles.statusMeta} data-testid="trial">
            {t('trial', { days: dayOne.trialDays })}
          </span>
        ) : null}
        {dayOne.setupCallUrl ? (
          <a
            className={styles.statusCall}
            href={dayOne.setupCallUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="setup-call"
          >
            {t('setupCall')}
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.statusStrip}>
      {/* 01d: the pill opens the notifications panel over Home. */}
      <Link
        href={{ pathname: '/home', query: { notifications: '1' } }}
        scroll={false}
        data-testid="signals"
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
      </Link>

      {/*
        This clause used to vanish when the count failed, and the argument for
        leaving it was that its absence could not be mistaken for a calm
        answer — there is a primary count beside it that always renders.

        That is a LAYOUT fact, not a code fact. Reorder the strip, or lose the
        primary on the same request, and a silently missing clause is a
        reassuring answer given by nobody again. The property was true and
        depended on something no test holds still.
      */}
      <span className={styles.statusMeta}>
        {waiting === null ? t('waitingUnknown') : t('waitingOnYou', { count: waiting })}
        {/* 01b's "Last handover 3 hours ago": nothing records it. */}
        {isQuiet ? (
          <span
            className={styles.statusAside}
            title={t('lastHandoverNone')}
            data-testid="last-handover"
          >
            {t('lastHandover')} —
          </span>
        ) : null}
      </span>
    </div>
  );
}
