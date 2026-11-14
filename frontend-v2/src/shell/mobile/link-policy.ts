import { isAppPath } from './mobile-paths';

/**
 * Where a tapped link goes inside the native app: `null` stays in the app,
 * a URL goes to the system browser (`NativeBridge`).
 *
 * ★ `data-in-app` keeps a link in the app whatever its address: the photo
 *   viewer's link (`PhotoLink`) opens over the thread, and the browser it also
 *   opened had no session and answered 401 (Omer, 2026-11-04).
 */
export function outsideUrl(anchor: HTMLAnchorElement, here: Location | URL): string | null {
  if (anchor.hasAttribute('data-in-app')) return null;
  const url = new URL(anchor.href, here.href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const sameSite = url.origin === here.origin;
  if (sameSite && (isAppPath(url.pathname) || url.pathname.includes('/api/auth/'))) return null;
  return url.href;
}

/**
 * The message a document link is for, read from its logged-in URL
 * (`…/conversations/:c/messages/:m/media/:name`), when the link is marked
 * `data-signed-file`. `null` for any other link.
 */
export function signedFileOf(
  anchor: HTMLAnchorElement,
): { readonly conversationId: string; readonly messageId: string } | null {
  if (!anchor.hasAttribute('data-signed-file')) return null;
  const match = /\/conversations\/([^/?#]+)\/messages\/([^/?#]+)\/media\/[^/?#]+/.exec(
    new URL(anchor.href, 'https://x.invalid').pathname,
  );
  if (!match) return null;
  return {
    conversationId: decodeURIComponent(match[1]!),
    messageId: decodeURIComponent(match[2]!),
  };
}
