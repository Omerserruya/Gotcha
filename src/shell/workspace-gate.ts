/**
 * Who may use the product, from the server's word on the workspace (Omer,
 * 2026-10-07: onboarding is a gate). `GET /api/auth/me` answers
 * `tenantStatus` and `user.role`; nothing here is a client guess.
 *
 *   ACTIVE                                  the product, as today
 *   PENDING_PAYMENT                         the existing payment flow
 *   PENDING_ADMIN_SETUP / PENDING_ONBOARDING  an ADMIN: onboarding, resumed
 *                                             anyone else: "still being set up"
 *   SUSPENDED, or a status this does not know  the product, as today - the
 *                                             API refuses what it must, and the
 *                                             tenant notice says why
 *   unread                                  "Couldn't load your workspace",
 *                                             with Retry - never the product,
 *                                             never a permanent lock-out
 */
export type WorkspaceRoute = 'product' | 'onboarding' | 'waiting' | 'payment' | 'unavailable';

const SETTING_UP = new Set(['PENDING_ADMIN_SETUP', 'PENDING_ONBOARDING']);

export function workspaceRoute(
  me: { readonly tenantStatus: string | null; readonly role: string | null } | null,
): WorkspaceRoute {
  if (me === null || me.tenantStatus === null) return 'unavailable';
  if (me.tenantStatus === 'PENDING_PAYMENT') return 'payment';
  if (SETTING_UP.has(me.tenantStatus)) return me.role === 'ADMIN' ? 'onboarding' : 'waiting';
  return 'product';
}

/**
 * Onboarding as a preview (Omer, 2026-10-07): a LIVE workspace's admin may
 * walk the onboarding screens with `?preview=1` - read-only, never
 * finishing. Anyone else, and any other status, is gated as usual.
 */
export function mayPreviewOnboarding(
  me: { readonly tenantStatus: string | null; readonly role: string | null } | null,
): boolean {
  return me?.tenantStatus === 'ACTIVE' && me.role === 'ADMIN';
}

/** `?preview=1` in a path-and-query (the proxy's return-to header). */
export function asksForPreview(pathAndQuery: string | null): boolean {
  if (!pathAndQuery) return false;
  const at = pathAndQuery.indexOf('?');
  return at >= 0 && new URLSearchParams(pathAndQuery.slice(at + 1)).get('preview') === '1';
}

/** The onboarding step to resume at, by what really exists on the server. */
export function resumeStep(state: {
  /** The website read's row: `null` when it never ran. */
  readonly discovery: { readonly status: string } | null;
  /** A store or CRM counted as the core system. */
  readonly coreConnected: boolean;
}): 'website' | 'reading' | 'learned' | 'truth' | 'try' {
  const status = state.discovery?.status ?? null;
  if (status === 'SCANNING') return 'reading';
  if (status !== 'COMPLETE') return 'website';
  return state.coreConnected ? 'try' : 'learned';
}
