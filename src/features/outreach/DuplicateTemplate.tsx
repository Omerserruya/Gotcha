'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import { duplicateTemplate } from './create-actions';
import styles from './Outreach.module.css';

/** 05c's "Duplicate" — a local DRAFT copy (POST …/duplicate), then opened. */
export function DuplicateTemplate({ id }: { readonly id: string }) {
  const t = useTranslations('templates');
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        className={styles.tplSecondary}
        disabled={isPending}
        data-testid="template-duplicate"
        onClick={() => {
          setFailed(false);
          startTransition(async () => {
            const result = await duplicateTemplate(id);
            if (result.ok)
              router.push({ pathname: '/outreach/templates', query: { template: result.id } });
            else setFailed(true);
          });
        }}
      >
        {t('duplicate')}
      </button>
      {failed ? (
        <span className={styles.formProblem} role="alert" data-testid="template-duplicate-failed">
          {t('create.error.failed')}
        </span>
      ) : null}
    </>
  );
}
