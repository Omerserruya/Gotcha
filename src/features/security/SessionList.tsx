'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { SecuritySession } from '@/api/contracts/security';
import { Button } from '@/design-system/primitives/button/Button';

import { revokeSession, revokeOtherSessions, type SecurityWriteResult } from './actions';
import styles from './Security.module.css';

/**
 * How many devices the list shows before it is expanded.
 *
 * Five, because the list's job is "do I recognise these?" and a person answers
 * that about a handful. It is not a page size — there is no second page and no
 * server-side paging; the whole list is already in props, and pretending
 * otherwise would put a control on screen that cannot be honoured.
 */
const VISIBLE = 5;

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
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  /*
   * ════════════════════════════════════════════════════════════════════════════
   * ★★ THE BULK CONTROL EXISTED AND WAS THIRTY-EIGHT ROWS BELOW THE FOLD
   * ════════════════════════════════════════════════════════════════════════════
   * A browser walk reported "no sign out everywhere" on this screen. The control
   * was here the whole time, mounted, wired to `DELETE /api/account/sessions`.
   * The dev tenant has 38 sessions — one per capture mint — and the button comes
   * after all of them.
   *
   * ★ So the finding was right and its cause was not the one it named. **A
   *   control nobody can reach is indistinguishable from a control that does not
   *   exist**, and that is a true report about the page whichever way the code
   *   reads. If I had taken the words literally I would have built a second one.
   *
   * The current device is always shown, first, because "is one of these me?" is
   * the question the list exists to answer.
   */
  const ordered = [...sessions].sort((a, b) => Number(b.current) - Number(a.current));
  const visible = expanded ? ordered : ordered.slice(0, VISIBLE);
  const hidden = ordered.length - visible.length;

  return (
    /*
      ════════════════════════════════════════════════════════════════════════
      ★★ THE TOTAL IS STATED, BECAUSE COUNTING THE ROWS NOW GIVES FIVE
      ════════════════════════════════════════════════════════════════════════
      Collapsing this list to five was the right fix for a buried control and it
      broke a thing that used to work: a probe counting rendered rows got the
      true number of sessions before, and gets `VISIBLE` after. Somebody checking
      that a bulk revoke did what it said would read five, then five, and
      conclude nothing happened.

      `data-total` and `data-others` are the two numbers anybody asks this list
      for, read from the props rather than from the DOM, so they are right
      whether the list is collapsed or expanded. **The reader who needs them is
      an instrument, and an instrument that has to count nodes is one that can
      count the wrong nodes** — which is exactly what happened: a probe used
      `[data-testid^="session-"]`, which also matches `session-detail-*` and,
      because the plural starts with the singular, `sessions-show-all`.

      I am not renaming the testids over that. 752 of them have 392 prefix
      relationships, because the scheme is hierarchical on purpose —
      `session-<id>` and `session-detail-<id>` describe a row and its detail. Any
      hierarchy has prefixes; a prefix selector over one is the wrong query, not
      the wrong name. Stating the numbers removes the reason to write that query.
    */
    <div
      className={styles.block}
      data-testid="session-list"
      data-total={ordered.length}
      data-others={others}
    >
      <ul className={styles.rows}>
        {visible.map((session) => (
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

      {hidden > 0 ? (
        <div className={styles.blockActions}>
          <Button
            size="sm"
            variant="ghost"
            data-testid="sessions-show-all"
            onClick={() => setExpanded(true)}
          >
            {t('sessions.showAll', { count: ordered.length })}
          </Button>
          {/*
            The count of what is hidden, next to the control that reveals it. A
            collapsed list that does not say how much it is holding back reads
            as the whole list, and on a security screen that is the difference
            between "these are my devices" and "these are five of my devices".
          */}
          <span className={styles.hiddenNote} data-testid="sessions-hidden-note">
            {t('sessions.hiddenNote', { count: hidden })}
          </span>
        </div>
      ) : expanded && ordered.length > VISIBLE ? (
        <div className={styles.blockActions}>
          <Button
            size="sm"
            variant="ghost"
            data-testid="sessions-show-fewer"
            onClick={() => setExpanded(false)}
          >
            {t('sessions.showFewer')}
          </Button>
        </div>
      ) : null}

      {others > 0 ? (
        <div className={confirming ? styles.confirmBlock : styles.blockActions}>
          {confirming ? (
            /*
              ══════════════════════════════════════════════════════════════════
              ★★ THE CONFIRM NAMES THE NUMBER *AND* SAYS THIS SESSION SURVIVES
              ══════════════════════════════════════════════════════════════════
              Naming the count is the obvious half. The second sentence is the
              one that makes the control usable: a reader who cannot tell
              whether they are about to lock themselves out will not press it,
              and **a control nobody dares press is the same as no control.**

              Two presses, not a dialog. The action is recoverable — signing in
              again is what it costs — so the guard only has to stop a stray
              click, and an inline confirm cannot be dismissed by a stray click
              elsewhere the way an overlay can.
            */
            <>
              <p className={styles.confirmNote} data-testid="sessions-revoke-others-confirm">
                {t('sessions.revokeOthersConfirm', { count: others })}
              </p>
              <div className={styles.confirmActions}>
                <Button
                  size="sm"
                  variant="danger"
                  data-testid="sessions-revoke-others-go"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      setResult(await revokeOtherSessions());
                      setConfirming(false);
                    })
                  }
                >
                  {t('sessions.revokeOthersGo', { count: others })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="sessions-revoke-others-cancel"
                  disabled={isPending}
                  onClick={() => setConfirming(false)}
                >
                  {t('sessions.cancel')}
                </Button>
              </div>
            </>
          ) : (
            <Button
              size="sm"
              data-testid="sessions-revoke-others"
              disabled={isPending}
              onClick={() => setConfirming(true)}
            >
              {t('sessions.revokeOthers', { count: others })}
            </Button>
          )}
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
