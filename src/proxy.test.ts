import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The proxy issues the Content-Security-Policy and runs the coarse auth gate,
 * and it had no tests.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WIRING IS THE PART THAT SILENTLY GOES WRONG
 * ════════════════════════════════════════════════════════════════════════════
 * `content-security-policy.ts` is well covered, and a policy nobody applies to
 * the right route is worth nothing. Screen 00a put a password field in our own
 * bundle, so "did the narrower policy actually reach the sign-in page" is now a
 * security question rather than a tidiness one.
 */

/*
 * An async factory with a dynamic import: a `vi.mock` factory is hoisted above
 * the imports, so it cannot close over the `NextResponse` at the top of this
 * file, and `require()` is forbidden here.
 */
vi.mock('next-intl/middleware', async () => {
  const { NextResponse: Response } = await import('next/server');
  return { default: () => () => Response.next() };
});

const { default: proxy } = await import('./proxy');

const cspFor = (path: string): string => {
  const response = proxy(new NextRequest(`https://dev.gotcha.co.il${path}`));
  return response.headers.get('content-security-policy') ?? '';
};

const directive = (csp: string, name: string): string[] => {
  const found = csp
    .split('; ')
    .map((part) => part.split(' '))
    .find((parts) => parts[0] === name);
  return found ? found.slice(1) : [];
};

describe('★★ the narrower policy reaches the page that has a password on it', () => {
  it('★★ sign-in gets no `https:` image wildcard', () => {
    expect(directive(cspFor('/en/sign-in'), 'img-src')).toEqual(["'self'", 'data:']);
  });

  it('★★ and every other page keeps it, or avatars break', () => {
    /*
     * Both directions. A narrowing that leaked into the product would stop
     * customer photos loading and read as a backend failure — and a test that
     * only checked sign-in could not tell the two apart.
     */
    expect(directive(cspFor('/en/home'), 'img-src')).toContain('https:');
    expect(directive(cspFor('/en/inbox'), 'img-src')).toContain('https:');
  });

  it('★★ matches sign-in with and without a locale, and with a trailing slash', () => {
    /*
     * The pattern decides both the auth gate and now the policy. A locale it does
     * not match would be a sign-in page that is ALSO treated as private — an
     * infinite redirect — so this list is not cosmetic.
     */
    for (const path of ['/sign-in', '/en/sign-in', '/he/sign-in', '/en/sign-in/']) {
      expect(directive(cspFor(path), 'img-src'), path).toEqual(["'self'", 'data:']);
    }
  });

  it('★★ does not match a path that merely starts with the same letters', () => {
    /*
     * `/sign-in-help` is not the sign-in page. A prefix match here would hand a
     * narrower policy to an unrelated route — and, through the same pattern,
     * make it public. Prefix collisions have already cost a wrong count on the
     * security screen this week.
     */
    expect(directive(cspFor('/en/sign-in-help'), 'img-src')).toContain('https:');
  });

  it('★ every response carries a nonce, and a different one each time', () => {
    // A reused nonce is no better than `unsafe-inline`.
    const first = cspFor('/en/home');
    const second = cspFor('/en/home');
    expect(first).toMatch(/'nonce-[^']+'/);
    expect(first).not.toBe(second);
  });
});
