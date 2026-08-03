/**
 * Sentry browser init for gotcha-frontend.
 *
 * `sentry.client.config.ts` (not `instrumentation-client.ts`) is the correct
 * file for Next.js 14 - the newer name is only picked up from Next 15.3.
 *
 * This covers everything the frontend project is meant to cover: React render
 * errors, unhandled promise rejections, client-side API failures, and the
 * integration-setup / AI Assistant / HITL / billing / guided-tour surfaces,
 * because all of them are this one bundle.
 *
 * There is no matching server config: production is a static export with no
 * Next.js server, so a `sentry.server.config.ts` would never execute.
 */
import * as Sentry from "@sentry/nextjs";
import {
  isProductionSentryClient,
  sentryClientOptions,
  scrubClientEvent,
  type ClientEvent,
} from "@/lib/sentry-client";

const { beforeSend: _drop, ...options } = sentryClientOptions();

// Two independent conditions, then a DSN. Anything less than all three sends
// nothing - a developer running `next build` locally with a populated .env
// still cannot page the on-call rotation.
if (isProductionSentryClient() && options.dsn) {
  Sentry.init({
    ...options,
    // The scrubber is kept structurally typed and SDK-free so it can be unit
    // tested without a client; the cast is the one place the two meet.
    beforeSend: (event) =>
      scrubClientEvent(event as unknown as ClientEvent) as unknown as typeof event,
  });
}
