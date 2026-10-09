'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { completeAuthorization, type AuthorizationOutcome } from '@/api/client/flow-executor';
import { followableCompletion } from '@/api/contracts/auth-flow';
import { logger } from '@/observability/logger';

import styles from './SignIn.module.css';
import { Loader } from '@/design-system/primitives/loader/Loader';

/**
 * The last hop of sign-in, done with two fetches instead of a rendered page.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT THIS REPLACES: THE ONE SCREEN THE PROVIDER STILL DREW
 * ════════════════════════════════════════════════════════════════════════════
 * Navigating to `authorize` makes the browser render `/if/flow/` for the final
 * hop. Fetching it instead returns the same 302 chain, the same HTML - and we
 * never render it. `completeAuthorization` then asks the executor for that
 * plan's outcome, which is `xak-flow-redirect` carrying our callback.
 *
 * ⚠ EVERY FAILURE GOES TO THE AUTHORIZE URL, NOT BACK TO `/api/auth/login`.
 *   That route is what sent us here; returning to it is an infinite redirect.
 *   Going to `authorize` is exactly what the browser would have done without
 *   this component - so the worst outcome is the provider's page, which is
 *   where we started, and never a dead screen.
 *
 * ★ The authorize URL is verified by the SERVER before it reaches this file.
 *   It arrives through a query string and anybody can retype it; a page that
 *   fetches what it is handed with credentials and navigates to the answer is
 *   a confused deputy. `isAuthorizeEndpoint` is the check, and it runs where
 *   the expected endpoint is known.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ AND IT WRITES ITS PROGRESS INTO THE DOM, BECAUSE A LOG DID NOT ARRIVE
 * ════════════════════════════════════════════════════════════════════════════
 * The first walk with this active produced **no line of ours anywhere** - not
 * in the browser console, not in either container. So "it ran and gave up" and
 * "it never ran" were indistinguishable, which is the same collapse the
 * four-reason outcome had just fixed one level down.
 *
 * ★ A log has to survive a level filter, a sink, a bundle boundary and a
 *   navigation. **An attribute on an element has to survive none of those**,
 *   and the harness that measured this page's byte count can already read it.
 *
 * ★ `data-phase` is written before the navigation, so a harness watching the
 *   DOM sees the outcome even though the page is about to leave.
 */
export function FinishSignIn({
  authorizeUrl,
  callbackUrl,
  hold = false,
}: {
  readonly authorizeUrl: string;
  readonly callbackUrl: string;
  /**
   * Stop before navigating, so the outcome can be read rather than inferred
   * from where the browser ended up.
   *
   * ⚠ Opt-in through a query parameter the person typed themselves. It cannot
   *   be reached by accident, it exposes nothing, and its only effect is that
   *   sign-in does not continue - which is recoverable by reloading without
   *   it. It exists because the alternative is guessing.
   */
  readonly hold?: boolean;
}) {
  const t = useTranslations('auth');
  const [phase, setPhase] = useState<'working' | 'done' | 'gave-up'>('working');
  const [outcome, setOutcome] = useState<AuthorizationOutcome | null>(null);
  /*
   * Separate from `outcome.reason`, because the fifth give-up is decided HERE
   * rather than inside `completeAuthorization` - it is about our callback, a
   * fact that function is deliberately not given.
   */
  const [giveUp, setGiveUp] = useState<string | undefined>(undefined);

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * ⚠⚠ THE SPENT AUTHORIZE URL MUST NOT STAY IN HISTORY
   * ═════════════════════════════════════════════════════════════════════════
   * Walked: pressing BACK onto `/en/sign-in?authorize=…` re-runs this hop
   * against a one-time URL that has already been redeemed. The executor
   * cannot complete it, we fall back to the authorize URL as designed - and
   * the provider draws a page. Sixteen documents and one Authentik render,
   * for a back button.
   *
   * ★ The fix is not in the fallback, which is correct: going to authorize is
   *   right when the URL is live. It is that a SPENT url should not be
   *   reachable. `replaceState` drops the parameter from this history entry,
   *   so back lands on a clean `/en/sign-in` that starts a fresh flow.
   *
   * ⚠ Before the fetch, not after. The navigation may happen first, and an
   *   entry rewritten after the browser has left is rewritten on the wrong
   *   page.
   */
  useEffect(() => {
    try {
      const here = new URL(window.location.href);
      if (here.searchParams.has('authorize')) {
        here.searchParams.delete('authorize');
        here.searchParams.delete('finishHold');
        window.history.replaceState(null, '', here.toString());
      }
    } catch {
      /* A history API that refuses is not a reason to fail a sign-in. */
    }
  }, []);

  useEffect(() => {
    let live = true;

    void completeAuthorization(authorizeUrl).then((answer) => {
      if (!live) return;
      setOutcome(answer);

      /*
       * ══════════════════════════════════════════════════════════════════
       * ⚠⚠ THE FIFTH GIVE-UP, WHICH THE FIRST WALK REPORTED AS `reason: ""`
       * ══════════════════════════════════════════════════════════════════
       * `completeAuthorization` SUCCEEDING and `followableCompletion` refusing
       * its answer is a fifth outcome, and it had no name: `answer.reason` is
       * undefined on the success branch, so the attribute rendered empty while
       * the phase said `gave-up`.
       *
       * ★ That is the same collapse as the four nulls, one level up, in code
       *   written to fix it. A give-up must always say which give-up.
       */
      const target = answer.to ? followableCompletion(answer.to, callbackUrl) : null;
      const gaveUp = answer.reason ?? (answer.to && !target ? 'not-our-callback' : undefined);

      setPhase(target ? 'done' : 'gave-up');
      setGiveUp(gaveUp);

      if (gaveUp) {
        logger.warn('auth.finish.gave_up', { reason: gaveUp, component: answer.component });
      }

      if (hold) return;

      /*
       * `replace`, not `assign`: this page is a hop, not a destination. Left
       * in history, the browser's back button from the inbox would land on a
       * URL carrying a one-time authorize request that no longer works.
       */
      window.location.replace(target ?? authorizeUrl);
    });

    return () => {
      live = false;
    };
  }, [authorizeUrl, callbackUrl, hold]);

  /*
   * ⚠⚠ THIS DREW NOTHING, AND IT OWNS THE SCREEN FOR ~2.6 SECONDS.
   *
   * Measured from the submit click: the panel until 2.2s, then eight elements
   * on `#121212` until 5.2s. The comment that used to sit here said a spinner
   * appearing and vanishing reads as a fault rather than as progress - true
   * of one that ANIMATES IN, and the wrong conclusion to draw from it.
   *
   * ★ So: the brand, and the same sentence the panel shows while its own
   *   first stage lands. No entrance animation, because the give-up path can
   *   navigate away in 200ms.
   *
   * ★ The diagnostic attributes stay. They are how a walk tells "ran and gave
   *   up" from "never ran", and that distinction cost a day to get.
   */
  return (
    <div
      className={styles.finishing}
      data-testid="finish-sign-in"
      data-phase={phase}
      data-reason={giveUp ?? ''}
      data-component={outcome?.component ?? ''}
    >
      <Loader size={64} label={t('signIn.starting')} />
      <p className={styles.finishingWord}>{t('signIn.starting')}</p>
    </div>
  );
}
