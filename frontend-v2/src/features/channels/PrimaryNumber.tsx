'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Button } from '@/design-system/primitives/button/Button';

import { setPrimaryNumber, type SetPrimaryResult } from './number-actions';
import styles from './Channels.module.css';

type Failure = Extract<SetPrimaryResult, { ok: false }>['reason'];

/**
 * The value of a number's "Sends what isn't tied to a number" row: "This
 * number" on the primary, "Set as primary" on the rest.
 *
 * ★ It stays mounted across the refresh the action causes, so what it said
 *   survives: the row that was just made primary reads "This number" AND
 *   "{number} is now the primary number." No modal - one press, and nothing
 *   is sent by the change itself.
 */
export function PrimaryNumber({
  channelAccountId,
  isPrimary,
  phone,
  current,
}: {
  /** `null`: a number GOTCHA has no channel for can't be made primary. */
  readonly channelAccountId: string | null;
  readonly isPrimary: boolean;
  /** This number, as the row draws it. */
  readonly phone: string | null;
  /** The primary now, as its row draws it - what a failure says is unchanged. */
  readonly current: string | null;
}) {
  const t = useTranslations('channels.whatsapp.primary');
  const [failed, setFailed] = useState<Failure | null>(null);
  const [made, setMade] = useState(false);
  const [pending, start] = useTransition();
  const ltr = (chunks: React.ReactNode) => <bdi dir="ltr">{chunks}</bdi>;

  const press = () => {
    if (channelAccountId === null || pending) return;
    setFailed(null);
    setMade(false);
    start(async () => {
      const result = await setPrimaryNumber(channelAccountId).catch((): SetPrimaryResult => ({
        ok: false,
        reason: 'failed',
      }));
      if (result.ok) setMade(true);
      else setFailed(result.reason);
    });
  };

  return (
    <span className={styles.primaryValue} data-testid="whatsapp-primary-row">
      {isPrimary ? (
        <span data-testid="whatsapp-primary-this">{t('thisNumber')}</span>
      ) : channelAccountId !== null ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={press}
          disabled={pending}
          data-testid="whatsapp-primary-set"
        >
          {pending ? t('setting') : t('set')}
        </Button>
      ) : null}
      {made && isPrimary ? (
        <span className={styles.primaryDone} role="status" data-testid="whatsapp-primary-done">
          {t.rich('done', { number: phone ?? '', ltr: ltr })}
        </span>
      ) : null}
      {failed ? (
        <span className={styles.footProblem} role="alert" data-testid="whatsapp-primary-failed">
          {failed === 'failed' || failed === 'not_active'
            ? t.rich(`failed.${failed}`, {
                hasOld: current ? 'yes' : 'no',
                old: current ?? '',
                ltr: ltr,
              })
            : t(`failed.${failed}`)}
        </span>
      ) : null}
    </span>
  );
}
