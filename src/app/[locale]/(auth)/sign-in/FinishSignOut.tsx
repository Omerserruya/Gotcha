'use client';

import { useEffect } from 'react';

import { runInvalidationFlow } from '@/api/client/flow-executor';
import { logger } from '@/observability/logger';

/**
 * Signing out without the provider drawing its completion page.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE SESSION DIES EITHER WAY. THIS IS ABOUT WHERE THE PERSON LANDS.
 * ════════════════════════════════════════════════════════════════════════════
 * `end-session` runs the invalidation flow and then renders
 * `ak-stage-session-end` — *"You've logged out of GOTCHA"*, with Go back to
 * overview · Log out of GOTCHA · Log back into GOTCHA. A completion page, not
 * a confirmation: the sign-out has already happened and we are simply never
 * handed back.
 *
 * ★ One of those buttons says "Log out of GOTCHA" on a screen reached BY
 *   logging out. Somebody who does not press it may reasonably believe they
 *   are still signed in. That ambiguity is the defect, more than the theme is.
 *
 * ⚠ AND IT IS NOT A SPINNER'S JOB TO HIDE THAT. If the fetch does not show
 *   the flow ran, this navigates to `end-session` itself — the provider's
 *   page, which is exactly today's behaviour and genuinely ends the session.
 *   **A clean-looking sign-out that does not sign out is the one outcome
 *   worse than the page**, and this app shipped one of those today.
 */
export function FinishSignOut({
  endSessionUrl,
  signedOutUrl,
}: {
  readonly endSessionUrl: string;
  readonly signedOutUrl: string;
}) {
  useEffect(() => {
    let live = true;

    void runInvalidationFlow(endSessionUrl).then((ran) => {
      if (!live) return;

      if (!ran) {
        logger.warn('auth.signout.flow_unconfirmed', {});
        window.location.replace(endSessionUrl);
        return;
      }

      window.location.replace(signedOutUrl);
    });

    return () => {
      live = false;
    };
  }, [endSessionUrl, signedOutUrl]);

  return <div hidden data-testid="finish-sign-out" />;
}
