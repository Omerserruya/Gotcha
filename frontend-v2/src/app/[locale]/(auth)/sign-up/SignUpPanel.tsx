'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';

import type { SignUpConfig, SignUpField, SignUpOutcome } from '@/api/contracts/self-signup';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';
import { submitSignUp } from '@/features/signup/actions';
import { TermsBox } from '@/shell/terms/TermsBox';

import styles from '../recover/Recover.module.css';

/**
 * Self sign-up (Omer, 2026-11-22): full name, work email, business name, the
 * shared Terms box, one submit - then the same "check your email" whatever
 * the address. The recover screen's own field markup and styles; there is no
 * `Field` primitive in this design system, and none is invented here.
 *
 * ★ The answer never says whether the address already has an account: the
 *   server answers every accepted request alike, and so does this screen.
 * ★ The Terms box is the setup screen's, sending the words as shown - the
 *   same consent, recorded the same way.
 */
export function SignUpPanel({
  config,
  signInHref,
}: {
  readonly config: SignUpConfig;
  readonly signInHref: string;
}) {
  const t = useTranslations('auth.signUp');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [accepted, setAccepted] = useState(false);
  /* The honeypot (Backend): hidden from people, so only a bot fills it. */
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SignUpOutcome | null>(null);
  const termsLabel = useRef<HTMLSpanElement>(null);

  const ready = accepted && name.trim() !== '' && email.trim() !== '' && businessName.trim() !== '';

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready) return;
    // The browser's own rules (required, type=email) first: never a second opinion of ours.
    if (!event.currentTarget.reportValidity()) return;
    setBusy(true);
    setOutcome(
      await submitSignUp(
        { name, email, businessName },
        termsLabel.current?.textContent?.trim() ?? '',
        website,
      ),
    );
    setBusy(false);
  }

  if (outcome?.kind === 'sent') {
    return (
      <div className={styles.done} data-testid="signup-sent">
        <Text role="title" as="h1">
          {t('sentTitle')}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t.rich('sentBody', { email: () => <bdi dir="ltr">{email.trim()}</bdi> })}
        </Text>
        <a className={styles.back} href={signInHref}>
          {t('signIn')}
        </a>
      </div>
    );
  }

  const invalidField: SignUpField | null = outcome?.kind === 'invalid' ? outcome.field : null;
  const problem =
    outcome?.kind === 'rateLimited'
      ? t('rateLimited')
      : outcome?.kind === 'invalid'
        ? invalidField
          ? t('checkField')
          : t('failed')
        : outcome
          ? t('failed')
          : null;

  const field = (
    id: SignUpField,
    value: string,
    set: (value: string) => void,
    input: { type: 'text' | 'email'; autoComplete: string; autoFocus?: boolean; dir?: 'ltr' },
  ) => (
    <label className={styles.field}>
      <span className={styles.label}>{t(id)}</span>
      <span className={styles.fieldControl}>
        <input
          {...input}
          name={id}
          required
          className={styles.input}
          aria-invalid={invalidField === id ? true : undefined}
          data-testid={`signup-${id}`}
          value={value}
          onChange={(event) => set(event.target.value)}
        />
      </span>
    </label>
  );

  return (
    <form className={styles.form} onSubmit={(event) => void send(event)} data-testid="signup-form">
      <Text role="title" as="h1">
        {t('title')}
      </Text>
      <Text role="body" tone="muted" as="p" className={styles.lede}>
        {t('lede')}
      </Text>
      {config.trialDays !== null && config.cardRequiredAfterDays !== null ? (
        <Text role="body" tone="muted" as="p" className={styles.lede}>
          {t('trial', { trialDays: config.trialDays, cardDays: config.cardRequiredAfterDays })}
        </Text>
      ) : null}

      {problem ? (
        <p className={styles.notice} role="alert" data-testid="signup-problem">
          {problem}
        </p>
      ) : null}

      {field('name', name, setName, { type: 'text', autoComplete: 'name', autoFocus: true })}
      {field('email', email, setEmail, { type: 'email', autoComplete: 'email', dir: 'ltr' })}
      {field('businessName', businessName, setBusinessName, {
        type: 'text',
        autoComplete: 'organization',
      })}

      {/*
        The honeypot: off-screen and out of the tab order, never announced, so
        a person leaves it empty and the server ignores a filled one (202).
      */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className={styles.honeypot}
        value={website}
        onChange={(event) => setWebsite(event.target.value)}
        data-testid="signup-website"
      />

      <TermsBox
        checked={accepted}
        onChange={setAccepted}
        disabled={busy}
        labelRef={termsLabel}
        testIdPrefix="signup"
      />

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        disabled={busy || !ready}
        data-testid="signup-submit"
      >
        {busy ? t('working') : t('submit')}
      </Button>

      <p className={styles.lede}>
        {t('haveAccount')}{' '}
        <a className={styles.back} href={signInHref} data-testid="signup-sign-in">
          {t('signIn')}
        </a>
      </p>
    </form>
  );
}
