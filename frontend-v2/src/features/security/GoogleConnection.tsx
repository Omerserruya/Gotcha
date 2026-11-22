'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import type { AccountGoogleMarker } from '@/api/contracts/google-sign-in';
import { Button } from '@/design-system/primitives/button/Button';

import { disconnectGoogle, type GoogleDisconnectResult } from './google-actions';
import type { GoogleCard } from './load-google';
import styles from './Security.module.css';

/**
 * "חשבונות מחוברים" - the person's own Google connection (Omer, 2026-11-22).
 * Per person, like "where you're signed in", not the organization's policy.
 *
 * - Connected: the address (the link is by email match, so it is theirs) and
 *   "ניתוק" - unless Backend says Google is their only way in, and then the
 *   reason instead of the control.
 * - Not connected: "חיבור", whose confirm ends in `connectGo` - the shell's
 *   button that remembers who and signs out (a feature may not sign out).
 * - Both behind an inline confirm, as the sessions card asks: two presses,
 *   never an overlay.
 * - `marker`: the callback's answer after a connect (`?google=`), one line.
 */
export function GoogleConnection({
  card,
  marker,
  connectGo,
}: {
  readonly card: Exclude<GoogleCard, { kind: 'off' }>;
  readonly marker: AccountGoogleMarker | null;
  /** The connect confirm's "המשך" (shell/account/ConnectGoogleButton). */
  readonly connectGo: ReactNode;
}) {
  const t = useTranslations('security.google');
  const [confirming, setConfirming] = useState<'connect' | 'disconnect' | null>(null);
  const [result, setResult] = useState<GoogleDisconnectResult | null>(null);
  const [isPending, startTransition] = useTransition();

  if (card.kind === 'unread') {
    return (
      <p className={styles.unavailable} data-testid="google-unread">
        {t('unread')}
      </p>
    );
  }

  const { google } = card;
  // After a disconnect the read revalidates; until it lands, say what happened.
  const connected = google.connected && result !== 'disconnected' && result !== 'gone';
  const refusedHere = connected && (!google.canDisconnect || result === 'refused');

  return (
    <div className={styles.block} data-testid="google-connection" data-connected={connected}>
      <ul className={styles.rows}>
        <li className={styles.row}>
          <div className={styles.identity}>
            <span className={styles.name}>{t('name')}</span>
            <span className={styles.detail} data-testid="google-detail">
              {connected && google.email ? (
                <bdi dir="ltr">{google.email}</bdi>
              ) : connected ? null : (
                t('notConnected')
              )}
            </span>
          </div>
          {confirming || refusedHere ? null : connected ? (
            <button
              type="button"
              className={styles.textAction}
              data-testid="google-disconnect"
              disabled={isPending}
              onClick={() => setConfirming('disconnect')}
            >
              {t('disconnect')}
            </button>
          ) : (
            <button
              type="button"
              className={styles.textAction}
              data-testid="google-connect"
              disabled={isPending}
              onClick={() => setConfirming('connect')}
            >
              {t('connect')}
            </button>
          )}
        </li>
      </ul>

      {refusedHere ? (
        <p className={styles.confirmNote} data-testid="google-refused">
          {t('refused')}
        </p>
      ) : null}

      {confirming === 'disconnect' ? (
        <div className={styles.confirmBlock}>
          <p className={styles.confirmNote} data-testid="google-disconnect-confirm">
            {t('confirmDisconnect')}
          </p>
          <div className={styles.confirmActions}>
            <Button
              size="sm"
              variant="danger"
              data-testid="google-disconnect-go"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  setResult(await disconnectGoogle());
                  setConfirming(null);
                })
              }
            >
              {t('disconnectGo')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="google-cancel"
              disabled={isPending}
              onClick={() => setConfirming(null)}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {confirming === 'connect' ? (
        <div className={styles.confirmBlock}>
          <p className={styles.confirmNote} data-testid="google-connect-confirm">
            {t('confirmConnect')}
          </p>
          <div className={styles.confirmActions}>
            {connectGo}
            <Button
              size="sm"
              variant="ghost"
              data-testid="google-cancel"
              disabled={isPending}
              onClick={() => setConfirming(null)}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {result === 'disconnected' || result === 'gone' ? (
        <p className={styles.confirmNote} role="status" data-testid="google-done">
          {t('disconnected')}
        </p>
      ) : result === 'failed' ? (
        <p className={styles.problem} role="alert" data-testid="google-failed">
          {t('failed')}
        </p>
      ) : result === null && marker === 'connected' ? (
        <p className={styles.confirmNote} role="status" data-testid="google-done">
          {t('connected')}
        </p>
      ) : result === null && marker === 'other_account' ? (
        <p className={styles.problem} role="alert" data-testid="google-other-account">
          {t('otherAccount')}
        </p>
      ) : null}
    </div>
  );
}
