import * as Sentry from '@sentry/nextjs';

import { scrubEvent, tracesSampler } from './src/observability/sentry-shared';

/**
 * Server-side Sentry.
 *
 * `sendDefaultPii` is off and every event passes through `scrubEvent`. GOTCHA
 * carries customer conversations; an unscrubbed breadcrumb or request body is
 * a data-protection incident rather than a debugging convenience.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV,
  release: process.env.SENTRY_RELEASE,
  enabled: Boolean(process.env.SENTRY_DSN),
  sendDefaultPii: false,
  tracesSampler,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});
