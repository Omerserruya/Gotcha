'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { PlanChangePreview } from '@/api/contracts/billing';
import { useRouter } from '@/i18n/navigation';

import { changePlanTo, previewPlanChange, type ChangePlanResult } from './actions';
import styles from './Billing.module.css';

type State =
  | { readonly kind: 'closed' }
  | { readonly kind: 'asking' }
  | { readonly kind: 'shown'; readonly preview: PlanChangePreview; readonly moved: boolean }
  | { readonly kind: 'working'; readonly preview: PlanChangePreview }
  | { readonly kind: 'done'; readonly result: Extract<ChangePlanResult, { ok: true }> }
  | { readonly kind: 'problem'; readonly text: string; readonly retry: boolean };

/**
 * 17b's Switch, live (BILLING_WRITES=on): the server's preview first - the
 * exact gross that leaves the card, or why nothing is charged now - then the
 * change, sending that figure back (billing 42c52c6e). A figure that moved
 * since (409) is re-shown and asked again; nothing was charged. An outcome
 * that is not known is said as that, with no Try again.
 */
export function PlanSwitch({
  planKey,
  planName,
  label,
  className,
}: {
  readonly planKey: string;
  readonly planName: string;
  readonly label: string;
  readonly className?: string;
}) {
  const t = useTranslations('billing.choice.live');
  const format = useFormatter();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'closed' });

  const money = (amount: string, currency: string) =>
    format.number(Number(amount), { style: 'currency', currency });
  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'long' }) : null;

  const ask = async (moved = false) => {
    setState({ kind: 'asking' });
    const answer = await previewPlanChange(planKey);
    setState(
      answer.ok
        ? { kind: 'shown', preview: answer.preview, moved }
        : { kind: 'problem', text: t(`previewRefused.${answer.reason}`), retry: true },
    );
  };

  const sentences = (p: PlanChangePreview): { said: string[]; can: boolean } => {
    const monthly = p.newMonthly ? money(p.newMonthly.amount, p.newMonthly.currency) : null;
    if (p.refused) {
      return {
        said: [
          p.refused.code === 'charge_not_taxable' ? t('refused.taxable') : t('refused.priceable'),
        ],
        can: false,
      };
    }
    if (p.chargeNow) {
      if (p.hasPaymentMethod === false) return { said: [t('noCard')], can: false };
      const c = p.chargeNow;
      return {
        said: [
          t('chargeNow', {
            plan: planName,
            gross: money(c.gross, c.chargeCurrency),
            tax: money(c.tax, c.chargeCurrency),
          }),
          ...(monthly ? [t('thenMonthly', { price: monthly })] : []),
        ],
        can: true,
      };
    }
    if (p.applied === 'scheduled') {
      const when = date(p.effectiveAt);
      return {
        said: [
          when
            ? t('scheduled', { plan: planName, date: when })
            : t('scheduledNoDate', { plan: planName }),
          ...(monthly ? [t('thenMonthly', { price: monthly })] : []),
        ],
        can: true,
      };
    }
    return {
      said: [
        t('nothingNow', { plan: planName }),
        ...(monthly ? [t('thenMonthly', { price: monthly })] : []),
      ],
      can: true,
    };
  };

  const go = async (p: PlanChangePreview) => {
    setState({ kind: 'working', preview: p });
    const result = await changePlanTo(planKey, {
      gross: p.chargeNow?.gross ?? null,
      fxRateVersion: p.chargeNow?.fxRateVersion ?? null,
    });
    if (result.ok) {
      setState({ kind: 'done', result });
      router.refresh();
      return;
    }
    if (result.reason === 'moved') {
      await ask(true);
      return;
    }
    setState({
      kind: 'problem',
      text: t(`changeRefused.${result.reason}`),
      // A charge that may have gone through is never offered again.
      retry: result.reason !== 'unknown',
    });
  };

  if (state.kind === 'closed') {
    return (
      <button
        type="button"
        className={className}
        data-testid="switch-button"
        onClick={() => void ask()}
      >
        {label}
      </button>
    );
  }
  if (state.kind === 'done') {
    const when = date(state.result.effectiveAt);
    return (
      <p className={styles.profileSaved} role="status" data-testid="switch-done">
        {state.result.applied === 'immediate'
          ? t('doneNow', { plan: planName })
          : when
            ? t('doneScheduled', { plan: planName, date: when })
            : t('doneScheduledNoDate', { plan: planName })}
      </p>
    );
  }
  if (state.kind === 'asking') {
    return (
      <p className={styles.heldSentence} role="status" data-testid="switch-asking">
        {t('asking')}
      </p>
    );
  }
  if (state.kind === 'problem') {
    return (
      <div className={styles.heldConfirm} data-testid="switch-button-confirm">
        <p className={styles.profileProblem} role="alert" data-testid="switch-problem">
          {state.text}
        </p>
        <p className={styles.heldActions}>
          {state.retry ? (
            <button
              type="button"
              className={styles.heldCancel}
              data-testid="switch-retry"
              onClick={() => void ask()}
            >
              {t('again')}
            </button>
          ) : null}
        </p>
      </div>
    );
  }

  const p = state.preview;
  const { said, can } = sentences(p);
  const working = state.kind === 'working';
  return (
    <div className={styles.heldConfirm} role="group" data-testid="switch-button-confirm">
      {state.kind === 'shown' && state.moved ? (
        <p className={styles.profileProblem} role="alert" data-testid="switch-moved">
          {t('moved')}
        </p>
      ) : null}
      {said.map((sentence, i) => (
        <p key={i} className={styles.heldSentence}>
          {sentence}
        </p>
      ))}
      <p className={styles.heldActions}>
        {can ? (
          <button
            type="button"
            className={styles.cardGo}
            disabled={working}
            data-testid="switch-button-yes"
            onClick={() => void go(p)}
          >
            {working
              ? t('switching')
              : p.chargeNow
                ? t('yesCharge', { gross: money(p.chargeNow.gross, p.chargeNow.chargeCurrency) })
                : t('yes', { plan: planName })}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.heldCancel}
          disabled={working}
          data-testid="switch-button-cancel"
          onClick={() => setState({ kind: 'closed' })}
        >
          {t('cancel')}
        </button>
      </p>
    </div>
  );
}
