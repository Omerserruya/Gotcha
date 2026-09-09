'use client';

import { logger } from '@/observability/logger';

import { HttpClient } from './http-client';

/**
 * The API client for the browser.
 *
 * It addresses this app's own BFF on a relative path. That is not a detail of
 * convenience: the platform's CORS policy admits only its own origin, and the
 * access token is deliberately unreachable from JavaScript. The browser sends
 * its session cookie; the BFF attaches the bearer token and tenant header.
 *
 * `credentials: 'same-origin'` is explicit rather than relied upon, so the
 * intent survives a future change of default.
 */
export const browserApi = new HttpClient({
  baseUrl: '/api/bff',
  defaultTimeoutMs: 20_000,
  fetchOptions: { credentials: 'same-origin', cache: 'no-store' },
  onError(error) {
    logger.warn('api.request_failed', error.toDiagnostics());
  },
  onUnauthenticated() {
    // The session is over. Broadcasting rather than redirecting here keeps the
    // transport free of routing concerns: the shell listens and decides how to
    // recover, which is the only place that knows whether a modal is open or
    // whether there is unsaved work to protect.
    window.dispatchEvent(new CustomEvent('gotcha:session-expired'));
  },
});

export const SESSION_EXPIRED_EVENT = 'gotcha:session-expired';
