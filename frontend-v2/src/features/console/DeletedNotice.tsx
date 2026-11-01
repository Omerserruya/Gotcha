'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Fragment, useState, useSyncExternalStore } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { UserText } from '@/design-system/primitives/text/UserText';

import styles from './Console.module.css';

/**
 * A deleted tenant's outcome, said on the tenants list it lands on.
 *
 * Handed over in sessionStorage, not the address: the leftovers name phone
 * numbers and accounts, which have no place in a URL or the browser's
 * history. Read after hydration (the server has no storage), shown until
 * dismissed, so a reload does not lose what the operator still has to do.
 */
const KEY = 'console.deletedTenant';

/** What the route counted before deleting, in the order the notice says it. */
const COUNTS = ['users', 'conversations', 'messages', 'channelAccounts', 'contacts'] as const;
type Counted = (typeof COUNTS)[number] | 'identitiesDeleted' | 'uploadFiles';

interface Deleted {
  readonly name: string;
  readonly counts?: Partial<Record<(typeof COUNTS)[number], number | null>>;
  readonly identitiesDeleted?: number | null;
  readonly uploadFiles?: number | null;
  readonly providerLeftovers: readonly string[];
  readonly uploadsRemoved: boolean;
  readonly uploadsLeftBehind?: readonly string[];
}

interface Kept {
  readonly name: string;
  /** Only the counts that were read; an unread one is not said as 0. */
  readonly removed: readonly (readonly [Counted, number])[];
  readonly providerLeftovers: readonly string[];
  readonly uploadsRemoved: boolean;
  readonly uploadsLeftBehind: readonly string[];
}

export function keepDeleted(deleted: Deleted) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(deleted));
  } catch {
    // Storage refused: the list still loads; the outcome goes unsaid.
  }
}

const read = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const subscribe = () => () => {};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

function parse(raw: string | null): Kept | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Deleted>;
    if (typeof value.name !== 'string') return null;
    const counts: Record<string, unknown> =
      value.counts && typeof value.counts === 'object' ? value.counts : {};
    const removed: [Counted, unknown][] = [
      ...COUNTS.map((key): [Counted, unknown] => [key, counts[key]]),
      ['identitiesDeleted', value.identitiesDeleted],
      ['uploadFiles', value.uploadFiles],
    ];
    return {
      name: value.name,
      removed: removed.filter((each): each is [Counted, number] => isCount(each[1])),
      providerLeftovers: strings(value.providerLeftovers),
      uploadsRemoved: value.uploadsRemoved !== false,
      uploadsLeftBehind: strings(value.uploadsLeftBehind),
    };
  } catch {
    return null;
  }
}

export function DeletedNotice() {
  const t = useTranslations('console.edit.delete');
  const format = useFormatter();
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const [dismissed, setDismissed] = useState(false);
  const deleted = dismissed ? null : parse(raw);
  if (!deleted) return null;

  return (
    <div className={styles.notice} role="status" data-testid="tenant-deleted">
      <p className={styles.done}>{t('done', { name: deleted.name })}</p>
      {deleted.removed.length ? (
        <>
          <p className={styles.noticeTitle}>{t('removed')}</p>
          <dl className={styles.facts} data-testid="tenant-deleted-counts">
            {deleted.removed.map(([key, count]) => (
              <Fragment key={key}>
                <dt>{t(`counts.${key}`)}</dt>
                <dd>{format.number(count)}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      ) : null}
      {deleted.providerLeftovers.length ? (
        <>
          <p className={styles.noticeTitle}>{t('leftovers')}</p>
          <ul className={styles.notes}>
            {deleted.providerLeftovers.map((each) => (
              <li key={each}>
                <UserText>{each}</UserText>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {deleted.uploadsRemoved ? null : (
        <>
          <p className={styles.quiet}>{t('uploadsLeft')}</p>
          {deleted.uploadsLeftBehind.length ? (
            <ul className={styles.notes} data-testid="tenant-deleted-uploads">
              {deleted.uploadsLeftBehind.map((each) => (
                <li key={each} className={styles.code} dir="ltr">
                  {each}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <span>
        <Button
          size="sm"
          onClick={() => {
            try {
              sessionStorage.removeItem(KEY);
            } catch {
              // Nothing to clear.
            }
            setDismissed(true);
          }}
          data-testid="tenant-deleted-dismiss"
        >
          {t('dismiss')}
        </Button>
      </span>
    </div>
  );
}
