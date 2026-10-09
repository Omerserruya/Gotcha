import { describe, expect, it } from 'vitest';

import {
  booleanParam,
  enumParam,
  isoDateParam,
  numberParam,
  stringParam,
  stringSetParam,
} from './codecs';

describe('URL codecs', () => {
  it('omits defaults so a shared link stays meaningful', () => {
    expect(stringParam('').encode('')).toBeNull();
    expect(numberParam(1).encode(1)).toBeNull();
    expect(booleanParam(false).encode(false)).toBeNull();
    expect(enumParam(['list', 'board'], 'list').encode('list')).toBeNull();
    expect(stringSetParam().encode([])).toBeNull();
  });

  it('round-trips non-default values', () => {
    const status = enumParam(['open', 'closed'], 'open');
    expect(status.decode(status.encode('closed'))).toBe('closed');

    const page = numberParam(1);
    expect(page.decode(page.encode(7))).toBe(7);

    const tags = stringSetParam();
    expect(tags.decode(tags.encode(['b', 'a']))).toEqual(['a', 'b']);
  });

  it('falls back to the default for anything malformed, rather than throwing', () => {
    // The URL is user-editable and links get shared across app versions.
    expect(numberParam(1).decode('not-a-number')).toBe(1);
    expect(numberParam(1).decode('Infinity')).toBe(1);
    expect(enumParam(['open', 'closed'], 'open').decode('deleted')).toBe('open');
    expect(isoDateParam().decode('2026-13-45')).toBeNull();
    expect(isoDateParam().decode('yesterday')).toBeNull();
  });

  it('treats an absent parameter as the default', () => {
    expect(stringParam('all').decode(null)).toBe('all');
    expect(booleanParam(true).decode(null)).toBe(true);
    expect(stringSetParam(['x']).decode(null)).toEqual(['x']);
  });

  it('sorts a set so two equivalent selections produce one URL', () => {
    const tags = stringSetParam();
    expect(tags.encode(['b', 'a'])).toBe(tags.encode(['a', 'b']));
  });

  it('accepts a valid ISO date', () => {
    expect(isoDateParam().decode('2026-09-01')).toBe('2026-09-01');
  });
});
