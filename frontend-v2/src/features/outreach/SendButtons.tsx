'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import { sendCampaign, submitTemplate, type SendResult } from './actions';
import styles from './Outreach.module.css';

/**
 * Send and Submit to Meta - live (Omer: only with a real WhatsApp Business
 * account, which the page checked). Both reach outside: the first press
 * asks, the second acts.
 */
function TwoPress({
  kind,
  id,
  count,
}: {
  readonly kind: 'send' | 'submit';
  readonly id: string;
  readonly count?: number;
}) {
  const t = useTranslations('outreach.go');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [isPending, startTransition] = useTransition();

  if (result?.ok) {
    return (
      <p className={styles.goDone} role="status" data-testid={`${kind}-done-${id}`}>
        {t(`${kind}.done`)}
      </p>
    );
  }
  return (
    <div className={styles.goRow}>
      {asking ? (
        <>
          <span className={styles.goAsk}>
            {kind === 'send' ? t('send.ask', { count: count ?? 0 }) : t('submit.ask')}
          </span>
          <button
            type="button"
            className={styles.goPrimary}
            disabled={isPending}
            data-testid={`${kind}-yes-${id}`}
            onClick={() =>
              startTransition(async () => {
                const done = kind === 'send' ? await sendCampaign(id) : await submitTemplate(id);
                setResult(done);
                setAsking(false);
                if (done.ok) router.refresh();
              })
            }
          >
            {isPending ? t(`${kind}.going`) : t(`${kind}.yes`)}
          </button>
          <button
            type="button"
            className={styles.goSecondary}
            disabled={isPending}
            data-testid={`${kind}-cancel-${id}`}
            onClick={() => setAsking(false)}
          >
            {t('cancel')}
          </button>
        </>
      ) : (
        <button
          type="button"
          className={styles.goPrimary}
          data-testid={`${kind}-${id}`}
          onClick={() => {
            setResult(null);
            setAsking(true);
          }}
        >
          {t(`${kind}.label`)}
        </button>
      )}
      {result && !result.ok ? (
        <p
          className={styles.goProblem}
          role="alert"
          title={result.reason === 'refused' ? (result.why ?? undefined) : undefined}
          data-testid={`${kind}-problem-${id}`}
        >
          {t(`${kind}.failed.${result.reason}`)}
        </p>
      ) : null}
    </div>
  );
}

export function SendCampaign({ id, count }: { readonly id: string; readonly count: number }) {
  return <TwoPress kind="send" id={id} count={count} />;
}

export function SubmitTemplate({ id }: { readonly id: string }) {
  return <TwoPress kind="submit" id={id} />;
}
