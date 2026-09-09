/**
 * URL safety at the rendering boundary.
 *
 * Media URLs, link previews and customer-supplied links all arrive from
 * outside. Placing an unvalidated one in `href` or `src` is how `javascript:`
 * and `data:text/html` payloads become script execution - the classic XSS
 * route that survives every other precaution because the value looks like
 * ordinary data right up until the browser navigates to it.
 */

/** Schemes safe to navigate to or load. Anything else is rejected. */
const SAFE_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);

/** Schemes safe for media, where navigation is not involved. */
const SAFE_MEDIA_SCHEMES = new Set(['https:', 'blob:']);

/**
 * Returns the URL if it is safe to use as a link target, otherwise null.
 *
 * Callers render nothing rather than an inert link, so a rejected URL is
 * visible as a missing affordance rather than a broken one.
 */
export function safeLinkUrl(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate, 'https://invalid.example');
    return SAFE_SCHEMES.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Returns the URL if it is safe to load as media, otherwise null.
 *
 * Stricter than links: plain `http:` is excluded because loading it on an
 * HTTPS page is mixed content, and `data:` because a `data:image/svg+xml`
 * carrying a script is indistinguishable from an image until it runs.
 */
export function safeMediaUrl(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return SAFE_MEDIA_SCHEMES.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Returns an in-app path, or null.
 *
 * Stricter than `safeLinkUrl`, and needed for anything the backend hands us as
 * a destination — a notification's `link` is a free-text column with no typed
 * id behind it, so it is somebody's string, not a guaranteed route. Only a
 * single-slash-prefixed relative path is accepted: `//host` and every absolute
 * URL are refused, which is what stops a stored value turning the app into an
 * open redirect.
 */
export function safeInternalPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  if (!candidate.startsWith('/')) return null;
  if (candidate.startsWith('//')) return null;
  if (candidate.startsWith('/\\')) return null;
  return candidate;
}

/**
 * Attributes every link to somewhere we do not control must carry.
 *
 * `noopener` is the important one: without it the opened page gets a handle on
 * ours through `window.opener` and can navigate it somewhere convincing.
 */
export const EXTERNAL_LINK_ATTRIBUTES = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;
