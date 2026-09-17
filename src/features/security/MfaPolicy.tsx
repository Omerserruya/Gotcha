'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { TenantSecurity } from '@/api/contracts/security';

import { setMfaPolicy, type SecurityWriteResult } from './actions';
import styles from './Security.module.css';

/**
 * Who must use two-factor authentication.
 *
 * Two switches and one policy. Requiring it of everyone necessarily includes
 * admins, so turning the wider one on turns the narrower one on with it and
 * says so — leaving them independent would allow "everyone except admins",
 * which is a combination nobody would choose on purpose and which the wording
 * of the two controls does not suggest is possible.
 *
 * The design also asks for SSO and a Google domain. No field for either exists
 * on this route, and it may be an identity-provider setting rather than one of
 * ours, so the screen draws no control for it.
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

  return (
    <div className={styles.block} data-testid="mfa-policy">
      <label className={styles.switchRow}>
        <input
          type="checkbox"
          checked={value.mfaRequiredForAdmins}
          disabled={isPending || value.mfaRequiredForAllUsers}
          data-testid="mfa-admins"
          onChange={(e) => apply({ ...value, mfaRequiredForAdmins: e.target.checked })}
        />
        <span>
          <span className={styles.switchLabel}>{t('mfa.admins')}</span>
          {/*
            Disabled rather than hidden while "everyone" is on, with the reason
            stated. A control that silently stops responding is worse than one
            that explains why it cannot move.
          */}
          {value.mfaRequiredForAllUsers ? (
            <span className={styles.switchNote}>{t('mfa.impliedByEveryone')}</span>
          ) : null}
        </span>
      </label>

      <label className={styles.switchRow}>
        <input
          type="checkbox"
          checked={value.mfaRequiredForAllUsers}
          disabled={isPending}
          data-testid="mfa-everyone"
          onChange={(e) =>
            apply(
              e.target.checked
                ? { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true }
                : { ...value, mfaRequiredForAllUsers: false },
            )
          }
        />
        <span className={styles.switchLabel}>{t('mfa.everyone')}</span>
      </label>

      {result && !result.ok ? (
        <p className={styles.problem} data-testid="mfa-problem">
          {result.reason === 'forbidden' ? t('forbidden') : t('mfa.failed')}
        </p>
      ) : null}
    </div>
  );
}
