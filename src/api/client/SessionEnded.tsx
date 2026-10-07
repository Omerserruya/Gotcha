'use client';

import { useEffect } from 'react';

import { SESSION_EXPIRED_EVENT } from './browser-api';

/**
 * Drawn by a streamed section in place of "couldn't read" when the platform
 * refused the session during this render: it tells the one client handler,
 * which sends the browser to sign-in. Draws nothing itself.
 */
export function SessionEnded() {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }, []);
  return <span data-testid="session-ended" hidden />;
}
