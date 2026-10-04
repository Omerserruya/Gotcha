'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { usePathname, useRouter } from '@/i18n/navigation';

import type { OAuthFailure } from './oauth';
import styles from './Capabilities.module.css';

/**
 * The way back from the provider (backend 381a5d1b): said once, above the
 * system's screen, and then the query is cleaned so a refresh does not say it
 * again.
 */
export function OAuthLanding({
  slug,
  name,
  outcome,
}: {
  readonly slug: string;
  readonly name: string;
  readonly outcome: 'connected' | OAuthFailure | 'other';
}) {
  const t = useTranslations('capabilities.landing');
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    router.replace({ pathname, query: { system: slug } }, { scroll: false });
  }, [router, pathname, slug]);

  return (
    <p
      className={styles.landing}
      role="status"
      data-outcome={outcome === 'connected' ? 'ok' : 'problem'}
      data-testid="oauth-landing"
    >
      {outcome === 'connected' ? t('connected', { name }) : t(`error.${outcome}`, { name })}
    </p>
  );
}
