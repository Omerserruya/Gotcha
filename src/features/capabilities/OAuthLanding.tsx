'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { usePathname, useRouter } from '@/i18n/navigation';

import type { OAuthFailure } from './oauth';
import styles from './Capabilities.module.css';

/**
 * The way back from the provider (backend 381a5d1b): said once, above the
 * system's screen, and then the query is cleaned so a refresh does not say it
 * again.
 *
 * ★ HELD IN STATE FROM THE FIRST RENDER. Cleaning the query re-renders the
 * page without it, and the outcome prop goes to `null` — so the page always
 * renders this, keyed by system, and the sentence stays until it is closed or
 * another system is opened. Reading the prop each render made it vanish the
 * moment the URL was tidied.
 */
export function OAuthLanding({
  slug,
  name,
  outcome,
}: {
  readonly slug: string;
  readonly name: string;
  /** `null` when this render carries no way back. */
  readonly outcome: 'connected' | OAuthFailure | 'other' | null;
}) {
  const t = useTranslations('capabilities.landing');
  const router = useRouter();
  const pathname = usePathname();
  const [said, setSaid] = useState(outcome);
  const arrived = outcome !== null;

  useEffect(() => {
    if (arrived) router.replace({ pathname, query: { system: slug } }, { scroll: false });
  }, [arrived, router, pathname, slug]);

  if (said === null) return null;
  return (
    <p
      className={styles.landing}
      role="status"
      data-outcome={said === 'connected' ? 'ok' : 'problem'}
      data-testid="oauth-landing"
    >
      <span>{said === 'connected' ? t('connected', { name }) : t(`error.${said}`, { name })}</span>
      <button
        type="button"
        className={styles.landingClose}
        aria-label={t('close')}
        data-testid="oauth-landing-close"
        onClick={() => setSaid(null)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </p>
  );
}
