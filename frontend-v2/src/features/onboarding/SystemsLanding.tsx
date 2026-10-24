'use client';

import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import type { OAuthFailure } from '@/features/capabilities/oauth';

import { RETURN_KEYS } from './systems-return';
import styles from './SystemsStep.module.css';

/**
 * Takes the way back out of the address once it has been read, so a reload
 * does not say it again - keeping everything else (`preview=1`).
 *
 * `history.replaceState` rather than a router replace: Next keeps the page as
 * rendered (the banner, Shopify's claim) and only the address changes. A
 * router replace would render the step again without the query, and the
 * sentence would vanish the moment it appeared.
 */
export function CleanReturnQuery() {
  useEffect(() => {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of RETURN_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);
  return null;
}

/**
 * The way back from a provider, said once: connected, or not connected with
 * what to do next. Held in state from the first render and closed by hand.
 */
export function SystemsLanding({
  slug,
  name,
  outcome,
}: {
  readonly slug: string;
  readonly name: string;
  readonly outcome: 'connected' | OAuthFailure | 'other';
}) {
  const t = useTranslations('onboarding.systems.return');
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const ok = outcome === 'connected';
  return (
    <div
      className={styles.landing}
      data-outcome={ok ? 'ok' : 'problem'}
      role={ok ? 'status' : 'alert'}
      data-testid={`systems-landing-${slug}`}
    >
      {ok ? (
        <CircleCheck className={styles.landingIcon} size={18} aria-hidden="true" />
      ) : (
        <CircleAlert className={styles.landingIcon} size={18} aria-hidden="true" />
      )}
      <span className={styles.landingText} data-testid="systems-landing-text">
        {ok ? t('connected', { name }) : t(`error.${outcome}`, { name })}
      </span>
      <button
        type="button"
        className={styles.landingClose}
        aria-label={t('close')}
        data-testid="systems-landing-close"
        onClick={() => setOpen(false)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
