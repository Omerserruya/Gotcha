'use client';

import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { SETTABLE_BEHAVIORS, type LimitBehavior } from '@/api/contracts/auto-purchase';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';

import { AUTO_PURCHASE_FORM_ID } from './auto-purchase-form';
import styles from './Billing.module.css';

type Option = 'pack' | 'payg' | 'stop';
type Settable = (typeof SETTABLE_BEHAVIORS)[number];

/** A pack on sale, as the confirm names it. */
export interface PackChoice {
  readonly key: string;
  readonly name: string;
  /** "₪290", or null when the shelf stated no price. */
  readonly price: string | null;
}

/**
 * 17c's three answers, editable - and held at the confirm.
 *
 * Auto-purchase's PUT is database only, but turning it on ARMS real charges:
 * every time credits fall below the threshold the stored card is charged, and
 * dev's billing is the production payment account. So Save (the overlay's
 * footer, by `form=`) opens the confirm - what this would do, in words - and
 * its Yes is the held status. Pay-as-you-go is honoured and refused by the
 * setter: shown, not choosable.
 */
export function AutoPurchaseForm({
  initialOption,
  initialThreshold,
  initialCap,
  initialBehavior,
  packs,
  currency,
  card,
  current,
  heldTag,
  heldWhy,
}: {
  readonly initialOption: Option;
  readonly initialThreshold: number;
  readonly initialCap: string | null;
  readonly initialBehavior: LimitBehavior;
  readonly packs: readonly PackChoice[];
  readonly currency: string;
  /** "Visa ending 4417"; null when there is none; 'unknown' when unread. */
  readonly card: string | null | 'unknown';
  /** What each answer holds now, as the server drew it. */
  readonly current: {
    readonly pack: ReactNode;
    readonly payg: ReactNode;
    readonly stop: ReactNode;
  };
  readonly heldTag: string;
  readonly heldWhy: string;
}) {
  const t = useTranslations('billing.autoPurchase');
  const [option, setOption] = useState<Option>(initialOption);
  const [packKey, setPackKey] = useState(packs[0]?.key ?? '');
  const [threshold, setThreshold] = useState(String(initialThreshold));
  const [cap, setCap] = useState(initialCap ?? '');
  const [behavior, setBehavior] = useState<Settable>(
    (SETTABLE_BEHAVIORS as readonly string[]).includes(initialBehavior)
      ? (initialBehavior as Settable)
      : 'STOP_AI',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<readonly string[] | null>(null);

  /** What Yes would do, or why it cannot be asked. */
  const sentences = (): readonly string[] | string => {
    if (option === 'payg') return t('edit.paygNotSettable');
    const tail = t(`behavior.${behavior}`);
    if (option === 'stop') return [t('edit.confirmStop'), tail];
    const pack = packs.find((p) => p.key === packKey);
    if (!pack) return t('edit.pickPack');
    const pct = Number(threshold);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) return t('edit.badThreshold');
    const limit = cap.trim();
    if (limit && !(Number(limit) > 0)) return t('edit.badCap');
    if (card === null) return t('edit.confirmNoCard');
    return [
      card === 'unknown'
        ? t('edit.confirmPackCardUnknown', {
            pack: pack.name,
            price: pack.price ?? '-',
            threshold: pct,
          })
        : t('edit.confirmPack', {
            pack: pack.name,
            price: pack.price ?? '-',
            threshold: pct,
            card,
          }),
      limit ? t('edit.confirmCap', { cap: limit, currency }) : t('edit.confirmNoCap'),
      tail,
    ];
  };

  const radio = (key: Option, body: ReactNode, disabledWhy?: string) => (
    <label
      className={styles.lowOption}
      data-current={option === key ? 'yes' : 'no'}
      data-testid={`auto-option-${key}`}
      title={disabledWhy}
    >
      <input
        type="radio"
        name="auto-option"
        className="srOnly"
        value={key}
        checked={option === key}
        disabled={disabledWhy !== undefined}
        data-testid={`auto-choose-${key}`}
        onChange={() => {
          setProblem(null);
          setConfirming(null);
          setOption(key);
        }}
      />
      <span className={styles.lowRadio} aria-hidden="true" />
      <span className={styles.lowOptionBody}>
        <span className={styles.lowOptionName}>{t(`option.${key}`)}</span>
        {body}
      </span>
    </label>
  );

  return (
    <form
      id={AUTO_PURCHASE_FORM_ID}
      data-testid="auto-purchase-form"
      onSubmit={(e) => {
        e.preventDefault();
        const said = sentences();
        if (typeof said === 'string') {
          setConfirming(null);
          setProblem(said);
        } else {
          setProblem(null);
          setConfirming(said);
        }
      }}
    >
      {radio(
        'pack',
        <>
          {current.pack}
          {option === 'pack' ? (
            <span className={styles.autoFields}>
              <label className={styles.detailsField}>
                <span className={styles.detailsLabel}>{t('edit.pack')}</span>
                <select
                  className={styles.detailsInput}
                  value={packKey}
                  data-testid="auto-pack"
                  onChange={(e) => setPackKey(e.target.value)}
                >
                  {packs.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.price ? `${p.name} · ${p.price}` : p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.detailsField}>
                <span className={styles.detailsLabel}>{t('edit.threshold')}</span>
                <input
                  className={styles.detailsInput}
                  inputMode="numeric"
                  value={threshold}
                  data-testid="auto-threshold"
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </label>
              <label className={styles.detailsField}>
                <span className={styles.detailsLabel}>{t('edit.cap', { currency })}</span>
                <input
                  className={styles.detailsInput}
                  inputMode="decimal"
                  value={cap}
                  placeholder={t('edit.capNone')}
                  data-testid="auto-cap-input"
                  onChange={(e) => setCap(e.target.value)}
                />
              </label>
            </span>
          ) : null}
        </>,
      )}
      {radio('payg', current.payg, t('edit.paygNotSettable'))}
      {radio('stop', current.stop)}

      <h3 className={styles.lowHeading}>{t('ifReached')}</h3>
      <select
        className={styles.detailsInput}
        value={behavior}
        aria-label={t('ifReached')}
        data-testid="auto-behavior-choice"
        onChange={(e) => setBehavior(e.target.value as Settable)}
      >
        {SETTABLE_BEHAVIORS.map((b) => (
          <option key={b} value={b}>
            {t(`behavior.${b}`)}
          </option>
        ))}
      </select>

      {problem ? (
        <p className={styles.profileProblem} role="alert" data-testid="auto-problem">
          {problem}
        </p>
      ) : null}
      {confirming ? (
        <div className={styles.heldConfirm} role="group" data-testid="auto-confirm">
          {confirming.map((sentence, i) => (
            <p key={i} className={styles.heldSentence}>
              {sentence}
            </p>
          ))}
          <p className={styles.heldActions}>
            <UnavailableAction
              label={t('edit.yes')}
              tag={heldTag}
              why={heldWhy}
              testid="auto-yes"
            />
            <button
              type="button"
              className={styles.heldCancel}
              data-testid="auto-back"
              onClick={() => setConfirming(null)}
            >
              {t('edit.back')}
            </button>
          </p>
        </div>
      ) : null}
    </form>
  );
}
