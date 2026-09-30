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

describe('★★ the ruling: cap the message, keep the beginning', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * DECIDED 2026-09-30, AFTER BEING NAMED AS OPEN
   * ════════════════════════════════════════════════════════════════════════
   * Neither blind nor raw. An error reading `[redacted]` is useless; a whole
   * response body must not reach a log sink. A cap satisfies both, and the
   * beginning is where the cause is.
   */
  it('⚠⚠ keeps the START of a long message, not the end and not nothing', () => {
    /*
     * ★ THIS IS THE DIRECTION THAT MATTERS. A cap returning '' would pass
     *   every "nothing leaked" assertion and make every log line useless —
     *   a guard that holds by refusing to do its job.
     */
    const message = `DIAGNOSTIC-PREFIX ${'x'.repeat(4000)}`;
    const capped = redact(new Error(message)) as { message: string };

    expect(capped.message.startsWith('DIAGNOSTIC-PREFIX ')).toBe(true);
    expect(capped.message.length).toBeGreaterThan(100);
  });

  it('⚠⚠ and still caps it, so a response body cannot ride out whole', () => {
    const body = 'y'.repeat(20_000);
    const capped = redact(new Error(body)) as { message: string };

    expect(capped.message.length).toBeLessThan(600);
    expect(capped.message).not.toContain('y'.repeat(1000));
  });

  it('★ a short message is untouched — the cap is a ceiling, not a transform', () => {
    expect(redact(new Error('connect ECONNREFUSED 10.0.0.4:5432'))).toEqual({
      name: 'Error',
      message: 'connect ECONNREFUSED 10.0.0.4:5432',
    });
  });

  it('⚠ while `message` as a FIELD is still blinded — the asymmetry is deliberate', () => {
    // Two rules for one word. A future reader finding this inconsistent should
    // read the note in `redact.ts` before making them agree.
    expect(redact({ message: 'a customer said something' })).toEqual({ message: REDACTED });
  });
});
