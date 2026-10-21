'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button, type ButtonVariant } from '@/design-system/primitives/button/Button';
import { useRouter } from '@/i18n/navigation';

import styles from './Console.module.css';

/**
 * One console write, confirmed first and reported after (legacy confirmed
 * only Repair; here every write with a real effect is).
 *
 * The control opens a confirm that says what Yes will do; Yes calls the
 * write and waits; then the outcome is said in words - done (status) or
 * refused (alert) - and the page is read again, so what it shows is the
 * platform's state, not a guess. Nothing is drawn as done before the route
 * says so: no optimism where money or a customer's inbox is involved.
 */
/** Any write's result: done, or refused for a reason. */
type Outcome = { readonly ok: true } | { readonly ok: false };

export function ConfirmedAction<R extends Outcome>({
  label,
  sentences,
  yes,
  run,
  done,
  refused,
  variant = 'secondary',
  disabled = false,
  testid,
}: {
  /** The control's own words. */
  readonly label: string;
  /** What Yes will do, in reading order. */
  readonly sentences: readonly string[];
  readonly yes: string;
  readonly run: () => Promise<R>;
  /** The sentence for success, from what the route answered. */
  readonly done: (result: Extract<R, { ok: true }>) => string;
  /** The sentence for a refusal. */
  readonly refused: (result: Extract<R, { ok: false }>) => string;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly testid: string;
}) {
  const t = useTranslations('console.confirm');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const confirm = async () => {
    setPending(true);
    setOutcome(null);
    const result = await run();
    setOutcome(
      result.ok
        ? { ok: true, text: done(result as Extract<R, { ok: true }>) }
        : { ok: false, text: refused(result as Extract<R, { ok: false }>) },
    );
    setPending(false);
    setOpen(false);
    router.refresh();
  };

  return (
    <div className={styles.action} data-testid={testid}>
      {open ? (
        <div className={styles.confirm} role="group" aria-label={label}>
          {sentences.map((sentence, i) => (
            <p key={i} className={styles.confirmSentence}>
              {sentence}
            </p>
          ))}
          <span className={styles.confirmActions}>
            <Button size="sm" onClick={() => setOpen(false)} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={confirm}
              disabled={pending}
              data-testid={`${testid}-yes`}
            >
              {pending ? t('working') : yes}
            </Button>
          </span>
        </div>
      ) : (
        <Button
          size="sm"
          variant={variant}
          disabled={disabled}
          onClick={() => {
            setOutcome(null);
            setOpen(true);
          }}
          data-testid={`${testid}-open`}
        >
          {label}
        </Button>
      )}
      {outcome ? (
        <p
          className={outcome.ok ? styles.done : styles.refused}
          role={outcome.ok ? 'status' : 'alert'}
          data-testid={`${testid}-outcome`}
        >
          {outcome.text}
        </p>
      ) : null}
    </div>
  );
}
