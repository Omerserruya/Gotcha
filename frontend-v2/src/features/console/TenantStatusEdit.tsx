'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { SETTABLE_STATUSES, type SettableStatus } from '@/api/contracts/console';

import { ConfirmedAction, REASON_MAX } from './ConfirmedAction';
import styles from './Console.module.css';
import { setTenantStatus, type EditRefusal, type EditResult } from './edit-actions';

const isSettable = (status: string): status is SettableStatus =>
  (SETTABLE_STATUSES as readonly string[]).includes(status);

/** A refusal of a manual edit, in words. */
export function useEditRefusal() {
  const t = useTranslations('console.edit.refusal');
  return (result: { readonly reason: EditRefusal }) =>
    result.reason === 'reason_invalid'
      ? t('reason_invalid', { max: REASON_MAX })
      : t(result.reason);
}

/** The route's warnings, in words; a code this build does not know reads as one sentence. */
export function useEditWarnings() {
  const t = useTranslations('console.edit.warnings');
  return (result: { readonly warnings: readonly string[] }) => [
    ...new Set(result.warnings.map((code) => (t.has(code) ? t(code) : t('unknown')))),
  ];
}

/**
 * Set a tenant's status by hand (Backend's PATCH /status), without waiting
 * for payment or onboarding. "Trial ended" is not here: it is the PLAN's
 * state, not a status.
 *
 * The confirm says what the status does, and says beforehand when it will
 * not be enough: a tenant with no active plan stays out of the product
 * whatever its status (the route warns again after).
 */
export function TenantStatusEdit({
  tenantId,
  status,
  planActive,
}: {
  readonly tenantId: string;
  readonly status: string;
  readonly planActive: boolean;
}) {
  const t = useTranslations('console.edit');
  const refusal = useEditRefusal();
  const warnings = useEditWarnings();
  const [target, setTarget] = useState<SettableStatus | ''>(isSettable(status) ? status : '');
  const changed = target !== '' && target !== status;

  return (
    <div className={styles.assign}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('status.label')}</span>
        <select
          className={styles.select}
          value={target}
          onChange={(event) => setTarget(event.target.value as SettableStatus | '')}
          data-testid="status-target"
        >
          {isSettable(status) ? null : <option value="">{t('status.choose')}</option>}
          {SETTABLE_STATUSES.map((each) => (
            <option key={each} value={each}>
              {t(`status.options.${each}`)}
            </option>
          ))}
        </select>
      </label>
      <ConfirmedAction<EditResult>
        label={t('status.change')}
        disabled={!changed}
        sentences={
          target === ''
            ? []
            : [
                t(`status.what.${target}`),
                ...(target === 'ACTIVE' && !planActive ? [t('status.noPlan')] : []),
                t('status.nothingCharged'),
              ]
        }
        reason={t('reason')}
        yes={t('status.yes')}
        run={({ reason }) =>
          target === ''
            ? Promise.resolve({ ok: false, reason: 'invalid' } as const)
            : setTenantStatus(tenantId, target, reason)
        }
        done={() =>
          t('status.done', { status: target === '' ? '' : t(`status.options.${target}`) })
        }
        notes={warnings}
        refused={refusal}
        testid="tenant-status"
      />
    </div>
  );
}
