import * as Sentry from '@sentry/nextjs';

import { scrubEvent, tracesSampler } from './src/observability/sentry-shared';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV,
  release: process.env.SENTRY_RELEASE,
  enabled: Boolean(process.env.SENTRY_DSN),
  sendDefaultPii: false,
  tracesSampler,
  beforeSend: scrubEvent,
});
