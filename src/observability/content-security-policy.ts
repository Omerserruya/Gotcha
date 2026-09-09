/**
 * Content Security Policy.
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
}): string {
  const { nonce, realtimeUrl, isDevelopment } = options;

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
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...realtimeOrigins, ...(isDevelopment ? ['ws:'] : [])],
    'media-src': ["'self'", 'blob:', 'https:'],
    // No plugins, ever.
    'object-src': ["'none'"],
    // Stops an injected <base> silently repointing every relative URL.
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // The clickjacking control. Repeated as X-Frame-Options for old browsers.
    'frame-ancestors': ["'none'"],
    'frame-src': ["'self'"],
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
