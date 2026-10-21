'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { useRouter } from '@/i18n/navigation';

import { renameTenant, resendOnboarding, setTenantActive } from './actions';
import { ConfirmedAction } from './ConfirmedAction';
import styles from './Console.module.css';
import { useRefusal } from './TenantBilling';

/**
 * The tenant's own controls (legacy detail page header): rename, enable or
 * disable, and resend the onboarding email. Users, features, entitlements,
 * bot settings and deleting the tenant are not here (not in this port).
 */
export function TenantControls({
  tenantId,
  name,
  status,
  isActive,
}: {
  readonly tenantId: string;
  readonly name: string;
  readonly status: string;
  readonly isActive: boolean;
}) {
  const t = useTranslations('console.controls');
  const refusal = useRefusal();

  return (
    <section className={styles.card} aria-labelledby="tenant-controls">
      <h2 id="tenant-controls" className={styles.cardTitle}>
        {t('title')}
      </h2>
      <Rename tenantId={tenantId} name={name} />
      <div className={styles.controlRow}>
        <ConfirmedAction
          label={isActive ? t('disable.label') : t('enable.label')}
          sentences={isActive ? [t('disable.what')] : [t('enable.what')]}
          yes={isActive ? t('disable.yes') : t('enable.yes')}
          run={() => setTenantActive(tenantId, !isActive)}
          done={() => (isActive ? t('disable.done') : t('enable.done'))}
          refused={refusal}
          testid="tenant-active"
        />
        {/*
         * Not for ACTIVE (onboarding is done) and not for PENDING_PAYMENT: the
         * route refuses that one (system.ts:1186), because the onboarding
         * email lets the customer into setup without paying. The payment
         * link is Billing's.
         */}
        {status !== 'ACTIVE' && status !== 'PENDING_PAYMENT' ? (
          <ConfirmedAction
            label={t('onboarding.label')}
            sentences={[t('onboarding.what')]}
            yes={t('onboarding.yes')}
            run={() => resendOnboarding(tenantId)}
            done={(result) => t('onboarding.done', { email: result.sentTo })}
            refused={refusal}
            testid="resend-onboarding"
          />
        ) : null}
      </div>
    </section>
  );
}

/** The name, saved on Save and drawn from the platform's answer after. */
function Rename({ tenantId, name }: { readonly tenantId: string; readonly name: string }) {
  const t = useTranslations('console.controls.rename');
  const refusal = useRefusal();
  const router = useRouter();
  const [draft, setDraft] = useState(name);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = draft.trim() !== '' && draft.trim() !== name;

  return (
    <form
      className={styles.assign}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!changed) return;
        setPending(true);
        setOutcome(null);
        const result = await renameTenant(tenantId, draft);
        setOutcome(
          result.ok ? { ok: true, text: t('done') } : { ok: false, text: refusal(result) },
        );
        setPending(false);
        router.refresh();
      }}
    >
      <Input
        label={t('label')}
        value={draft}
        maxLength={100}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={!changed || pending} data-testid="rename-save">
        {pending ? t('saving') : t('save')}
      </Button>
      {outcome ? (
        <p
          className={outcome.ok ? styles.done : styles.refused}
          role={outcome.ok ? 'status' : 'alert'}
          data-testid="rename-outcome"
        >
          {outcome.text}
        </p>
      ) : null}
    </form>
  );
}
