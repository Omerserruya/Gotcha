import { describe, expect, it } from 'vitest';

import { productCallbackUrl } from './oidc';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE SAME EXPRESSION NAMED TWO DIFFERENT URLS ON TWO DEPLOYMENTS
 * ════════════════════════════════════════════════════════════════════════════
 * `redirectUri()` reads `APP_ORIGIN`. On the product container that is the
 * product; on the sign-in container it is the sign-in host. The finishing hop
 * ran on the second and compared the provider's completion against the wrong
 * one, so a correct `to` was refused — silently, because refusing is what that
 * guard is for.
 */
describe('⚠⚠ the product’s callback, from the only thing this container knows', () => {
  it('★★ is the sibling of the configured product login URL', () => {
    expect(productCallbackUrl('https://dev.gotcha.co.il/v2/api/auth/login')).toBe(
      'https://dev.gotcha.co.il/v2/api/auth/callback',
    );
  });

  it('⚠⚠ keeps the mount point, which is the whole reason it is derived', () => {
    /*
     * `/v2` is the base path. Composing this from an origin would drop it —
     * the absolute-path defect this repository has had four times — and the
     * result would be refused by exactly the guard we are trying to satisfy.
     */
    expect(productCallbackUrl('https://dev.gotcha.co.il/api/auth/login')).toBe(
      'https://dev.gotcha.co.il/api/auth/callback',
    );
    expect(productCallbackUrl('https://x.test/deep/mount/api/auth/login')).toBe(
      'https://x.test/deep/mount/api/auth/callback',
    );
  });

  it('⚠ drops any query or fragment, which belong to the login request', () => {
    expect(productCallbackUrl('https://dev.gotcha.co.il/v2/api/auth/login?handover=1#x')).toBe(
      'https://dev.gotcha.co.il/v2/api/auth/callback',
    );
  });

  it('⚠⚠ answers null rather than guessing when the shape is unfamiliar', () => {
    /*
     * A guess here produces an expectation the provider's completion can never
     * match, which reads as "the hop is broken" rather than "the configuration
     * is unexpected".
     */
    for (const bad of [
      undefined,
      '',
      'not a url',
      'https://dev.gotcha.co.il/v2/api/auth/signin',
      'https://dev.gotcha.co.il/v2/api/auth/login/extra',
      '/v2/api/auth/login',
    ]) {
      expect(productCallbackUrl(bad as string | undefined), String(bad)).toBeNull();
    }
  });
});
