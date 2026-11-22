'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { DomainJoin } from '@/api/contracts/self-signup';

import { setDomainJoin, type DomainJoinResult } from './domain-join-actions';
import styles from './Security.module.css';

/**
 * 02's "Sign in with Google · anyone with an @avivco.il address" row, as Omer
 * decided it (2026-11-22): "הצטרפות לפי דומיין" - anyone who signs up with the
 * admin's own email domain joins this organization as an agent.
 *
 * ★ A public mail domain (gmail.com and the like) is shown, switched off and
 *   not switchable, with the reason - never hidden, so the admin knows why.
 * ★ Optimistic like the two-step levels beside it, and put back on a refusal.
 */
export function DomainJoinRow({ join }: { readonly join: DomainJoin }) {
  const t = useTranslations('security.domainJoin');
  const [on, setOn] = useState(join.joinByDomain && !join.publicDomain);
  const [refused, setRefused] = useState<Exclude<DomainJoinResult, 'saved'> | null>(null);
  const [isPending, startTransition] = useTransition();
  const domain = <bdi dir="ltr">{join.domain}</bdi>;

  return (
    <div data-testid="domain-join">
      <div className={styles.policyRow}>
        <span className={styles.policyText}>
          <span className={styles.policyName}>{t('name')}</span>
          <span className={styles.policySub} data-testid="domain-join-line">
            {join.publicDomain
              ? t.rich('publicDomain', { domain: () => domain })
              : t.rich('on', { domain: () => domain })}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={t('name')}
          checked={on}
          disabled={join.publicDomain || isPending}
          data-testid="domain-join-switch"
          onChange={(event) => {
            const next = event.target.checked;
            setOn(next);
            setRefused(null);
            startTransition(async () => {
              const result = await setDomainJoin(next);
              if (result === 'saved') return;
              setOn(!next);
              setRefused(result);
            });
          }}
        />
      </div>
      {refused ? (
        <p className={styles.problem} role="alert" data-testid="domain-join-failed">
          {refused === 'taken'
            ? t.rich('taken', { domain: () => domain })
            : refused === 'publicDomain'
              ? t.rich('publicDomain', { domain: () => domain })
              : t('failed')}
        </p>
      ) : null}
    </div>
  );
}
