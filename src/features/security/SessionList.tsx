'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { SecuritySession } from '@/api/contracts/security';
import { Button } from '@/design-system/primitives/button/Button';

import { revokeSession, revokeOtherSessions, type SecurityWriteResult } from './actions';
import styles from './Security.module.css';

/**
 * Where this account is signed in.
 *
 * *"An unfamiliar session is flagged in the list rather than in an email."*
 * So the row has to carry enough for a person to recognise their own devices —
 * browser, city and when it was last used — and revoking has to be one click
 * away from noticing.
 *
 * The details are the reader's own and are rendered for exactly that reason.
 * They never reach a log: the actions log a failure's cause, which carries a
 * status and a route and no session data at all.
 */
export function SessionList({
  sessions,
  available,
}: {
  readonly sessions: readonly SecuritySession[];
  readonly available: boolean;
}) {
  const t = useTranslations('security');
  const locale = useLocale();
  const [result, setResult] = useState<SecurityWriteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  /*
   * "We could not ask the identity provider" is not "you have no other
   * sessions", and on a security screen the difference is the whole point:
   * one means you are safe to stop looking and the other means you learned
   * nothing. The backend distinguishes them with `available`; this keeps it.
   */
  if (!available) {
    return (
      <p className={styles.unavailable} data-testid="sessions-unavailable">
        {t('sessions.unavailable')}
      </p>
    );
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className={styles.block} data-testid="session-list">
      <ul className={styles.rows}>
        {sessions.map((session) => (
          <li
            key={session.id}
            className={styles.row}
            data-testid={`session-${session.id}`}
            data-current={session.current ? 'yes' : 'no'}
          >
            <div className={styles.identity}>
              <span className={styles.name}>
                {session.userAgent?.trim() || t('sessions.unknownDevice')}
                {session.current ? (
                  <span className={styles.thisDevice}>{t('sessions.thisDevice')}</span>
                ) : null}
              </span>
              {/*
                Place and time, which is what makes a session recognisable or
                not. The city comes from the identity provider's own GeoIP and
                is simply absent when it has none — never guessed from the IP,
                and never replaced by a placeholder.
              */}
              <span className={styles.detail} data-testid={`session-detail-${session.id}`}>
                {[
                  [session.city, session.country].filter(Boolean).join(', ') || null,
                  session.ip,
                  session.lastUsed
                    ? t('sessions.lastUsed', {
                        when: when.format(new Date(session.lastUsed)),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>

            {/*
              The one destructive control on this project that is meant to be
              pressed — it is why the list is here. Absent on the current
              device: a button that signs you out of the browser you are using
              cannot report whether it worked.
            */}
            {session.current ? null : (
              <Button
                size="sm"
                data-testid={`session-revoke-${session.id}`}
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => setResult(await revokeSession(session.id)))
                }
              >
                {t('sessions.revoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {others > 0 ? (
        <div className={styles.blockActions}>
          <Button
            size="sm"
            data-testid="sessions-revoke-others"
            disabled={isPending}
            onClick={() => startTransition(async () => setResult(await revokeOtherSessions()))}
          >
            {t('sessions.revokeOthers', { count: others })}
          </Button>
        </div>
      ) : null}

      {result && !result.ok ? (
        <p className={styles.problem} data-testid="sessions-problem">
          {result.reason === 'unavailable'
            ? t('sessions.idpDown')
            : result.reason === 'forbidden'
              ? t('forbidden')
              : /*
                 ★ "WE COULDN'T CONFIRM" IS NOT "THAT DIDN'T SIGN OUT".
                 The second is a claim about a session that may well be gone.
                 The advice is identical either way because signing out twice
                 is idempotent — so saying the true one costs nothing.
                */
                result.reason === 'unconfirmed'
                ? t('sessions.revokeUnconfirmed')
                : t('sessions.revokeFailed')}
        </p>
      ) : null}
    </div>
  );
}
