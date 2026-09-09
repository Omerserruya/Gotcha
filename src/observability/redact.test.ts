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
