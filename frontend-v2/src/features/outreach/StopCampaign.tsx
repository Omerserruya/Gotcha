'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { stopCampaign } from './actions';
import styles from './Outreach.module.css';

/**
 * The control the design drew as *"Pause the rest"*.
 *
 * ── IT DOES NOT SAY PAUSE ──
 * There is no `PAUSED` status and no resume route. `cancel` removes the queued
 * jobs, marks every pending recipient `"skipped"`, and sets `completedAt` -
 * terminal, with no path back to `SENDING`.
 *
 * "Pause" promises two things: that it halts, and that it resumes. Only the
 * first is true, and the second is the one someone relies on when they stop a
 * campaign for ten minutes. **An absent control leaves a visible gap; a
 * control that exists and does something adjacent and irreversible is how the
 * label gets trusted.**
 *
 * ── THE CONFIRMATION NAMES WHAT IS LOST ──
 * Not *"are you sure?"* - that tests conviction, not understanding, and the
 * answer is always yes. It states the two consequences the route actually
 * produces: the people still queued will not receive it, and the campaign
 * cannot be restarted. Both are read straight off what `cancel` does.
 */
export function StopCampaign({ id, name }: { readonly id: string; readonly name: string }) {
  const t = useTranslations('outreach');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button
        type="button"
        className={styles.stop}
        data-testid={`stop-${id}`}
        onClick={() => setConfirming(true)}
      >
        {t('action.stop')}
      </button>
    );
  }

  return (
    <div className={styles.confirm} data-testid={`stop-confirm-${id}`}>
      <p className={styles.confirmLead}>{t('stop.lead', { name })}</p>
      {/*
        The two things `cancel` actually does, in the order they matter to the
        person: who does not get the message, and that there is no undoing it.
      */}
      <ul className={styles.confirmPoints}>
        <li>{t('stop.skipped')}</li>
        <li>{t('stop.terminal')}</li>
      </ul>

      {error ? (
        <p className={styles.confirmError} data-testid={`stop-error-${id}`}>
          {error}
        </p>
      ) : null}

      <div className={styles.confirmActions}>
        <button
          type="button"
          className={styles.stopConfirm}
          data-testid={`stop-go-${id}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await stopCampaign(id);
            setBusy(false);
            if (!result.ok) setError(t(`error.${result.reason}` as 'error.failed'));
            else setConfirming(false);
          }}
        >
          {t('action.stopConfirm')}
        </button>
        <button
          type="button"
          className={styles.stopCancel}
          data-testid={`stop-back-${id}`}
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          {t('action.keepSending')}
        </button>
      </div>
    </div>
  );
}
