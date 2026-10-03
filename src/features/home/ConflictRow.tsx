'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { IntelligenceReview } from '@/api/contracts/intelligence-reviews';

import styles from './Home.module.css';
import { resolveConflict } from './resolve-conflict';

/**
 * One row of the quiet-day card: something GOTCHA learned that two sources
 * disagree about.
 *
 * Two actions, weighted as the design weights them — accepting the new value
 * is the filled button, keeping the current one is outlined. The row carries
 * an amber edge because it is blocking: until it is settled, every question
 * touching that field goes to a person.
 *
 * Optimistic. The decision is already made in the operator's head and is
 * correctable by editing the field; making them wait on a round trip for it is
 * the worse trade. A failure restores the row and says so.
 */
export function ConflictRow({ conflict }: { conflict: IntelligenceReview }) {
  const t = useTranslations('home.conflicts');
  const [settled, setSettled] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (settled) return null;

  function resolve(decision: 'approve' | 'reject') {
    setFailed(false);
    setSettled(true);
    startTransition(async () => {
      const outcome = await resolveConflict(conflict.id, decision);
      if (!outcome.ok) {
        // Put it back. A row that vanished on a failed write would leave the
        // operator believing they had settled something they had not.
        setSettled(false);
        setFailed(true);
      }
    });
  }

  return (
    <div className={[styles.workRow, styles.workRowConflict].join(' ')}>
      <div className={styles.workRowText}>
        <Title>{t('title')}</Title>
        <p className={styles.workRowBody}>
          {failed ? t('failed') : t('body', { field: humanise(conflict.fieldKey) })}
        </p>
      </div>
      <div className={styles.workRowActions}>
        <button
          type="button"
          className={styles.actionPrimary}
          onClick={() => resolve('approve')}
          disabled={isPending}
        >
          {t('accept')}
        </button>
        <button
          type="button"
          className={styles.actionSecondary}
          onClick={() => resolve('reject')}
          disabled={isPending}
        >
          {t('keep')}
        </button>
      </div>
    </div>
  );
}

function Title({ children }: { children: string }) {
  return <p className={styles.workRowTitle}>{children}</p>;
}

/** `minimum_order` reads better as "minimum order". */
function humanise(fieldKey: string | undefined): string {
  return (fieldKey ?? '').replace(/[_-]+/g, ' ').trim() || '—';
}
