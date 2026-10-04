import { describe, expect, it } from 'vitest';

import { safeMediaUrl } from './media';

describe('★★ a media address is followed only over https or on this host', () => {
  it.each([
    ['/api/uploads/a.jpg', '/api/uploads/a.jpg'],
    ['https://cdn.example/a.jpg', 'https://cdn.example/a.jpg'],
    ['http://cdn.example/a.jpg', null],
    ['//evil.example/a.jpg', null],
    ['/\\evil.example/a.jpg', null],
    ['javascript:alert(1)', null],
    ['data:image/png;base64,AA', null],
    ['', null],
    [null, null],
  ])('%j → %j', (raw, url) => {
    expect(safeMediaUrl(raw)).toBe(url);
  });
});
