/**
 * Where the mobile app's own screens are, as one rule the shell, the tabs and
 * the native bridge all read.
 *
 * Paths here are locale-less (`usePathname` from `@/i18n/navigation` strips
 * the prefix), except in `isAppPath`, which reads a full URL path as the
 * native shell sees it.
 */

const MOBILE_ROOT = '/m';

/**
 * One thing open over its list - a conversation, an approval, a campaign, a
 * customer (`/m/<list>/<id>`): a full screen with a way back, and no tabs.
 * And what is known about a conversation's customer (`/m/inbox/<id>/customer`),
 * a screen over the thread.
 */
export function inMobileOverlay(pathname: string): boolean {
  return /^\/m\/(?:(?:home|inbox|approvals|outreach|customers)\/[^/]+|inbox\/[^/]+\/customer)\/?$/.test(
    pathname,
  );
}

/**
 * Whether a full path (`/he/m/inbox`, `/v2/en/m/approvals`) is one of the
 * app's screens. Anything else is the website, which the app opens in the
 * system browser rather than inside itself.
 */
export function isAppPath(fullPath: string): boolean {
  return /^(?:\/[^/]+)?\/[a-z]{2}\/m(?:\/|$)/.test(fullPath);
}

/**
 * A notification's `link` as the app should open it: the platform sends a
 * locale-less mobile path (`/m/inbox/<id>`). Anything that is not one is
 * refused, so a payload cannot steer the app to an arbitrary page.
 */
export function mobileLinkFrom(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  if (!link.startsWith(`${MOBILE_ROOT}/`)) return null;
  if (link.includes('//') || link.includes('..')) return null;
  return /^\/m\/[A-Za-z0-9/_-]+(?:\?[A-Za-z0-9=&_-]*)?$/.test(link) ? link : null;
}
