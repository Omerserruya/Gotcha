'use client';

import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';

import { resendSetupLink, type ResendSetupLinkResult } from '@/features/setup-link/actions';
import type { SetupLinkReason } from '@/features/setup-link/reasons';

import styles from '../../recover/Recover.module.css';

/**
 * Where a setup link that cannot be redeemed lands - legacy
 * `frontend/src/app/setup-link/expired/page.tsx`.
 *
 * Say what happened in one sentence, and put the repair on the same screen.
 * The dead token rides in the URL (`?t=`), which is what lets "Email me a new
 * link" work without asking an anonymous visitor for an address - and so
 * without becoming a way to test which addresses have accounts.
 */
export function SetupLinkPanel({
  reason,
  token,
  signInHref,
}: {
  readonly reason: SetupLinkReason;
  readonly token: string | null;
  readonly signInHref: string;
}) {
  const t = useTranslations('auth.setupLink');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Extract<ResendSetupLinkResult, { ok: false }> | null>(
    null,
  );
  const [sent, setSent] = useState(false);
  // Two presses in one tick both read `busy` as false; each send revokes the last link.
  const inFlight = useRef(false);

  const canResend = token !== null && RESENDABLE.has(reason);

  async function resend() {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const result = await resendSetupLink(token);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) setSent(true);
    else setProblem(result);
  }

  if (sent) {
    return (
      <div className={styles.done} data-testid="setup-link-sent">
        <Text role="title" as="h1">
          {t('sent.title')}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t('sent.body')}
        </Text>
        <Text role="meta" tone="muted" as="p">
          {t('sent.nothing')}
        </Text>
      </div>
    );
  }

  return (
    <div className={styles.done} data-testid="setup-link-expired" data-reason={reason}>
      <Text role="title" as="h1">
        {t(`reason.${reason}.title`)}
      </Text>
      <Text role="body" tone="muted" as="p">
        {t(`reason.${reason}.body`)}
      </Text>

      {problem ? (
        <p className={styles.notice} role="alert" data-testid="setup-link-problem">
          {t(`problem.${problem.reason}`)}
        </p>
      ) : null}

      {canResend ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void resend()}
          data-testid="setup-link-resend"
        >
          {busy ? t('sending') : t('resend')}
        </Button>
      ) : null}

      <a className={styles.back} href={signInHref} data-testid="setup-link-sign-in">
        {t('signIn')}
      </a>
    </div>
  );
}

/**
 * The reasons a new link would repair. `invalid` (a mangled URL) carries no
 * token to send, and `identity_missing` needs the inviter, not a new link.
 */
const RESENDABLE = new Set<SetupLinkReason>(['expired', 'revoked', 'idp_unavailable']);
