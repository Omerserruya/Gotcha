'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import type { CheckoutSummary } from '@/api/contracts/checkout';
import { useRouter } from '@/i18n/navigation';

import { watchCheckout } from './actions';
import { checkoutPagePath, pageForStatus, pageShows } from './checkout-pages';
import { CheckoutFrame } from './CheckoutFrame';
import { CheckoutUnavailable } from './CheckoutUnavailable';
import { SummaryCard } from './SummaryCard';
import styles from './Checkout.module.css';

/** How often the waiting page asks again (the legacy page's 4 s). */
export const POLL_MS = 4000;

/**
 * The waiting page. Coming back from the provider proves the customer came
 * back, nothing more: on arrival and then every few seconds billing is asked
 * to re-check (`watchCheckout`), and the page moves when billing's answer
 * belongs elsewhere - paid, refused, or back to asking for a card.
 *
 * Three different waits, said differently: in flight ("a few moments"),
 * unknown (`awaitingResolution` - may need a person; no "any second now",
 * and no pay-again), and a manual review. Only the first is polled.
 */
export function ProcessingWatch({
  reference,
  initial,
}: {
  readonly reference: string;
  readonly initial: CheckoutSummary;
}) {
  const t = useTranslations('checkout');
  const router = useRouter();
  // Read through a ref: a router that is a new object on a render must not restart the poll.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const [summary, setSummary] = useState(initial);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const read = await watchCheckout(reference);
      if (stopped) return;
      if (read.kind === 'unavailable') {
        setGone(true);
        return;
      }
      setSummary(read.summary);
      const status = read.summary.status;
      if (!pageShows('processing', status)) {
        routerRef.current.replace({
          pathname: checkoutPagePath(pageForStatus(status)),
          query: { ref: reference },
        });
        return;
      }
      if (status === 'PROCESSING') timer = setTimeout(() => void ask(), POLL_MS);
    };
    void ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [reference]);

  if (gone) return <CheckoutUnavailable />;

  const wait =
    summary.status === 'MANUAL_REVIEW'
      ? 'manualReview'
      : summary.awaitingResolution
        ? 'unresolved'
        : 'processing';
  return (
    <CheckoutFrame title={t(`${wait}.title`)} lead={t(`${wait}.lead`)} testid={`checkout-${wait}`}>
      <SummaryCard summary={summary} />
      <p className={styles.waiting} role="status" aria-live="polite">
        {wait === 'processing' ? <span className={styles.dot} aria-hidden="true" /> : null}
        <span className={styles.quiet}>{t(`${wait}.status`)}</span>
      </p>
    </CheckoutFrame>
  );
}
