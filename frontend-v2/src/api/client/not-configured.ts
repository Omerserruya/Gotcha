import { isApiError } from './api-error';

/**
 * "This connection isn't set up in this environment" - the provider's app has
 * no client id or redirect here, so nothing can be connected until it does.
 *
 * Read from `code` first: `NOT_CONFIGURED` is the code these refusals are to
 * carry. Until they do, the OAuth starts answer a 500 whose `error` says it in
 * one of two spellings, and both are read:
 *
 *   connectors-admin.ts   `hubspot_oauth_not_configured`
 *   crm-oauth.ts, calendar-oauth.ts, knowledge-oauth.ts
 *                         "Zoho OAuth not configured (set ...)",
 *                         "Google Calendar OAuth not configured",
 *                         "Google Drive OAuth not configured", ...
 *
 * The old match was `/not_configured/`, which the legacy routes' space never
 * met: Zoho, Google Calendar and Calendly said a generic "failed".
 */
export function isNotConfigured(cause: unknown): boolean {
  if (!isApiError(cause)) return false;
  if (cause.code === 'NOT_CONFIGURED') return true;
  return cause.status === 500 && /not[ _]configured/i.test(cause.developerMessage ?? '');
}
