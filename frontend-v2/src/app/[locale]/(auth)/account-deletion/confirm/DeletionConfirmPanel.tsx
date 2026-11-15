'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { LINK_HOURS } from '@/api/contracts/account-deletion';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';
import { confirmAccountDeletion, type DeletionConfirm } from '@/features/account-deletion/actions';

import styles from '../../recover/Recover.module.css';

/**
 * The email link's landing. ★★ NOTHING HAPPENS ON LOAD: mail scanners open
 * links and run their scripts, and a link spent on load would confirm a
 * deletion nobody asked for (a one-time link is spent by a click). The
 * person's press on "Confirm deletion" is the only thing that sends it.
 */
export function DeletionConfirmPanel({
  token,
  requestHref,
  signInHref,
}: {
  readonly token: string | null;
  readonly requestHref: string;
  readonly signInHref: string;
}) {
  const t = useTranslations('auth.accountDeletion.confirm');
  const format = useFormatter();
  const [result, setResult] = useState<DeletionConfirm | null>(null);
  const [pending, startTransition] = useTransition();

  if (!token)
    return <Outcome state="BAD_TOKEN" requestHref={requestHref} signInHref={signInHref} />;

  if (result?.ok) {
    const by = result.confirmed.deleteBy;
    return (
      <div className={styles.done} data-testid="deletion-confirmed">
        <Text role="title" as="h1">
          {t('done.title')}
        </Text>
        <Text role="body" tone="muted" as="p">
          <span data-testid="deletion-confirmed-by">
            {by
              ? t('done.by', { date: format.dateTime(new Date(by), { dateStyle: 'long' }) })
              : t('done.soon')}
          </span>
        </Text>
        {result.confirmed.email ? (
          <Text role="body" tone="muted" as="p">
            <bdi dir="ltr">{result.confirmed.email}</bdi>
          </Text>
        ) : null}
        <Text role="body" tone="muted" as="p">
          {t('done.cancel')}
        </Text>
      </div>
    );
  }

  if (result && !result.ok && result.reason !== 'failed') {
    return <Outcome state={result.reason} requestHref={requestHref} signInHref={signInHref} />;
  }

  return (
    <div className={styles.form} data-testid="deletion-confirm">
      <Text role="title" as="h1">
        {t('title')}
      </Text>
      <Text role="body" tone="muted" as="p" className={styles.lede}>
        {t('lede')}
      </Text>
      {result && !result.ok ? (
        <p className={styles.notice} role="alert" data-testid="deletion-confirm-failed">
          {t('failed')}
        </p>
      ) : null}
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          if (pending) return;
          startTransition(async () => {
            setResult(await confirmAccountDeletion(token));
          });
        }}
        data-testid="deletion-confirm-press"
      >
        {pending ? t('confirming') : t('press')}
      </Button>
      <a className={styles.back} href={signInHref} data-testid="deletion-keep">
        {t('keep')}
      </a>
    </div>
  );
}

function Outcome({
  state,
  requestHref,
  signInHref,
}: {
  readonly state: 'BAD_TOKEN' | 'TOKEN_EXPIRED' | 'ALREADY_CONFIRMED';
  readonly requestHref: string;
  readonly signInHref: string;
}) {
  const t = useTranslations('auth.accountDeletion.confirm');
  return (
    <div className={styles.done} data-testid={`deletion-${state}`}>
      <Text role="title" as="h1">
        {t(`outcome.${state}.title`)}
      </Text>
      <Text role="body" tone="muted" as="p">
        {t(`outcome.${state}.body`, { hours: LINK_HOURS })}
      </Text>
      {state === 'ALREADY_CONFIRMED' ? null : (
        <a className={styles.back} href={requestHref} data-testid="deletion-ask-again">
          {t('askAgain')}
        </a>
      )}
      <a className={styles.back} href={signInHref}>
        {t('signIn')}
      </a>
    </div>
  );
}
