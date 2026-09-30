'use client';

import { useEffect } from 'react';

import { completeAuthorization } from '@/api/client/flow-executor';
import { followableCompletion } from '@/api/contracts/auth-flow';
import { logger } from '@/observability/logger';

/**
 * The last hop of sign-in, done with two fetches instead of a rendered page.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT THIS REPLACES: THE ONE SCREEN THE PROVIDER STILL DREW
 * ════════════════════════════════════════════════════════════════════════════
 * Navigating to `authorize` makes the browser render `/if/flow/` for the final
 * hop. Fetching it instead returns the same 302 chain, the same HTML — and we
 * never render it. `completeAuthorization` then asks the executor for that
 * plan's outcome, which is `xak-flow-redirect` carrying our callback.
 *
 * ⚠ EVERY FAILURE GOES TO THE AUTHORIZE URL, NOT BACK TO `/api/auth/login`.
 *   That route is what sent us here; returning to it is an infinite redirect.
 *   Going to `authorize` is exactly what the browser would have done without
 *   this component — so the worst outcome is the provider's page, which is
 *   where we started, and never a dead screen.
 *
 * ★ The authorize URL is verified by the SERVER before it reaches this file.
 *   It arrives through a query string and anybody can retype it; a page that
 *   fetches what it is handed with credentials and navigates to the answer is
 *   a confused deputy. `isAuthorizeEndpoint` is the check, and it runs where
 *   the expected endpoint is known.
 */
export function FinishSignIn({
  authorizeUrl,
  callbackUrl,
}: {
  readonly authorizeUrl: string;
  readonly callbackUrl: string;
}) {
  useEffect(() => {
    let live = true;

    void completeAuthorization(authorizeUrl).then((outcome) => {
      if (!live) return;

      /*
       * ⚠⚠ SAY WHY, BECAUSE THE FALLBACK IS INVISIBLE BY DESIGN.
       *   Landing on the provider's page is what happens when this works and
       *   when it gives up — the first live walk fell back correctly and
       *   nothing distinguished "the executor answered a consent stage" from
       *   "the fetch never found a flow". One line makes the four outcomes
       *   tellable apart in a walk, and it names no URL or token.
       */
      if (outcome.reason) {
        logger.warn('auth.finish.gave_up', {
          reason: outcome.reason,
          component: outcome.component,
        });
      }

      const target = outcome.to ? followableCompletion(outcome.to, callbackUrl) : null;
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
  }, [authorizeUrl, callbackUrl]);

  /*
   * Deliberately nothing. This renders for the length of two fetches on a
   * screen the person is already looking at — the sign-in panel's own frame
   * is still around it — and a spinner that appears and vanishes reads as a
   * fault rather than as progress.
   */
  return null;
}
