'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { setEmployeeStatus } from './actions';
import styles from './Employees.module.css';

/**
 * Pause and resume, with the consequence stated before the click.
 *
 * ── WHY THIS IS A CONFIRMATION AND RESUME IS NOT ──
 * Pausing is the destructive direction here, and the damage is invisible:
 * `ai-bot.service.ts` returns `reply: null` and does nothing else. **No
 * handover, no reassignment, no notification.** Anyone mid-conversation simply
 * stops getting replies, and neither they nor anyone at the business is told.
 *
 * A manager pausing an employee would reasonably assume the conversations go
 * somewhere. They do not. So the confirmation **names what happens to the
 * people currently talking to it** — with the number, when there is one —
 * rather than asking whether the person is sure.
 *
 * Resuming has no such consequence and needs no confirmation.
 */
export function PauseEmployee({
  id,
  name,
  openConversations,
  paused,
}: {
  readonly id: string;
  readonly name: string;
  readonly openConversations: number;
  readonly paused: boolean;
}) {
  const t = useTranslations('employees');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(status: 'ACTIVE' | 'PAUSED') {
    setBusy(true);
    const result = await setEmployeeStatus(id, status);
    setBusy(false);
    if (!result.ok) setError(t(`error.${result.reason}` as 'error.failed'));
    else {
      setConfirming(false);
      setError(null);
    }
  }

  if (paused) {
    return (
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.resume}
          data-testid={`resume-${id}`}
          disabled={busy}
          onClick={() => apply('ACTIVE')}
        >
          {t('action.resume')}
        </button>
        {error ? (
          <p className={styles.controlError} data-testid={`error-${id}`}>
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.pause}
          data-testid={`pause-${id}`}
          onClick={() => setConfirming(true)}
        >
          {t('action.pause')}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.confirm} data-testid={`pause-confirm-${id}`}>
      <p className={styles.confirmLead}>{t('pause.lead', { name })}</p>

      {/*
        The consequence, with a number when there is one. "Three people are
        mid-conversation" lands where "open conversations will be affected"
        does not — and the warning stands at zero too, because a conversation
        can arrive between reading this and clicking.
      */}
      <p className={styles.confirmBody} data-testid={`pause-consequence-${id}`}>
        {openConversations > 0
          ? t('pause.midConversation', { count: openConversations })
          : t('pause.noneOpen')}
      </p>

      {error ? (
        <p className={styles.confirmError} data-testid={`error-${id}`}>
          {error}
        </p>
      ) : null}

      <div className={styles.confirmActions}>
        <button
          type="button"
          className={styles.pauseConfirm}
          data-testid={`pause-go-${id}`}
          disabled={busy}
          onClick={() => apply('PAUSED')}
        >
          {t('action.pauseConfirm')}
        </button>
        <button
          type="button"
          className={styles.keepRunning}
          data-testid={`pause-back-${id}`}
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          {t('action.keepRunning')}
        </button>
      </div>
    </div>
  );
}
