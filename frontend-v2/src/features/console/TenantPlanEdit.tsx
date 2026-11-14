'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { ProvisionablePlan } from '@/api/contracts/console';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';
import { VolumeSelect } from './CreateTenant';
import {
  manualBillingEdit,
  type ManualBillingEdit,
  type ManualBillingResult,
} from './edit-actions';
import { useEditRefusal, useEditWarnings } from './TenantStatusEdit';

const ACTIONS = ['change_plan', 'set_end_date', 'switch_to_poc', 'add_credits'] as const;
type Action = (typeof ACTIONS)[number];

/** The route's ceiling on credits given at once (`billingManualSchema`). */
const CREDITS_MAX = 1_000_000;

/** A chosen day, as the END of that day (UTC): the same rule as creating a POC. */
const endOfDay = (day: string) => (day ? `${day}T23:59:59.000Z` : '');

/**
 * A tenant's plan, end date, POC or credits, set by hand (Omer, 2026-10-23:
 * "everything, with automatic charging stopped"). Backend's POST
 * /billing/manual.
 *
 * NEVER A CHARGE, and the screen says so before and after: every plan or
 * date edit turns automatic renewal off (not charged, not renewed; access
 * ends on the period's end), credits leave renewal as it is. What billing
 * refuses, and why, is said before anyone presses anything: Shopify-billed,
 * in dunning, a date that has passed.
 */
export function TenantPlanEdit({
  tenantId,
  plans,
  domains,
}: {
  readonly tenantId: string;
  /** `undefined`: unread. */
  readonly plans: readonly ProvisionablePlan[] | undefined;
  readonly domains: readonly string[] | undefined;
}) {
  const t = useTranslations('console.edit');
  const format = useFormatter();
  const refusal = useEditRefusal();
  const warnings = useEditWarnings();
  const [action, setAction] = useState<Action>('change_plan');
  const [planId, setPlanId] = useState('');
  const [chatKey, setChatKey] = useState<string | null>(null);
  const [voiceKey, setVoiceKey] = useState<string | null>(null);
  const [ends, setEnds] = useState('');
  const [credits, setCredits] = useState('');
  const [areas, setAreas] = useState<readonly string[]>([]);
  // Read once: a date is judged against when the page drew, not on each render.
  const [now] = useState(() => Date.now());

  const plan = plans?.find((candidate) => candidate.id === planId) ?? null;
  const endsAt = endOfDay(ends);
  const endsValid = endsAt !== '' && new Date(endsAt).getTime() > now;
  const endsPast = endsAt !== '' && !endsValid;
  const creditsValue = Number(credits);
  const creditsValid =
    credits !== '' &&
    Number.isInteger(creditsValue) &&
    creditsValue > 0 &&
    creditsValue <= CREDITS_MAX;
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: 'UTC' });

  /** The edit as the route takes it, or null while it is not complete. */
  const edit: ManualBillingEdit | null =
    action === 'change_plan'
      ? plan && !endsPast
        ? {
            action,
            planVersionId: plan.id,
            chatVolumeOptionKey: chatKey,
            voiceVolumeOptionKey: voiceKey,
            ...(endsValid ? { endsAt: new Date(endsAt).toISOString() } : {}),
          }
        : null
      : action === 'set_end_date'
        ? endsValid
          ? { action, endsAt: new Date(endsAt).toISOString() }
          : null
        : action === 'switch_to_poc'
          ? creditsValid && endsValid && areas.length > 0
            ? {
                action,
                pocCredits: creditsValue,
                pocExpiresAt: new Date(endsAt).toISOString(),
                pocFeatureAreas: areas,
              }
            : null
          : creditsValid
            ? { action, units: creditsValue }
            : null;

  const sentences =
    edit === null
      ? []
      : edit.action === 'change_plan'
        ? [
            t('plan.what.change_plan', { plan: plan?.name ?? '' }),
            edit.endsAt
              ? `${t('plan.renewalOff')} ${t('plan.doneEnds', { date: day(edit.endsAt) })}`
              : t('plan.renewalOffKeep'),
          ]
        : edit.action === 'set_end_date'
          ? [t('plan.what.set_end_date', { date: day(edit.endsAt) }), t('plan.renewalOff')]
          : edit.action === 'switch_to_poc'
            ? [
                t('plan.what.switch_to_poc', {
                  credits: edit.pocCredits,
                  date: day(edit.pocExpiresAt),
                }),
                t('plan.renewalOff'),
              ]
            : [t('plan.what.add_credits', { credits: edit.units }), t('plan.renewalUnchanged')];

  const choose = (next: Action) => {
    setAction(next);
    setEnds('');
    setCredits('');
  };

  return (
    <section className={styles.card} aria-labelledby="tenant-plan-edit" data-testid="plan-edit">
      <h2 id="tenant-plan-edit" className={styles.cardTitle}>
        {t('plan.title')}
      </h2>
      <p className={styles.quiet}>{t('plan.intro')}</p>
      <p className={styles.quiet} data-testid="plan-edit-refused-upfront">
        {t('plan.refusedUpfront')}
      </p>

      <div className={styles.assign} role="radiogroup" aria-label={t('plan.actionLabel')}>
        {ACTIONS.map((each) => (
          <Button
            key={each}
            size="sm"
            role="radio"
            aria-checked={action === each}
            variant={action === each ? 'primary' : 'secondary'}
            onClick={() => choose(each)}
            data-testid={`plan-action-${each}`}
          >
            {t(`plan.actions.${each}`)}
          </Button>
        ))}
      </div>

      {action === 'change_plan' ? (
        plans === undefined ? (
          <p className={styles.refused} role="alert" data-testid="plan-edit-plans-unread">
            {t('plan.plansUnread')}
          </p>
        ) : (
          <div className={styles.assign}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('plan.plan')}</span>
              <select
                className={styles.select}
                value={planId}
                onChange={(event) => {
                  setPlanId(event.target.value);
                  setChatKey(null);
                  setVoiceKey(null);
                }}
                data-testid="plan-edit-plan"
              >
                <option value="">{t('plan.choosePlan')}</option>
                {plans.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            {plan?.chatVolumeEnabled && plan.chatOptions.length > 0 ? (
              <VolumeSelect
                label={t('plan.chatVolume')}
                options={plan.chatOptions}
                value={chatKey}
                onChange={setChatKey}
                testid="plan-edit-chat"
              />
            ) : null}
            {plan?.voiceVolumeEnabled && plan.voiceOptions.length > 0 ? (
              <VolumeSelect
                label={t('plan.voiceVolume')}
                options={plan.voiceOptions}
                value={voiceKey}
                onChange={setVoiceKey}
                testid="plan-edit-voice"
              />
            ) : null}
            <Input
              label={t('plan.endsAtOptional')}
              type="date"
              value={ends}
              error={endsPast ? t('plan.endsPast') : undefined}
              onChange={(event) => setEnds(event.target.value)}
            />
          </div>
        )
      ) : null}

      {action === 'set_end_date' ? (
        <div className={styles.assign}>
          <Input
            label={t('plan.endsAt')}
            type="date"
            value={ends}
            error={endsPast ? t('plan.endsPast') : undefined}
            onChange={(event) => setEnds(event.target.value)}
          />
        </div>
      ) : null}

      {action === 'switch_to_poc' || action === 'add_credits' ? (
        <div className={styles.assign}>
          <Input
            label={t('plan.credits')}
            inputMode="numeric"
            value={credits}
            error={
              credits === '' || creditsValid
                ? undefined
                : t('plan.creditsInvalid', { max: format.number(CREDITS_MAX) })
            }
            onChange={(event) => setCredits(event.target.value)}
          />
          {action === 'switch_to_poc' ? (
            <Input
              label={t('plan.endsAt')}
              type="date"
              value={ends}
              error={endsPast ? t('plan.endsPast') : undefined}
              onChange={(event) => setEnds(event.target.value)}
            />
          ) : null}
        </div>
      ) : null}

      {action === 'switch_to_poc' ? (
        domains === undefined ? (
          <p className={styles.refused} role="alert" data-testid="plan-edit-areas-unread">
            {t('plan.areasUnread')}
          </p>
        ) : (
          <fieldset className={`${styles.assign} ${styles.fieldset}`} data-testid="plan-edit-areas">
            <legend className={styles.fieldLabel}>{t('plan.areas')}</legend>
            {domains.map((domain) => {
              const on = areas.includes(domain);
              return (
                <Button
                  key={domain}
                  size="sm"
                  aria-pressed={on}
                  variant={on ? 'primary' : 'secondary'}
                  onClick={() =>
                    setAreas(on ? areas.filter((area) => area !== domain) : [...areas, domain])
                  }
                >
                  <span dir="ltr">{domain.replace(/_/g, ' ')}</span>
                </Button>
              );
            })}
          </fieldset>
        )
      ) : null}

      <ConfirmedAction<ManualBillingResult>
        label={t(`plan.actions.${action}`)}
        variant="primary"
        disabled={edit === null}
        sentences={sentences}
        reason={t('reason')}
        yes={t('plan.yes')}
        run={({ reason }) =>
          edit === null
            ? Promise.resolve({ ok: false, reason: 'invalid' } as const)
            : manualBillingEdit(tenantId, edit, reason)
        }
        done={(result) =>
          [
            t(`plan.done.${action}`),
            ...(result.renewal === 'off' ? [t('plan.doneRenewalOff')] : []),
            ...(result.renewal === 'off' && result.after?.currentPeriodEnd
              ? [t('plan.doneEnds', { date: day(result.after.currentPeriodEnd) })]
              : []),
          ].join(' ')
        }
        notes={warnings}
        refused={refusal}
        testid="plan-edit-submit"
      />
    </section>
  );
}
