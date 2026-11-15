'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';

import { LINK_HOURS, MAX_WORKSPACE } from '@/api/contracts/account-deletion';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';
import { requestAccountDeletion, type DeletionRequest } from '@/features/account-deletion/actions';

import styles from '../recover/Recover.module.css';

/**
 * Ask for an account's deletion, signed out (Google Play's Data safety
 * link). The recovery screen's field markup and card, not a new look.
 *
 * ★★ Sent says the same thing whether or not an account uses the address,
 *   because the route does too: this page must not tell a stranger who is
 *   a customer.
 */
export function DeletionRequestPanel({
  locale,
  signInHref,
}: {
  readonly locale: string;
  readonly signInHref: string;
}) {
  const t = useTranslations('auth.accountDeletion');
  const [email, setEmail] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [result, setResult] = useState<DeletionRequest | null>(null);
  const [pending, startTransition] = useTransition();

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    startTransition(async () => {
      setResult(await requestAccountDeletion({ email, workspace, locale }));
    });
  };

  if (result?.ok) {
    return (
      <div className={styles.done} data-testid="deletion-sent">
        <Text role="title" as="h1">
          {t('sent.title')}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t('sent.body', { hours: LINK_HOURS })}
        </Text>
        <a className={styles.back} href={signInHref}>
          {t('back')}
        </a>
      </div>
    );
  }

  return (
    // `method="post"`: a press before the scripts run never puts the address in the URL.
    <form
      className={styles.form}
      method="post"
      onSubmit={send}
      data-testid="deletion-form"
      noValidate
    >
      <Text role="title" as="h1">
        {t('title')}
      </Text>
      <Text role="body" tone="muted" as="p" className={styles.lede}>
        {t('lede')}
      </Text>
      {/* What is deleted, what is kept and when: Play requires the page to say it. */}
      <ul className={styles.ruleList} data-testid="deletion-policy">
        <li className={styles.rule}>{t('policy.deleted')}</li>
        <li className={styles.rule}>{t('policy.kept')}</li>
        <li className={styles.rule}>{t('policy.timing')}</li>
      </ul>

      {result && !result.ok ? (
        <p className={styles.notice} role="alert" data-testid="deletion-refused">
          {t(`refusal.${result.reason}`)}
        </p>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>{t('email')}</span>
        <span className={styles.fieldControl}>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            dir="ltr"
            className={styles.input}
            data-testid="deletion-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </span>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t('workspace')}</span>
        <span className={styles.fieldControl}>
          <input
            type="text"
            name="workspace"
            autoComplete="organization"
            maxLength={MAX_WORKSPACE}
            className={styles.input}
            data-testid="deletion-workspace"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
          />
        </span>
      </label>

      <Button type="submit" disabled={pending || !email.trim()} data-testid="deletion-submit">
        {pending ? t('sending') : t('submit')}
      </Button>

      <a className={styles.back} href={signInHref} data-testid="deletion-back">
        {t('back')}
      </a>
    </form>
  );
}
