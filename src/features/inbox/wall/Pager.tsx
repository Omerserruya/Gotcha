'use client';

import { useTranslations } from 'next-intl';

import { useDirection } from '@/i18n/direction-context';

import styles from './Wall.module.css';

/**
 * 02's 22px ‹ › pair. The row flips in Hebrew, so the glyphs do too: the
 * button nearest the start always points at the start.
 */
export function Pager({
  first,
  last,
  go,
  testid,
}: {
  readonly first: boolean;
  readonly last: boolean;
  readonly go: (delta: number) => void;
  readonly testid: string;
}) {
  const t = useTranslations('inbox.wall');
  const rtl = useDirection() === 'rtl';
  return (
    <span className={styles.pager}>
      <button
        type="button"
        className={styles.pageButton}
        aria-label={t('previous')}
        disabled={first}
        onClick={() => go(-1)}
        data-testid={`${testid}-previous`}
      >
        {rtl ? '›' : '‹'}
      </button>
      <button
        type="button"
        className={styles.pageButton}
        aria-label={t('next')}
        disabled={last}
        onClick={() => go(1)}
        data-testid={`${testid}-next`}
      >
        {rtl ? '‹' : '›'}
      </button>
    </span>
  );
}
