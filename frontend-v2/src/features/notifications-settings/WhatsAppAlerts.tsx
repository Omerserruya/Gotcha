'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import styles from './Notifications.module.css';
import {
  confirmWhatsAppCode,
  removeWhatsAppNumber,
  sendWhatsAppCode,
  type WhatsAppRefusal,
} from './preference-actions';

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'number' }
  | { readonly kind: 'code'; readonly phone: string; readonly minutes: number }
  | { readonly kind: 'removing' };

/**
 * Where WhatsApp alerts go - the person's own number, kept only once a code
 * sent to it comes back (Backend 73f76d2c; an unverified number would be our
 * number writing to a stranger). Confirming turns WhatsApp alerts on;
 * removing the number turns them off, asked first.
 *
 * Drawn in the quiet hours' own pattern: the value, then a form in place.
 */
export function WhatsAppAlerts({ phone }: { readonly phone: string | null }) {
  const t = useTranslations('notifications-settings.matrix.whatsapp');
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<WhatsAppRefusal | null>(null);
  const [isPending, startTransition] = useTransition();

  const send = (to: string) =>
    startTransition(async () => {
      setProblem(null);
      const done = await sendWhatsAppCode(to);
      if (!done.ok) {
        setProblem(done.reason);
        return;
      }
      setCode('');
      setStep({ kind: 'code', phone: to, minutes: Math.round(done.expiresInSeconds / 60) });
    });

  const said = problem ? (
    <span className={styles.switchProblem} role="alert" data-testid="pref-whatsapp-problem">
      {t(`problem.${problem}`)}
    </span>
  ) : null;

  if (step.kind === 'number') {
    return (
      <form
        className={styles.quietForm}
        data-testid="pref-whatsapp-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (number.trim()) send(number.trim());
        }}
      >
        <label className={styles.quietField}>
          <span>{t('numberLabel')}</span>
          <input
            value={number}
            inputMode="tel"
            dir="ltr"
            placeholder="054-123 4567"
            onChange={(e) => setNumber(e.target.value)}
            data-testid="pref-whatsapp-number"
          />
        </label>
        {said}
        <span className={styles.quietActions}>
          <button
            type="submit"
            className={styles.quietPrimary}
            disabled={isPending || !number.trim()}
            data-testid="pref-whatsapp-send"
          >
            {isPending ? t('sending') : t('send')}
          </button>
          <button
            type="button"
            className={styles.quietSecondary}
            onClick={() => {
              setProblem(null);
              setStep({ kind: 'idle' });
            }}
          >
            {t('cancel')}
          </button>
        </span>
      </form>
    );
  }

  if (step.kind === 'code') {
    return (
      <form
        className={styles.quietForm}
        data-testid="pref-whatsapp-code-form"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            setProblem(null);
            const done = await confirmWhatsAppCode(step.phone, code);
            if (!done.ok) {
              setProblem(done.reason);
              return;
            }
            setStep({ kind: 'idle' });
            router.refresh();
          });
        }}
      >
        <p className={styles.prefNote} data-testid="pref-whatsapp-sent">
          {t('sent', { minutes: step.minutes })} <span dir="ltr">{step.phone}</span>
        </p>
        <label className={styles.quietField}>
          <span>{t('codeLabel')}</span>
          <input
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            onChange={(e) => setCode(e.target.value)}
            data-testid="pref-whatsapp-code"
          />
        </label>
        {said}
        <span className={styles.quietActions}>
          <button
            type="submit"
            className={styles.quietPrimary}
            disabled={isPending || !code.trim()}
            data-testid="pref-whatsapp-confirm"
          >
            {isPending ? t('confirming') : t('confirm')}
          </button>
          <button
            type="button"
            className={styles.quietSecondary}
            disabled={isPending}
            onClick={() => send(step.phone)}
            data-testid="pref-whatsapp-resend"
          >
            {t('resend')}
          </button>
          <button
            type="button"
            className={styles.quietSecondary}
            onClick={() => {
              setProblem(null);
              setStep({ kind: 'idle' });
            }}
          >
            {t('cancel')}
          </button>
        </span>
      </form>
    );
  }

  return (
    <>
      <p className={styles.prefValue} data-testid="pref-whatsapp-value">
        {phone ? <span dir="ltr">{phone}</span> : t('none')}
      </p>
      {step.kind === 'removing' ? (
        <p className={styles.prefNote} role="alertdialog" data-testid="pref-whatsapp-remove-ask">
          {t('removeAsk')}
        </p>
      ) : null}
      {said}
      <span className={styles.quietActions}>
        {step.kind === 'removing' ? (
          <>
            <button
              type="button"
              className={styles.quietPrimary}
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  setProblem(null);
                  const done = await removeWhatsAppNumber();
                  if (!done.ok) {
                    setProblem(done.reason === 'forbidden' ? 'forbidden' : 'failed');
                    return;
                  }
                  setStep({ kind: 'idle' });
                  router.refresh();
                })
              }
              data-testid="pref-whatsapp-remove-yes"
            >
              {t('removeYes')}
            </button>
            <button
              type="button"
              className={styles.quietSecondary}
              onClick={() => setStep({ kind: 'idle' })}
            >
              {t('cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.quietSecondary}
              onClick={() => {
                setProblem(null);
                setNumber('');
                setStep({ kind: 'number' });
              }}
              data-testid="pref-whatsapp-edit"
            >
              {phone ? t('change') : t('add')}
            </button>
            {phone ? (
              <button
                type="button"
                className={styles.quietSecondary}
                onClick={() => {
                  setProblem(null);
                  setStep({ kind: 'removing' });
                }}
                data-testid="pref-whatsapp-remove"
              >
                {t('remove')}
              </button>
            ) : null}
          </>
        )}
      </span>
    </>
  );
}
