'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button, type ButtonVariant } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
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
 *
 * Two things the confirm can ask for before Yes: a REASON, which the route
 * records with the write (1 to 500 characters), and a value typed back
 * EXACTLY (a tenant's slug before it is deleted). After a done write, the
 * route's warnings are said under the outcome: a write can succeed and still
 * leave something the operator must know.
 */
/** The route's limit on a reason (Backend's manual-edit contract). */
export const REASON_MAX = 500;

/** Any write's result: done, or refused for a reason. */
type Outcome = { readonly ok: true } | { readonly ok: false };

export function ConfirmedAction<R extends Outcome>({
  label,
  sentences,
  yes,
  run,
  done,
  refused,
  notes,
  reason,
  match,
  after,
  variant = 'secondary',
  disabled = false,
  testid,
}: {
  /** The control's own words. */
  readonly label: string;
  /** What Yes will do, in reading order. */
  readonly sentences: readonly string[];
  readonly yes: string;
  readonly run: (input: { readonly reason: string }) => Promise<R>;
  /** The sentence for success, from what the route answered. */
  readonly done: (result: Extract<R, { ok: true }>) => string;
  /** The sentence for a refusal. */
  readonly refused: (result: Extract<R, { ok: false }>) => string;
  /** Sentences said under a done outcome: what the write left to know. */
  readonly notes?: (result: Extract<R, { ok: true }>) => readonly string[];
  /** The reason field's label. Given, Yes waits for a reason. */
  readonly reason?: string;
  /** A value typed back exactly before Yes. */
  readonly match?: { readonly label: string; readonly value: string };
  /** In place of re-reading the page after a done write (a deleted page has nothing to re-read). */
  readonly after?: (result: Extract<R, { ok: true }>) => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly testid: string;
}) {
  const t = useTranslations('console.confirm');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{
    ok: boolean;
    text: string;
    notes?: readonly string[];
  } | null>(null);
  const [why, setWhy] = useState('');
  const [typed, setTyped] = useState('');
  const ready =
    (reason === undefined || why.trim() !== '') && (match === undefined || typed === match.value);

  const confirm = async () => {
    setPending(true);
    setOutcome(null);
    // A rejected action is not a refusal: the write may or may not have
    // happened, so it says so instead of staying on "working" for good.
    const result = await run({ reason: why.trim() }).catch(() => null);
    setPending(false);
    setOpen(false);
    if (result?.ok && after) {
      after(result as Extract<R, { ok: true }>);
      return;
    }
    setOutcome(
      result === null
        ? { ok: false, text: t('unconfirmed') }
        : result.ok
          ? {
              ok: true,
              text: done(result as Extract<R, { ok: true }>),
              notes: notes?.(result as Extract<R, { ok: true }>) ?? [],
            }
          : { ok: false, text: refused(result as Extract<R, { ok: false }>) },
    );
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
          {reason !== undefined ? (
            <Input
              label={reason}
              value={why}
              maxLength={REASON_MAX}
              onChange={(event) => setWhy(event.target.value)}
              data-testid={`${testid}-reason`}
            />
          ) : null}
          {match ? (
            <Input
              label={match.label}
              value={typed}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
              data-testid={`${testid}-match`}
            />
          ) : null}
          <span className={styles.confirmActions}>
            <Button size="sm" onClick={() => setOpen(false)} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              variant={variant === 'danger' ? 'danger' : 'primary'}
              onClick={confirm}
              disabled={pending || !ready}
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
            setWhy('');
            setTyped('');
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
      {outcome?.notes?.length ? (
        <ul className={styles.notes} data-testid={`${testid}-notes`}>
          {outcome.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
