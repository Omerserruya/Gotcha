'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/design-system/primitives/button/Button';
import { Loader } from '@/design-system/primitives/loader/Loader';
import { Text } from '@/design-system/primitives/text/Text';
import { Link } from '@/i18n/navigation';

import styles from './VerifyEmail.module.css';
import { verifyEmailChange, type VerifyEmailResult } from './verify-email-action';

type Shown =
  | { readonly kind: 'working' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'done'; readonly result: VerifyEmailResult };

/** The refusals worth another press: nothing changed, and nothing is wrong with the link. */
const RETRYABLE = new Set(['unfinished', 'failed']);

/**
 * `/account/verify-email?token=` - the link mailed to a NEW sign-in address.
 *
 * Legacy confirmed on load, and so does this: opening the link IS the
 * confirmation. The proxy has already sent a signed-out visitor to sign in
 * with this link as `returnTo`, because the route needs the session.
 *
 * ⚠ Once per mount, by a ref: a development double-effect, or a re-render,
 *   must not send it twice. A second send would be harmless (see the
 *   contract), but "harmless" is the backend's promise, not this screen's.
 */
export function VerifyEmail({ token }: { readonly token: string | null }) {
  const t = useTranslations('security.verifyEmail');
  const [shown, setShown] = useState<Shown>(token ? { kind: 'working' } : { kind: 'missing' });
  const sent = useRef(false);

  const confirm = useCallback(async () => {
    if (!token) return;
    setShown({ kind: 'working' });
    setShown({ kind: 'done', result: await verifyEmailChange(token) });
  }, [token]);

  useEffect(() => {
    if (sent.current || !token) return;
    sent.current = true;
    void confirm();
  }, [confirm, token]);

  if (shown.kind === 'working') {
    return (
      <div className={styles.panel} data-testid="verify-email-working" aria-busy="true">
        <Loader size={32} label={t('working')} />
        <Text role="body" tone="muted" as="p">
          {t('working')}
        </Text>
      </div>
    );
  }

  if (shown.kind === 'done' && shown.result.ok) {
    return (
      <div className={styles.panel} data-testid="verify-email-done">
        <Text role="title" as="h1">
          {t('doneTitle')}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t.rich('doneBody', {
            email: () => <bdi dir="ltr">{shown.result.ok ? shown.result.email : ''}</bdi>,
          })}
        </Text>
        <Link className={styles.onward} href="/home">
          {t('continue')}
        </Link>
      </div>
    );
  }

  const reason =
    shown.kind === 'missing' ? 'missing' : shown.result.ok ? 'failed' : shown.result.reason;
  return (
    <div className={styles.panel} data-testid="verify-email-refused" data-reason={reason}>
      <Text role="title" as="h1">
        {t('refusedTitle')}
      </Text>
      <Text role="body" tone="muted" as="p">
        {t(`reason.${reason}`)}
      </Text>
      {RETRYABLE.has(reason) ? (
        <Button variant="primary" onClick={() => void confirm()} data-testid="verify-email-retry">
          {t('retry')}
        </Button>
      ) : null}
      <Link className={styles.onward} href="/home">
        {t('continue')}
      </Link>
    </div>
  );
}
