'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { addToCall, holdCustomer, leaveCall, type CallWriteResult } from './actions';
import styles from './Calls.module.css';
import { pastedNumber } from './dial';

/**
 * 05e's Transfer - live (Omer, 2026-10-04), as the old app does it
 * (`ChatCenter/frontend/src/app/voice/[sessionId]/page.tsx`):
 *
 *   1. add a third party to the call by number   `add-participant`
 *   2. optionally hold the customer while you talk to them   `customer-hold`
 *   3. hand over and leave - the customer and the third party stay
 *      `agent-leave`, behind a confirm, because it cannot be undone
 *
 * Each step is a click; nothing runs on its own.
 */
export function TransferPanel({
  sessionId,
  who,
}: {
  readonly sessionId: string;
  /** The customer, as the header names them. */
  readonly who: string;
}) {
  const t = useTranslations('calls.transfer');
  const [number, setNumber] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const [onHold, setOnHold] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [left, setLeft] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const run = (write: () => Promise<CallWriteResult>, then: () => void) => {
    setProblem(null);
    startTransition(async () => {
      const result = await write();
      if (result.ok) then();
      else
        setProblem(
          t.has(`error.${result.reason}`)
            ? t(`error.${result.reason}` as 'error.failed')
            : t('error.failed'),
        );
    });
  };

  const to = pastedNumber(number);

  if (left) {
    return (
      <div className={styles.transfer} data-testid="transfer-panel">
        <p className={styles.transferNote} role="status" data-testid="transfer-left">
          {t('left')}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.transfer} data-testid="transfer-panel">
      {added === null ? (
        <div className={styles.transferRow}>
          <label className="srOnly" htmlFor="transfer-to">
            {t('to')}
          </label>
          <input
            id="transfer-to"
            className={styles.transferInput}
            inputMode="tel"
            placeholder={t('placeholder')}
            value={number}
            data-testid="transfer-to"
            onChange={(e) => setNumber(e.target.value)}
          />
          <button
            type="button"
            className={styles.liveAction}
            disabled={to === null || isPending}
            title={to === null ? t('fullNumber') : undefined}
            data-testid="transfer-add"
            onClick={() =>
              to &&
              run(
                () => addToCall(sessionId, to),
                () => setAdded(to),
              )
            }
          >
            {t('add')}
          </button>
        </div>
      ) : (
        <>
          <p className={styles.transferNote} data-testid="transfer-added">
            {t('added', { number: added })}
          </p>
          <div className={styles.transferRow}>
            <button
              type="button"
              className={styles.liveAction}
              aria-pressed={onHold}
              disabled={isPending}
              data-testid="transfer-hold"
              onClick={() =>
                run(
                  () => holdCustomer(sessionId, !onHold),
                  () => setOnHold(!onHold),
                )
              }
            >
              {onHold ? t('resume', { who }) : t('hold', { who })}
            </button>
            {confirming ? (
              <>
                <button
                  type="button"
                  className={styles.liveEnd}
                  disabled={isPending}
                  data-testid="transfer-leave-confirm"
                  onClick={() =>
                    run(
                      () => leaveCall(sessionId),
                      () => setLeft(true),
                    )
                  }
                >
                  {t('leaveConfirm')}
                </button>
                <button
                  type="button"
                  className={styles.liveAction}
                  disabled={isPending}
                  onClick={() => setConfirming(false)}
                >
                  {t('stay')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={styles.liveAction}
                disabled={isPending}
                data-testid="transfer-leave"
                onClick={() => setConfirming(true)}
              >
                {t('leave')}
              </button>
            )}
          </div>
          {confirming ? <p className={styles.transferNote}>{t('leaveWhat', { who })}</p> : null}
        </>
      )}
      {problem ? (
        <p className={styles.transferProblem} role="alert" data-testid="transfer-problem">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
