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
