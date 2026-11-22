'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  SIGN_UP_NUMBERS,
  type SignUpNumber,
  type SignUpSettings as Settings,
} from '@/api/contracts/self-signup';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import styles from './Console.module.css';
import { saveSignUpSettings, type SignUpSettingsResult } from './signup-settings-actions';

/**
 * "הרשמה עצמית" - the platform's self sign-up switch, its trial, the day a
 * self-signed-up organization must set up payment, and the trial's credits
 * (Omer and the Supervisor, 2026-11-22).
 *
 * ★ Every number's limits are the server's (`bounds`), named from there and
 *   never from a constant of ours; a number with none is only marked.
 * ★ Unread is said, never drawn as "off": an unchecked switch over an unread
 *   setting would claim sign-up is closed.
 * ★ `envEnabled: false` is said on the card: the env switch is off, and what
 *   is saved here does nothing until it is on.
 */
export function SignUpSettings({ settings }: { readonly settings: Settings | null }) {
  const t = useTranslations('console.signup');
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [values, setValues] = useState<Record<SignUpNumber, string>>({
    trialDays: String(settings?.trialDays ?? ''),
    cardRequiredAfterDays: String(settings?.cardRequiredAfterDays ?? ''),
    trialCredits: String(settings?.trialCredits ?? ''),
  });
  const [result, setResult] = useState<SignUpSettingsResult | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!settings) {
    return (
      <p className={styles.notice} data-testid="signup-settings-unread">
        {t('unread')}
      </p>
    );
  }

  const read = (key: SignUpNumber): number | null => {
    const raw = values[key].trim();
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    const limits = settings.bounds[key];
    if (!limits) return value >= 1 ? value : null;
    return value >= limits.min && value <= limits.max ? value : null;
  };
  const rangeOf = (key: SignUpNumber): string | undefined => {
    const limits = settings.bounds[key];
    return limits ? t('range', { min: limits.min, max: limits.max }) : undefined;
  };
  const parsed = {
    trialDays: read('trialDays'),
    cardRequiredAfterDays: read('cardRequiredAfterDays'),
    trialCredits: read('trialCredits'),
  };
  const complete =
    parsed.trialDays !== null &&
    parsed.cardRequiredAfterDays !== null &&
    parsed.trialCredits !== null;

  return (
    <section className={styles.card} data-testid="signup-settings">
      <h2 className={styles.cardTitle}>{t('title')}</h2>
      {settings.envEnabled ? null : (
        <p className={styles.notice} data-testid="signup-env-off">
          {t('envOff')}
        </p>
      )}
      <label className={styles.controlRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          data-testid="signup-enabled"
        />
        {t('enabled')}
      </label>
      <div className={styles.controlRow}>
        {SIGN_UP_NUMBERS.map((key) => (
          <Input
            key={key}
            label={t(`number.${key}`)}
            inputMode="numeric"
            value={values[key]}
            hint={key === 'cardRequiredAfterDays' ? t('cardHint') : undefined}
            onChange={(event) => setValues((now) => ({ ...now, [key]: event.target.value }))}
            error={parsed[key] === null ? rangeOf(key) : undefined}
            data-testid={`signup-${key}`}
          />
        ))}
      </div>
      <div className={styles.controlRow}>
        <Button
          variant="primary"
          size="sm"
          disabled={isPending || !complete}
          data-testid="signup-save"
          onClick={() =>
            startTransition(async () => {
              if (
                parsed.trialDays === null ||
                parsed.cardRequiredAfterDays === null ||
                parsed.trialCredits === null
              )
                return;
              setResult(
                await saveSignUpSettings({
                  enabled,
                  trialDays: parsed.trialDays,
                  cardRequiredAfterDays: parsed.cardRequiredAfterDays,
                  trialCredits: parsed.trialCredits,
                }),
              );
            })
          }
        >
          {t('save')}
        </Button>
        {result === 'saved' ? (
          <p className={styles.done} role="status" data-testid="signup-saved">
            {t('saved')}
          </p>
        ) : result ? (
          <p className={styles.refused} role="alert" data-testid="signup-failed">
            {t('failed')}
          </p>
        ) : null}
      </div>
    </section>
  );
}
