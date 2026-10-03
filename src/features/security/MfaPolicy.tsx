'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { TenantSecurity } from '@/api/contracts/security';

import { setMfaPolicy, type SecurityWriteResult } from './actions';
import styles from './Security.module.css';

const LEVELS = ['none', 'admins', 'everyone'] as const;
type Level = (typeof LEVELS)[number];

const POLICY: Record<Level, TenantSecurity> = {
  none: { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: false },
  admins: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: false },
  everyone: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true },
};

/**
 * Who must use two-factor authentication — one policy, three levels.
 *
 * The design also asks for SSO and a Google domain. No field for either exists
 * on this route, and it may be an identity-provider setting rather than one of
 * ours, so the screen draws no control for it (the page shows "—").
 */
export function MfaPolicy({ policy }: { readonly policy: TenantSecurity }) {
  const t = useTranslations('security');
  const [value, setValue] = useState<TenantSecurity>(policy);
  const [result, setResult] = useState<SecurityWriteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function apply(next: TenantSecurity) {
    // Optimistic, then corrected by the revalidate. A switch that waits for a
    // round trip before moving reads as broken.
    const previous = value;
    setValue(next);
    setResult(null);
    startTransition(async () => {
      const outcome = await setMfaPolicy(next);
      setResult(outcome);
      if (!outcome.ok) setValue(previous);
    });
  }

  const state: Level = value.mfaRequiredForAllUsers
    ? 'everyone'
    : value.mfaRequiredForAdmins
      ? 'admins'
      : 'none';

  /*
    16: 02's first policy row — "Two-step sign-in" over what is required —
    with its state at the row's end. 02 draws an "On" chip; the rule is live
    here, so the end is a segmented control with the stored level dark. 02's
    "4 of 4 set up" is not drawn: nothing reads who has enrolled.

    Three levels, because the two stored flags allow exactly three sensible
    states: everyone includes admins, and "everyone except admins" is a
    combination nobody would choose on purpose.
  */
  return (
    <div className={styles.mfa} data-testid="mfa-policy">
      <div className={styles.policyRow}>
        <span className={styles.policyText}>
          <span className={styles.policyName}>{t('mfa.title')}</span>
          <span className={styles.policySub} data-testid="mfa-state">
            {t(`mfa.state.${state}`)}
          </span>
        </span>
        <span className={styles.segmented} role="group" aria-label={t('mfa.title')}>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={styles.segment}
              aria-pressed={level === state}
              data-current={level === state ? 'yes' : 'no'}
              disabled={isPending}
              data-testid={`mfa-level-${level}`}
              onClick={() => (level === state ? undefined : apply(POLICY[level]))}
            >
              {t(`mfa.level.${level}`)}
            </button>
          ))}
        </span>
      </div>
      {result && !result.ok ? (
        <p className={styles.problem} data-testid="mfa-problem">
          {result.reason === 'forbidden' ? t('forbidden') : t('mfa.failed')}
        </p>
      ) : null}
    </div>
  );
}
