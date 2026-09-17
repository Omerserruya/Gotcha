import { describe, expect, it } from 'vitest';

import { isLoopbackOrigin } from './capture-fixtures';

/**
 * This predicate is the whole safety property: it is what stops capture
 * fixtures engaging on a host that serves real people.
 *
 * The first version of the guard used `NODE_ENV !== 'production'` and was
 * broken in the safe direction — `next start` IS production mode, so the
 * fixtures could never engage at all. These tests pin the replacement in both
 * directions, because a guard that is wrong the other way would be silent.
 */
describe('isLoopbackOrigin', () => {
  it('accepts the addresses only this machine can answer on', () => {
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
  });

  it('refuses a deployed host', () => {
    expect(isLoopbackOrigin('https://dev.gotcha.co.il')).toBe(false);
    expect(isLoopbackOrigin('https://app.gotcha.co.il')).toBe(false);
  });

  it('refuses a hostname that merely contains "localhost"', () => {
    // The reason this parses the URL rather than matching a substring.
    expect(isLoopbackOrigin('https://localhost.evil.example')).toBe(false);
    expect(isLoopbackOrigin('https://notlocalhost')).toBe(false);
  });

  it('fails closed on anything it cannot vouch for', () => {
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
    expect(isLoopbackOrigin('not a url')).toBe(false);
  });
});
