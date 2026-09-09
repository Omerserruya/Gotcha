import { describe, expect, it } from 'vitest';

import { safeReturnPath } from './login-state';

describe('safeReturnPath', () => {
  it('accepts an in-app path', () => {
    expect(safeReturnPath('/inbox/123?filter=open')).toBe('/inbox/123?filter=open');
  });

  const hostile: readonly (readonly [string | null, string])[] = [
    ['https://evil.example', 'an absolute URL'],
    ['//evil.example', 'a protocol-relative URL'],
    ['/\\evil.example', 'a backslash-smuggled host'],
    ['javascript:alert(1)', 'a javascript URL'],
    ['', 'an empty value'],
    [null, 'null'],
  ];

  for (const [candidate, description] of hostile) {
    it(`rejects ${description}`, () => {
      expect(safeReturnPath(candidate)).toBe('/');
    });
  }
});
