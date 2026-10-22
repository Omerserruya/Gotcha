import type { Breadcrumb, ErrorEvent, TransactionEvent } from '@sentry/core';

/**
 * Scrubbing applied to every Sentry event, on every runtime.
 *
 * The rule is that nothing leaves this application which could identify a
 * customer or reconstruct a conversation. What Sentry gets is: what broke,
 * where, in which environment, for which *tenant* - and a user id, never an
 * email, name or phone number.
 *
 * Query strings are dropped wholesale rather than filtered, because search
 * terms, filters and identifiers all live there and an allowlist would
 * eventually miss one.
 */
export function scrubEvent<T extends ErrorEvent | TransactionEvent>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
    if (event.request.url) {
      const [withoutQuery] = event.request.url.split('?');
      event.request.url = withoutQuery;
    }
    event.request.query_string = undefined;
  }

  if (event.user) {
    // Identify the account, never the person.
    event.user = { id: event.user.id };
  }

  event.breadcrumbs = event.breadcrumbs?.map((breadcrumb: Breadcrumb) => ({
    ...breadcrumb,
    // Breadcrumb data is where message bodies and customer records leak in.
    data:
      breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr'
        ? undefined
        : breadcrumb.data,
  }));

  return event;
}

/**
 * Sampling.
 *
 * Health checks and static assets are dropped outright: they are constant
 * traffic and tell us nothing. Everything else follows the configured rate.
 */
export function tracesSampler(context: { name?: string; parentSampled?: boolean }): number {
  if (context.name?.startsWith('/api/health')) return 0;
  if (context.parentSampled !== undefined) return context.parentSampled ? 1 : 0;
  return Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1);
}

/**
 * Context Sentry may attach to every event.
 *
 * Tenant id is included on purpose - it is how an incident is scoped to a
 * workspace, and it identifies an organisation rather than a person. User id
 * is an opaque identifier, never an email.
 */
export interface SafeSentryContext {
  readonly userId?: string;
  readonly tenantId?: string;
}
