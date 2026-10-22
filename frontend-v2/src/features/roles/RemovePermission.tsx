'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { removePermission } from './actions';
import { isCeilingReason, useCeilingSentence } from './ceiling-words';
import styles from './Roles.module.css';

/**
 * Taking a permission away from one person - screen 12e's second path.
 *
 * ── WHY THIS IS NOT THE ADD FORM WITH A TOGGLE ──
 * Adding and removing are **two actions with opposite visibility**, not two
 * directions of one. An addition is self-evidencing - someone has a
 * capability their role does not give, and it shows the moment they use it.
 *
 * **A removal is invisible everywhere except the person panel.** The role
 * says they can refund, they are listed under that role, they cannot refund,
 * and nothing anyone looks at explains why.
 *
 * A toggle renders those as symmetrical, and **symmetry is the false claim.**
 *
 * ── THE CONFIRMATION SAYS WHERE IT WILL BE VISIBLE AFTERWARDS ──
 * Not in the abstract. **An admin creating something only they will be able
 * to find is entitled to be told that** - it is the one fact they cannot work
 * out from the screen.
 *
 * ── AND THE REASON IS REQUIRED ──
 * The endpoint accepts it as optional. **An unexplained addition is a
 * puzzle; an unexplained removal is a person who cannot do their job and
 * nobody who can say why.**
 */
export function RemovePermission({
  userId,
  personName,
  feature,
  featureName,
}: {
  readonly userId: string;
  readonly personName: string;
  readonly feature: string;
  readonly featureName: string;
}) {
  const t = useTranslations('roles');
  const ceiling = useCeilingSentence();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button
        type="button"
        className={styles.removeStart}
        data-testid={`remove-start-${feature}`}
        onClick={() => setConfirming(true)}
      >
        {t('remove.start')}
      </button>
    );
  }

  const canSubmit = reason.trim().length > 0 && !busy;

  return (
    <div className={styles.removeConfirm} data-testid={`remove-confirm-${feature}`}>
      <p className={styles.removeLead}>
        {t('remove.lead', { name: personName, permission: featureName })}
      </p>

      {/*
        The fact they cannot work out from the screen: after this, the only
        places it appears are here and the override count on Roles.
      */}
      <p className={styles.removeWhere} data-testid={`remove-where-${feature}`}>
        {t('remove.where')}
      </p>

      <label className={styles.removeReasonLabel} htmlFor={`reason-${feature}`}>
        {t('remove.reasonLabel')}
      </label>
      <input
        id={`reason-${feature}`}
        className={styles.removeReason}
        data-testid={`remove-reason-${feature}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('remove.reasonPlaceholder')}
      />
      {/*
        Required here though the endpoint allows it to be empty. The person
        this happens to will ask someone why, and this is the only place the
        answer can live.
      */}
      <p className={styles.removeReasonWhy}>{t('remove.reasonRequired')}</p>

      {error ? (
        <p className={styles.removeError} data-testid={`remove-error-${feature}`}>
          {error}
        </p>
      ) : null}

      <div className={styles.removeActions}>
        <button
          type="button"
          className={styles.removeGo}
          data-testid={`remove-go-${feature}`}
          disabled={!canSubmit}
          onClick={async () => {
            setBusy(true);
            const result = await removePermission(userId, feature, reason);
            setBusy(false);
            if (!result.ok)
              setError(
                isCeilingReason(result)
                  ? ceiling(result)
                  : t(`error.${result.reason}` as 'error.failed'),
              );
            else {
              setConfirming(false);
              setReason('');
              setError(null);
            }
          }}
        >
          {t('remove.confirm')}
        </button>
        <button
          type="button"
          className={styles.removeBack}
          data-testid={`remove-back-${feature}`}
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setReason('');
            setError(null);
          }}
        >
          {t('remove.cancel')}
        </button>
      </div>
    </div>
  );
}
