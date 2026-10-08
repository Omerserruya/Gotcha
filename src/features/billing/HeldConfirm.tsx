'use client';

import { useState } from 'react';

import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';

import styles from './Billing.module.css';

/**
 * A billing write, built up to its confirm and held there.
 *
 * Dev's billing talks to the PRODUCTION iCount account (Backend, 2026-10-08),
 * so a plan change, a card session and auto-purchase have no call behind them
 * - not even behind a flag. The control opens; the confirm says exactly what
 * the write would do, from what the code proves; and its Yes is the uniform
 * unavailable status, with the reason. Released per control once dev is on a
 * provider that cannot move money.
 */
export function HeldConfirm({
  label,
  className,
  sentences,
  yes,
  heldTag,
  heldWhy,
  cancel,
  testid,
}: {
  /** The control's own words - "Switch to Growth", "Add card". */
  readonly label: string;
  readonly className?: string;
  /** What Yes would do, in the order to read it. */
  readonly sentences: readonly string[];
  readonly yes: string;
  readonly heldTag: string;
  readonly heldWhy: string;
  readonly cancel: string;
  readonly testid: string;
}) {
  const [open, setOpen] = useState(false);

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
  return (
    <div className={styles.heldConfirm} role="group" data-testid={`${testid}-confirm`}>
      {sentences.map((sentence, i) => (
        <p key={i} className={styles.heldSentence}>
          {sentence}
        </p>
      ))}
      <p className={styles.heldActions}>
        <UnavailableAction label={yes} tag={heldTag} why={heldWhy} testid={`${testid}-yes`} />
        <button
          type="button"
          className={styles.heldCancel}
          data-testid={`${testid}-cancel`}
          onClick={() => setOpen(false)}
        >
          {cancel}
        </button>
      </p>
    </div>
  );
}
