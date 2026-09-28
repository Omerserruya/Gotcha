import { describe, expect, it } from 'vitest';

import { REDACTED, redact } from './redact';

describe('redact', () => {
  it('removes credentials', () => {
    expect(redact({ accessToken: 'abc', authorization: 'Bearer x' })).toEqual({
      accessToken: REDACTED,
      authorization: REDACTED,
    });
  });

  it('removes customer content and identifiers', () => {
    expect(
      redact({ message: 'hello', email: 'a@b.com', phone: '+972', conversationId: 'c_1' }),
    ).toEqual({
      message: REDACTED,
      email: REDACTED,
      phone: REDACTED,
      conversationId: 'c_1',
    });
  });

  it('reaches into nested objects', () => {
    expect(redact({ outer: { password: 'p', id: '1' } })).toEqual({
      outer: { password: REDACTED, id: '1' },
    });
  });

  it('stops at a depth limit rather than walking a cyclic structure forever', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    expect(JSON.stringify(redact(deep))).toContain('truncated');
  });

  it('keeps an error readable without its stack', () => {
    expect(redact(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' });
  });
});

describe('⚠⚠ an error message is a string like any other', () => {
  it('⚠⚠ is capped at the same length as every other string', () => {
    /*
     * It was the ONLY path with no cap, and the one most likely to carry a
     * whole response body — an upstream failure is exactly where one ends up,
     * and `cause` is logged at 900+ call sites.
     *
     * Measured before the fix: a 2,000-character field came back 513
     * characters, the same text as an `Error` came back 2,000.
     */
    const long = 'x'.repeat(2000);
    const asField = redact({ detail: long }) as Record<string, unknown>;
    const asError = redact(new Error(long)) as Record<string, unknown>;
    expect(String(asError.message).length).toBe(String(asField.detail).length);
    expect(String(asError.message).length).toBeLessThan(600);
  });

  it('★ and a short one is still readable, or this is just deletion', () => {
    // Both directions. Capping everything to nothing satisfies the assertion
    // above and makes every log line useless.
    expect(redact(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' });
  });
});
