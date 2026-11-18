'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import styles from './Console.module.css';

/**
 * A conversation id, in mono, with a button that copies it (Supervisior,
 * 2026-11-18: no link - there is no support view of a tenant's chat yet).
 * A clipboard the browser refuses says so; the id stays selectable.
 */
export function CopyId({ value, testid }: { readonly value: string; readonly testid: string }) {
  const t = useTranslations('console.aiFailures.copy');
  const [said, setSaid] = useState<'copied' | 'refused' | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setSaid('copied');
    } catch {
      setSaid('refused');
    }
  };

  return (
    <span className={styles.copyId}>
      <span className={styles.slug} dir="ltr" data-testid={testid}>
        {value}
      </span>
      <button
        type="button"
        className={styles.copyButton}
        aria-label={t('label', { id: value })}
        data-testid={`${testid}-copy`}
        onClick={() => void copy()}
      >
        {t('button')}
      </button>
      {said ? (
        <span className={styles.copySaid} role="status">
          {t(said)}
        </span>
      ) : null}
    </span>
  );
}
