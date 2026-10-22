import * as Sentry from '@sentry/nextjs';

/**
 * Next.js instrumentation hook. Runs once per runtime, before anything else.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

/**
 * Captures errors thrown while rendering a route on the server, which would
 * otherwise only reach the terminal.
 */
export const onRequestError = Sentry.captureRequestError;
