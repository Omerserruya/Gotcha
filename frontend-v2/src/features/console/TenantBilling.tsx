'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { PlanAccess, ProvisionablePlan, ProvisioningStatus } from '@/api/contracts/console';
import { UserText } from '@/design-system/primitives/text/UserText';

import { assignPaidPlan, repairBilling, resendPaymentLink, type ConsoleWrite } from './actions';
import type { CouponWrite } from './coupon-actions';
import { PlanAccessBadge } from './badges';
import { repairOffered, tenantBillingState } from './billing-state';
import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';

type Refusal =
  Extract<ConsoleWrite, { ok: false }>['reason'] | Extract<CouponWrite, { ok: false }>['reason'];

/** A refusal in words - one sentence per reason, the wait when the route sent one. */
export function useRefusal() {
  const t = useTranslations('console.refusal');
  return (result: { readonly reason: Refusal; readonly retryAfterSeconds?: number | null }) =>
    result.reason === 'rate_limited' && result.retryAfterSeconds
      ? t('rate_limited_wait', { seconds: result.retryAfterSeconds })
      : t(result.reason);
}

/**
 * Billing oversight for one tenant (legacy `TenantBillingActions` and the
 * provisioning facts behind it).
 *
 * Resend and Repair, never both: a tenant waiting on its CUSTOMER gets the
 * link resent; one whose setup never finished gets it repaired. Each is
 * confirmed first, says what the route answered after, and re-reads the page.
 */
export function TenantBilling({
  tenantId,
  status,
  access,
  provisioning,
  plans,
}: {
  readonly tenantId: string;
  readonly status: string;
  readonly access: PlanAccess;
  readonly provisioning: ProvisioningStatus | undefined;
  readonly plans: readonly ProvisionablePlan[] | undefined;
}) {
  const t = useTranslations('console.billingPanel');
  const format = useFormatter();
  const refusal = useRefusal();
  const state = tenantBillingState(status, provisioning);

  return (
    <section className={styles.card} aria-labelledby="tenant-billing" data-testid="tenant-billing">
      <h2 id="tenant-billing" className={styles.cardTitle}>
        {t('title')}
      </h2>

      <dl className={styles.facts}>
        <dt>{t('plan')}</dt>
        <dd>
          <PlanAccessBadge access={access} />
          {access.planName ? (
            <>
              {' '}
              <UserText>{access.planName}</UserText>
            </>
          ) : null}
        </dd>
        <dt>{t('setup')}</dt>
        <dd data-testid="provisioning-state">
          {provisioning === undefined
            ? t('setupUnread')
            : provisioning === null
              ? t('setupNone')
              : t(`setupState.${knownSetupState(provisioning.state)}`, {
                  state: provisioning.state,
                })}
        </dd>
        {provisioning ? (
          <>
            <dt>{t('attempts')}</dt>
            <dd>
              {provisioning.lastAttemptAt
                ? t('attemptsLast', {
                    count: provisioning.attemptCount,
                    at: format.dateTime(new Date(provisioning.lastAttemptAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      hourCycle: 'h23',
                    }),
                  })
                : t('attemptsCount', { count: provisioning.attemptCount })}
            </dd>
          </>
        ) : null}
        {provisioning?.lastFailureMessage && provisioning.state !== 'COMPLETED' ? (
          <>
            <dt>{t('lastFailure')}</dt>
            <dd data-testid="provisioning-failure">
              <UserText>{provisioning.lastFailureMessage}</UserText>
            </dd>
          </>
        ) : null}
      </dl>

      {state === 'PENDING_PAYMENT_READY' ? (
        <ConfirmedAction
          label={t('resend.label')}
          sentences={[t('resend.what'), t('resend.old')]}
          yes={t('resend.yes')}
          run={() => resendPaymentLink(tenantId)}
          done={(result) => t('resend.done', { email: result.sentTo })}
          refused={refusal}
          testid="resend-payment"
        />
      ) : null}

      {repairOffered(status, provisioning) ? (
        <ConfirmedAction
          label={t('repair.label')}
          sentences={[t('repair.what'), t('repair.nothing')]}
          yes={t('repair.yes')}
          run={() => repairBilling(tenantId)}
          done={(result) =>
            result.emailSent === true
              ? t('repair.doneEmailed')
              : result.emailSent === false
                ? t('repair.doneNotEmailed')
                : t('repair.done')
          }
          refused={refusal}
          testid="repair-billing"
        />
      ) : provisioning && provisioning.state !== 'COMPLETED' && !provisioning.canRepair ? (
        <p className={styles.quiet} data-testid="repair-impossible">
          {t('repair.impossible')}
        </p>
      ) : null}

      {access.needsReview ? (
        <MissingPlan tenantId={tenantId} access={access} plans={plans} />
      ) : null}
    </section>
  );
}

const SETUP_STATES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED_RETRYABLE',
  'FAILED_PERMANENT',
  'CANCELLED',
] as const;
const knownSetupState = (state: string) =>
  (SETUP_STATES as readonly string[]).includes(state) ? state : 'other';

/**
 * A tenant with no plan to speak of (legacy `MissingPlanBanner`): why, and
 * the way out. Nothing is assigned automatically - assigning a plan to an
 * organization that never chose one would invent a commercial agreement. Two
 * active plans is a commercial decision this screen cannot make, so it only
 * says so.
 */
function MissingPlan({
  tenantId,
  access,
  plans,
}: {
  readonly tenantId: string;
  readonly access: PlanAccess;
  readonly plans: readonly ProvisionablePlan[] | undefined;
}) {
  const t = useTranslations('console.missingPlan');
  const refusal = useRefusal();
  const [planId, setPlanId] = useState('');
  const plan = plans?.find((candidate) => candidate.id === planId) ?? null;
  const why =
    access.state === 'CONFLICTING'
      ? t('why.CONFLICTING')
      : access.state === 'SETUP_INCOMPLETE'
        ? t('why.SETUP_INCOMPLETE')
        : access.state === 'EXPIRED'
          ? t('why.EXPIRED')
          : t('why.MISSING');

  return (
    <div className={styles.notice} data-testid="missing-plan">
      <p className={styles.noticeTitle}>{t('title')}</p>
      <p className={styles.confirmSentence}>{why}</p>
      <p className={styles.quiet}>{t('blocked')}</p>
      {access.state === 'CONFLICTING' ? null : plans === undefined ? (
        <p className={styles.refused} role="alert" data-testid="plans-unread">
          {t('plansUnread')}
        </p>
      ) : plans.length === 0 ? (
        <p className={styles.quiet} data-testid="plans-none">
          {t('plansNone')}
        </p>
      ) : (
        <div className={styles.assign}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('plan')}</span>
            <select
              className={styles.select}
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
              data-testid="assign-plan-select"
            >
              <option value="">{t('choose')}</option>
              {plans.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <ConfirmedAction
            label={t('assign.label')}
            disabled={!plan}
            sentences={
              plan
                ? [t('assign.what', { plan: plan.name }), t('assign.nothing'), t('assign.poc')]
                : []
            }
            yes={t('assign.yes')}
            run={() => assignPaidPlan(tenantId, planId)}
            done={(result) =>
              result.emailSent === false ? t('assign.doneNotEmailed') : t('assign.done')
            }
            refused={refusal}
            testid="assign-plan"
          />
        </div>
      )}
    </div>
  );
}
