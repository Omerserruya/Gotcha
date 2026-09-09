import { describe, expect, it } from 'vitest';

import { safeInternalPath, safeLinkUrl, safeMediaUrl } from './safe-url';

describe('safeLinkUrl', () => {
  it('accepts ordinary web and contact schemes', () => {
    expect(safeLinkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeLinkUrl('tel:+972500000000')).toBe('tel:+972500000000');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects %s', (hostile) => {
    expect(safeLinkUrl(hostile)).toBeNull();
  });

  it('rejects empty and malformed input', () => {
    expect(safeLinkUrl('')).toBeNull();
    expect(safeLinkUrl(null)).toBeNull();
    expect(safeLinkUrl(undefined)).toBeNull();
  });
});

describe('safeMediaUrl', () => {
  it('accepts https and blob', () => {
    expect(safeMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(safeMediaUrl('blob:https://app.example.com/abc')).toBe(
      'blob:https://app.example.com/abc',
    );
  });

  it('rejects plain http, which would be mixed content on an https page', () => {
    expect(safeMediaUrl('http://cdn.example.com/a.png')).toBeNull();
  });

  it('rejects data URLs, since an SVG one can carry a script', () => {
    expect(safeMediaUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
  });
});

describe('safeInternalPath', () => {
  it('accepts an in-app path', () => {
    expect(safeInternalPath('/inbox/conv_123')).toBe('/inbox/conv_123');
  });

  it.each([
    '//evil.example',
    'https://evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'inbox',
  ])('rejects %s', (hostile) => {
    // A notification's `link` is a free-text column somebody wrote. Treating
    // it as a trusted route is how a stored value becomes an open redirect.
    expect(safeInternalPath(hostile)).toBeNull();
  });

  it('rejects empty input', () => {
    expect(safeInternalPath('')).toBeNull();
    expect(safeInternalPath(null)).toBeNull();
  });
});
