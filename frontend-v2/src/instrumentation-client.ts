import * as Sentry from '@sentry/nextjs';

import { clientEnv } from '@/config/env.client';
import { registerErrorSink, registerLogSink } from '@/observability/logger';
import { scrubEvent } from '@/observability/sentry-shared';

Sentry.init({
  dsn: clientEnv.SENTRY_DSN,
  environment: clientEnv.APP_ENV,
  release: clientEnv.RELEASE,
  enabled: Boolean(clientEnv.SENTRY_DSN),
  sendDefaultPii: false,
  tracesSampleRate: clientEnv.SENTRY_TRACES_SAMPLE_RATE,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  integrations: [
    // Replay is deliberately not enabled. Recording a session in a product
    // that displays customer conversations would capture their contents.
  ],
});

/**
 * Application log lines become Sentry breadcrumbs.
 *
 * This is what makes an error report useful: by the time something throws, the
 * breadcrumb trail already shows which API call failed first and with which
 * correlation id. The logger has already redacted the context.
 */
registerLogSink((level, event, context) => {
  Sentry.addBreadcrumb({
    category: 'app',
    level: level === 'warn' ? 'warning' : level,
    message: event,
    data: context,
  });
});

/**
 * Exceptions reported through the observability layer reach Sentry here.
 *
 * Registering rather than importing Sentry at each call site is what keeps the
 * design system and feature code free of the SDK - and what lets their tests
 * run without loading it.
 */
registerErrorSink((error, context) => {
  Sentry.captureException(error, {
    tags: { region: String(context.region ?? 'unknown') },
    extra: context,
  });
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
