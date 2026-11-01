/**
 * Support mode's codes - a contract with the platform (Backend
 * `support-deny.ts` and `support-principal.ts`, 2026-11-01). Shared by the
 * server and the browser, so it imports nothing.
 *
 * A support session is a GOTCHA admin working inside a customer's workspace
 * as its admin (Omer, 2026-11-01). What it may not do is refused by the
 * platform with a 403 and one of four codes; a session that is over is a 401
 * with one of two.
 */

/** The four refusals, each answered 403. */
export const SUPPORT_DENY_KINDS = ['billing', 'delete', 'ownership', 'secrets'] as const;

export type SupportDenyKind = (typeof SUPPORT_DENY_KINDS)[number];

const DENY_PREFIX = 'support_denied:';

/**
 * Whether a code is a support refusal. ★ ANY `support_denied:*`, not only
 * the four: a refusal the platform adds later still reads as "not allowed in
 * support mode" (the supervisor's fallback, 2026-11-01), never as a failure.
 */
export function isSupportDenied(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.startsWith(DENY_PREFIX);
}

/**
 * The 401s that end the SUPPORT session and leave the admin's own sign-in as
 * it was. Any other 401 is the sign-in itself, handled as before.
 */
const ENDED_CODES: ReadonlySet<string> = new Set(['support_expired', 'support_session_invalid']);

export function isSupportEnded(code: string | null | undefined): boolean {
  return typeof code === 'string' && ENDED_CODES.has(code);
}

/** The header that names the session upstream. The BFF and the server set it, never the browser. */
export const SUPPORT_SESSION_HEADER = 'x-support-session';

/**
 * Whether a platform route is the console's: `/api/system/*` (auth) and
 * `/api/admin/*` (billing's coupons and pricing) - every console endpoint in
 * the registry. ★★ THESE NEVER CARRY THE SUPPORT SESSION: `requireSystemAdmin`
 * refuses a support principal (it is the tenant's ADMIN), so starting, reading
 * and ending a session - and every other console call - go out as the admin.
 */
export function isConsoleRoute(route: string): boolean {
  return /^\/api\/(?:system|admin)(?:\/|$)/.test(route);
}

/**
 * Clears the support cookie and opens the console's page for that workspace,
 * "Support mode ended" (`app/api/session/support-ended/route.ts`). A route,
 * because a render cannot clear a cookie; under `/api/session/`, a prefix the
 * gateway gives this app.
 */
export const SUPPORT_ENDED_PATH = '/api/session/support-ended';
