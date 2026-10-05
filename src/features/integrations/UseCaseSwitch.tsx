'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { USE_CASES, type UseCase } from '@/api/contracts/business-core';
import { useRouter } from '@/i18n/navigation';

import { setUseCase } from './actions';
import styles from './BusinessCore.module.css';

/**
 * 14b's "Your business runs on": three segments, the chosen one dark. It
 * decides which parts are asked about — a leads business is never asked about
 * shipping — so the page is re-read once it lands. Nothing moves before the
 * server says so: the parts below change with it.
 */
export function UseCaseSwitch({ current }: { readonly current: UseCase | null }) {
  const t = useTranslations('business-core.useCase');
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <div
        className={styles.useCases}
        role="radiogroup"
        aria-label={t('heading')}
        title={t('hint')}
      >
        {USE_CASES.map((useCase) => (
          <button
            key={useCase}
            type="button"
            role="radio"
            aria-checked={current === useCase}
            className={styles.useCase}
            data-selected={current === useCase}
            disabled={isPending}
            data-testid={`core-use-case-${useCase}`}
            onClick={() => {
              if (useCase === current) return;
              setProblem(null);
              startTransition(async () => {
                const done = await setUseCase(useCase);
                if (done.ok) router.refresh();
                else setProblem(t(`error.${done.reason}`));
              });
            }}
          >
            {t(useCase)}
          </button>
        ))}
      </div>
      {problem ? (
        <p className={styles.hint} role="alert" data-testid="core-use-case-problem">
          {problem}
        </p>
      ) : (
        <p
          className={styles.hint}
          data-testid={current === null ? 'core-use-case-unset' : undefined}
        >
          {current === null ? t('unset') : t('changes')}
        </p>
      )}
    </>
  );
}
