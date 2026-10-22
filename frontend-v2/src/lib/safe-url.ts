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
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ IT USED TO RESOLVE A RELATIVE VALUE ONTO THE SENTINEL AND RETURN IT
 * ════════════════════════════════════════════════════════════════════════════
 * The base was `https://invalid.example` - correct in intent, so a relative
 * value could not silently become a link on OUR origin. But the resolved URL
 * was then returned:
 *
 *     safeLinkUrl("/if/flow/recovery/")  ->  "https://invalid.example/if/flow/recovery/"
 *     safeLinkUrl("example.com/a")       ->  "https://invalid.example/example.com/a"
 *
 * `.invalid` cannot resolve, so both are dead links - and **an inert link that
 * looks real is exactly what the contract above promises callers they will
 * never be handed.** It also made the function unusable for the one caller
 * that most needs it: the identity provider sends `recovery_url` as a path.
 *
 * A relative value is now handled as what it is - an in-app path - and gets
 * the same treatment as anything else going into an `href`.
 */
export function safeLinkUrl(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  /*
   * A leading `/` means an in-app path, and `safeInternalPath` is the stricter
   * predicate for exactly that. Routing it there rather than duplicating the
   * check is what keeps the tab/LF/CR handling in one place - the same
   * duplication that produced the hole it now guards against.
   */
  if (candidate.startsWith('/')) return safeInternalPath(candidate);
  try {
    const url = new URL(candidate);
    return SAFE_SCHEMES.has(url.protocol) ? url.toString() : null;
  } catch {
    /*
     * Not absolute and not a path - `example.com/a`, `../up`, free text. There
     * is no reading of it that is both safe and useful: guessing `https://` in
     * front turns somebody's typo into a navigation to a host we did not
     * check.
     */
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
 * A host this application will never be served from, used only as the base to
 * resolve a candidate against. `.invalid` is reserved by RFC 2606 and cannot
 * resolve, so nothing is reachable even if one of these ever escaped.
 */
const RESOLUTION_BASE = 'https://internal-path.invalid';

/**
 * Returns an in-app path, or null.
 *
 * Stricter than `safeLinkUrl`, and needed for anything the backend hands us as
 * a destination - a notification's `link` is a free-text column with no typed
 * id behind it, so it is somebody's string, not a guaranteed route. Only a
 * path on this origin is accepted; every absolute URL and every smuggled
 * authority is refused, which is what stops a stored value turning the app into
 * an open redirect.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS TESTED THE PREFIX. THE PARSER DOES NOT READ THE PREFIX.
 * ════════════════════════════════════════════════════════════════════════════
 * It used to be three string checks - must start with `/`, not `//`, not `/\`.
 * Every one is a claim about the first two characters, and **the URL parser
 * strips tab, LF and CR from anywhere in a URL before it parses.** So a tab
 * between the slashes walks through all three and then vanishes:
 *
 *     "/\t/evil.example"   starts with "/"  ✓   not "//"  ✓   not "/\\"  ✓
 *     the browser reads    //evil.example       ->  https://evil.example/
 *
 * Measured, not reasoned: `\t`, `\n` and `\r` each produce a fully off-site
 * navigation; `\0` does not, being percent-encoded rather than stripped.
 *
 * ★★ **AND THIS IS THE SINK THAT WAS LIVE.** An `href` is resolved by the
 *   BROWSER against the document, so nothing stands in front of it: on the
 *   served page, `<a href="/<TAB>/evil.example">` navigates to
 *   `https://evil.example/`. The auth caller of the same predicate was safe
 *   all along - it concatenates onto a fixed authority - which is the opposite
 *   of what I first wrote. The reachable half was the one rendered into
 *   markup, and it needs no crafted link: `link` on a notification is a
 *   free-text column, so **a stored row is the whole attack**.
 *
 * ── SO IT NO LONGER INSPECTS THE STRING; IT RESOLVES IT ──
 * The candidate is parsed against an origin we can never be served from and
 * kept only if it stayed there. That asks the question the payload is aimed
 * at - *where does this actually point* - with the same parser that will
 * resolve it later, rather than a list of the tricks somebody thought of.
 *
 * ★ And it returns the parser's OUTPUT, not the input, so an approved value is
 *   already canonical and cannot be reinterpreted by whatever renders it.
 *   Checking one string and then navigating to a different one is how the
 *   original got through.
 *
 * ── WHY IT LIVES HERE AND NOT BESIDE THE AUTH CODE ──
 * `safeReturnPath` in `auth/login-state.ts` had **the identical three checks
 * and the identical hole**, found by sweeping for the shape after fixing this
 * one. Two copies of a security predicate is one copy too many; it delegates
 * here now, and differs only in what it returns when it says no.
 */
export function safeInternalPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  /*
   * Still required, and no longer load-bearing on its own: resolution would
   * happily accept `inbox` as a relative path, and every caller supplies an
   * absolute in-app path. Rejecting the rest keeps the accepted shape narrow
   * rather than merely safe.
   */
  if (!candidate.startsWith('/')) return null;

  let resolved: URL;
  try {
    resolved = new URL(candidate, RESOLUTION_BASE);
  } catch {
    return null;
  }
  // Any scheme, host or port smuggled in - however it was spelled - moved the
  // origin. That single comparison replaces the list of spellings.
  if (resolved.origin !== RESOLUTION_BASE) return null;

  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ AND THE REPAIR HAD THE SAME SHAPE AS THE DEFECT. THIS LINE IS WHY.
   * ════════════════════════════════════════════════════════════════════════
   * Resolving against a fixed origin is not enough on its own, because path
   * normalisation can MANUFACTURE an authority the origin check never saw:
   *
   *     "/.//evil.example"   origin -> internal-path.invalid   ✓ accepted
   *                          pathname -> "//evil.example"      ★ authority
   *
   * `.` and `..` collapse to nothing and leave two leading slashes. The origin
   * comparison is satisfied because the smuggled host was not in the URL when
   * it was parsed - it appeared as a RESULT of parsing it.
   *
   * Caught by mutation testing, which showed the origin comparison could be
   * deleted outright with every assertion still green: the fixtures all had an
   * empty path, so discarding the host and keeping the path looked correct.
   */
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
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
