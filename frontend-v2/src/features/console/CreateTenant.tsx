'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import type { ProvisionablePlan, ProvisioningQuote } from '@/api/contracts/console';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';
import { createTenant, quoteProvisioning, type NewTenant } from './create-actions';

/** Legacy's slug rule, the route's own regex (system.ts:342). */
export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const SLUG = /^[a-z0-9-]{2,50}$/;

type Quote =
  | { readonly state: 'none' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly quote: ProvisioningQuote }
  | { readonly state: 'refused'; readonly reason: 'plan_gone' | 'volume_invalid' | 'failed' };

/**
 * Create an organization (legacy tenants page's form and `BillingSection`).
 *
 * Two ways, and no third: a PAID plan or a POC. "No billing" is gone on the
 * route (system.ts:280) - an organization without a commercial decision is
 * the thing it exists to prevent.
 *
 * Paid: the plan and its volume options by KEY, and the SERVER's quote, read
 * again on every change - the screen computes no figure, so what the operator
 * approves is what provisioning freezes. POC: a credit budget given away, an
 * expiry, and the feature areas it may use (anything unselected is off).
 */
export function CreateTenant({
  plans,
  domains,
}: {
  readonly plans: readonly ProvisionablePlan[] | undefined;
  readonly domains: readonly string[] | undefined;
}) {
  const t = useTranslations('console.create');
  const tRefusal = useTranslations('console.create.refusal');
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [mode, setMode] = useState<'PAID_PLAN' | 'POC'>('PAID_PLAN');
  const [planId, setPlanId] = useState('');
  const [chatKey, setChatKey] = useState<string | null>(null);
  const [voiceKey, setVoiceKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [credits, setCredits] = useState('');
  const [expires, setExpires] = useState('');
  const [areas, setAreas] = useState<readonly string[]>([]);
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly result: Awaited<ReturnType<typeof quoteProvisioning>>;
  } | null>(null);
  // Read once: the expiry is judged against when the page drew, not on each render.
  const [now] = useState(() => Date.now());

  const plan = plans?.find((candidate) => candidate.id === planId) ?? null;

  /*
   * The server is the only source of the total: asked again on every change
   * of selection, and an answer counts only for the selection it was asked
   * for - a slow answer to an older choice is never the one approved.
   */
  const selectionKey =
    mode === 'PAID_PLAN' && planId ? `${planId}|${chatKey ?? ''}|${voiceKey ?? ''}` : null;
  useEffect(() => {
    if (!selectionKey) return;
    let cancelled = false;
    void quoteProvisioning({
      planVersionId: planId,
      chatVolumeOptionKey: chatKey,
      voiceVolumeOptionKey: voiceKey,
    }).then((result) => {
      if (!cancelled) setAnswer({ key: selectionKey, result });
    });
    return () => {
      cancelled = true;
    };
  }, [selectionKey, planId, chatKey, voiceKey]);
  const quote: Quote = !selectionKey
    ? { state: 'none' }
    : answer?.key !== selectionKey
      ? { state: 'loading' }
      : answer.result.ok
        ? { state: 'ready', quote: answer.result.quote }
        : { state: 'refused', reason: answer.result.reason };

  if (!open) {
    return (
      <Button variant="primary" size="sm" onClick={() => setOpen(true)} data-testid="create-open">
        {t('open')}
      </Button>
    );
  }

  const creditsValue = Number(credits);
  const creditsValid =
    Number.isInteger(creditsValue) && creditsValue > 0 && creditsValue <= 1_000_000;
  const expiryInstant = expires ? `${expires}T23:59:59.000Z` : '';
  const expiryValid = !!expiryInstant && new Date(expiryInstant).getTime() > now;
  const billingReady =
    mode === 'PAID_PLAN'
      ? !!planId && quote.state === 'ready'
      : creditsValid && expiryValid && areas.length > 0;
  const ready =
    name.trim() !== '' &&
    SLUG.test(slug) &&
    adminName.trim() !== '' &&
    /^\S+@\S+\.\S+$/.test(adminEmail.trim()) &&
    billingReady;

  const input: NewTenant = {
    name: name.trim(),
    slug,
    adminEmail: adminEmail.trim(),
    adminName: adminName.trim(),
    billing:
      mode === 'PAID_PLAN'
        ? {
            mode,
            planVersionId: planId,
            chatVolumeOptionKey: chatKey,
            voiceVolumeOptionKey: voiceKey,
            ...(note.trim() ? { commercialNote: note.trim() } : {}),
          }
        : {
            mode,
            pocCredits: creditsValue,
            pocExpiresAt: expiryInstant ? new Date(expiryInstant).toISOString() : '',
            pocFeatureAreas: areas,
            ...(note.trim() ? { commercialNote: note.trim() } : {}),
          },
  };
  const money = (amount: string, currency: string) =>
    format.number(Number(amount), { style: 'currency', currency, maximumFractionDigits: 2 });

  return (
    <section className={styles.card} aria-labelledby="create-tenant" data-testid="create-tenant">
      <h2 id="create-tenant" className={styles.cardTitle}>
        {t('title')}
      </h2>
      <div className={styles.assign}>
        <Input
          label={t('name')}
          value={name}
          maxLength={100}
          onChange={(event) => {
            const next = event.target.value;
            // The slug follows the name until somebody edits it.
            if (slug === '' || slug === slugify(name)) setSlug(slugify(next));
            setName(next);
          }}
        />
        <Input
          label={t('slug')}
          value={slug}
          dir="ltr"
          maxLength={50}
          hint={t('slugHint')}
          error={slug === '' || SLUG.test(slug) ? undefined : t('slugInvalid')}
          onChange={(event) => setSlug(event.target.value)}
        />
        <Input
          label={t('adminName')}
          value={adminName}
          onChange={(e) => setAdminName(e.target.value)}
        />
        <Input
          label={t('adminEmail')}
          type="email"
          dir="ltr"
          value={adminEmail}
          onChange={(event) => setAdminEmail(event.target.value)}
        />
      </div>

      <div className={styles.assign} role="radiogroup" aria-label={t('billingType')}>
        {(['PAID_PLAN', 'POC'] as const).map((each) => (
          <Button
            key={each}
            size="sm"
            role="radio"
            aria-checked={mode === each}
            variant={mode === each ? 'primary' : 'secondary'}
            onClick={() => setMode(each)}
            data-testid={`mode-${each}`}
          >
            {each === 'PAID_PLAN' ? t('paid') : t('poc')}
          </Button>
        ))}
      </div>

      {mode === 'PAID_PLAN' ? (
        plans === undefined ? (
          <p className={styles.refused} role="alert" data-testid="create-plans-unread">
            {t('plansUnread')}
          </p>
        ) : (
          <>
            <div className={styles.assign}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('plan')}</span>
                <select
                  className={styles.select}
                  value={planId}
                  onChange={(event) => {
                    setPlanId(event.target.value);
                    setChatKey(null);
                    setVoiceKey(null);
                  }}
                  data-testid="create-plan"
                >
                  <option value="">{t('choosePlan')}</option>
                  {plans.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              {plan?.chatVolumeEnabled && plan.chatOptions.length > 0 ? (
                <VolumeSelect
                  label={t('chatVolume')}
                  options={plan.chatOptions}
                  value={chatKey}
                  onChange={setChatKey}
                  testid="create-chat"
                />
              ) : null}
              {plan?.voiceVolumeEnabled && plan.voiceOptions.length > 0 ? (
                <VolumeSelect
                  label={t('voiceVolume')}
                  options={plan.voiceOptions}
                  value={voiceKey}
                  onChange={setVoiceKey}
                  testid="create-voice"
                />
              ) : null}
            </div>
            {quote.state === 'loading' ? <p className={styles.quiet}>{t('quoting')}</p> : null}
            {quote.state === 'refused' ? (
              <p className={styles.refused} role="alert" data-testid="create-quote-refused">
                {t(`quoteRefused.${quote.reason}`)}
              </p>
            ) : null}
            {quote.state === 'ready' ? (
              <dl className={styles.facts} data-testid="create-quote">
                <dt>{t('quote.plan')}</dt>
                <dd>{quote.quote.planName}</dd>
                <dt>{t('quote.total')}</dt>
                <dd>
                  {t('quote.per', {
                    amount: money(quote.quote.totalAmount, quote.quote.currency),
                    interval: quote.quote.billingInterval === 'ANNUAL' ? 'year' : 'month',
                  })}
                </dd>
                <dt>{t('quote.credits')}</dt>
                <dd>{format.number(quote.quote.includedCredits)}</dd>
                <dt>{t('quote.after')}</dt>
                <dd>{t('quote.pendingPayment')}</dd>
              </dl>
            ) : null}
            {quote.state === 'ready' && !quote.quote.chargeableToday ? (
              <p className={styles.notice} data-testid="create-not-chargeable">
                {t('quote.notChargeable')}
              </p>
            ) : null}
          </>
        )
      ) : (
        <>
          <div className={styles.assign}>
            <Input
              label={t('credits')}
              inputMode="numeric"
              value={credits}
              error={credits === '' || creditsValid ? undefined : t('creditsInvalid')}
              onChange={(event) => setCredits(event.target.value)}
            />
            <Input
              label={t('expires')}
              type="date"
              value={expires}
              error={expires === '' || expiryValid ? undefined : t('expiresPast')}
              onChange={(event) => setExpires(event.target.value)}
            />
          </div>
          {domains === undefined ? (
            <p className={styles.refused} role="alert" data-testid="create-domains-unread">
              {t('domainsUnread')}
            </p>
          ) : (
            <fieldset
              className={`${styles.assign} ${styles.fieldset}`}
              data-testid="create-domains"
            >
              <legend className={styles.fieldLabel}>{t('areas')}</legend>
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
          )}
          <p className={styles.quiet}>{t('areasOff')}</p>
          <p className={styles.confirmSentence}>{t('pocFree')}</p>
        </>
      )}

      <Input
        label={t('note')}
        value={note}
        maxLength={2000}
        placeholder={t('notePlaceholder')}
        onChange={(event) => setNote(event.target.value)}
      />

      <span className={styles.confirmActions}>
        <Button size="sm" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </span>
      <ConfirmedAction
        label={t('submit')}
        variant="primary"
        disabled={!ready}
        sentences={
          mode === 'PAID_PLAN'
            ? [
                t('confirmPaid', { name: input.name, email: input.adminEmail }),
                t('confirmPaidNothing'),
              ]
            : [
                t('confirmPoc', {
                  name: input.name,
                  credits: creditsValid ? creditsValue : 0,
                  email: input.adminEmail,
                }),
              ]
        }
        yes={t('yes')}
        run={() => createTenant(input)}
        done={() =>
          mode === 'PAID_PLAN'
            ? t('donePaid', { name: input.name })
            : t('donePoc', { name: input.name })
        }
        refused={(result) =>
          result.reason === 'setup_incomplete'
            ? t('setupIncomplete', { name: input.name })
            : tRefusal(result.reason)
        }
        testid="create-submit"
      />
    </section>
  );
}

function VolumeSelect({
  label,
  options,
  value,
  onChange,
  testid,
}: {
  readonly label: string;
  readonly options: readonly { readonly key: string; readonly dailyVolume: number }[];
  readonly value: string | null;
  readonly onChange: (key: string | null) => void;
  readonly testid: string;
}) {
  const t = useTranslations('console.create');
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <select
        className={styles.select}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        data-testid={testid}
      >
        <option value="">{t('planDefault')}</option>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {t('perDay', { count: option.dailyVolume })}
          </option>
        ))}
      </select>
    </label>
  );
}
