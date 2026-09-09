'use client';

import { useEffect } from 'react';

import { SESSION_EXPIRED_EVENT } from '@/api/client/browser-api';
import { startSignIn } from '@/auth/sign-out';
import { logger } from '@/observability/logger';

/**
 * Reacts to the session ending mid-use.
 *
 * The transport layer only announces the fact; the decision of what to do
 * about it belongs here, where routing exists. Sending the user to sign-in
 * with `returnTo` set means they land back on the page they were on rather
 * than at Home, which matters when the thing they lost was half-written.
 *
 * A single listener at the shell level, so ten concurrent 401s produce one
 * redirect rather than ten.
 */
export function SessionExpiryWatcher() {
  useEffect(() => {
    let handled = false;

    function onSessionExpired() {
      if (handled) return;
      handled = true;
      logger.info('auth.session_expired');
      startSignIn(`${window.location.pathname}${window.location.search}`);
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, []);

  return null;
}
