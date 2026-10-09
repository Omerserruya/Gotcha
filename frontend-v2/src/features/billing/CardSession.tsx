'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { startCardSession } from './actions';
import { CARD_SESSION_KEY } from './card-session';
import styles from './Billing.module.css';
import { HeldConfirm } from './HeldConfirm';

/**
 * 17e's Add / Replace card. With billing writes off it is the held confirm;
 * on (BILLING_WRITES=on), its Yes starts a session on the provider's hosted
 * page and goes there - the session id kept in sessionStorage for the return
 * page (`/settings/billing/payment-method`) to confirm.
 */
export function CardSession({
  live,
  label,
  className,
  sentence,
  heldTag,
  heldWhy,
  testid,
}: {
  /** BILLING_WRITES=on for this deployment - decided on the server. */
  readonly live: boolean;
  readonly label: string;
  readonly className?: string;
  readonly sentence: string;
  readonly heldTag: string;
  readonly heldWhy: string;
  readonly testid: string;
}) {
  const t = useTranslations('billing.held');
  const tc = useTranslations('billing.card');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!live) {
    return (
      <HeldConfirm
        label={label}
        className={className}
        sentences={[sentence]}
        yes={t('toSecurePage')}
        heldTag={heldTag}
        heldWhy={heldWhy}
        cancel={t('cancel')}
        testid={testid}
      />
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className={className}
        data-testid={testid}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  }

  const go = async () => {
    setBusy(true);
    setProblem(null);
    const started = await startCardSession();
    if (!started.ok) {
      setBusy(false);
      setProblem(tc(`refused.${started.reason}`));
      return;
    }
    try {
      sessionStorage.setItem(CARD_SESSION_KEY, started.sessionId);
    } catch {
      // Without storage the return page cannot confirm: say so rather than go.
      setBusy(false);
      setProblem(tc('noStorage'));
      return;
    }
    window.location.assign(started.redirectUrl);
  };

  return (
    <div className={styles.heldConfirm} role="group" data-testid={`${testid}-confirm`}>
      <p className={styles.heldSentence}>{sentence}</p>
      <p className={styles.heldActions}>
        <button
          type="button"
          className={styles.cardGo}
          disabled={busy}
          data-testid={`${testid}-yes`}
          onClick={() => void go()}
        >
          {busy ? tc('opening') : t('toSecurePage')}
        </button>
        <button
          type="button"
          className={styles.heldCancel}
          disabled={busy}
          data-testid={`${testid}-cancel`}
          onClick={() => setOpen(false)}
        >
          {t('cancel')}
        </button>
      </p>
      {problem ? (
        <p className={styles.profileProblem} role="alert" data-testid={`${testid}-problem`}>
          {problem}
        </p>
      ) : null}
    </div>
  );
}
