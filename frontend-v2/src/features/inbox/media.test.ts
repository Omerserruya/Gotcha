import { describe, expect, it, vi } from 'vitest';

import { fileLabelOf, fileSizeOf, mediaKind, quoteOf, safeMediaUrl } from './media';

describe('★★ a media address is followed only over https or through the BFF', () => {
  it.each([
    ['/api/uploads/a.jpg', '/api/bff/api/uploads/a.jpg'],
    [
      '/api/conversations/c1/messages/m1/media/0b6f2c3e-1111-2222-3333-444455556666.jpg',
      '/api/bff/api/conversations/c1/messages/m1/media/0b6f2c3e-1111-2222-3333-444455556666.jpg',
    ],
    ['https://cdn.example/a.jpg', 'https://cdn.example/a.jpg'],
    ['https://api.twilio.com/2010-04-01/Media/ME1', 'https://api.twilio.com/2010-04-01/Media/ME1'],
    ['http://cdn.example/a.jpg', null],
    ['//evil.example/a.jpg', null],
    ['/\\evil.example/a.jpg', null],
    // The parser drops tab, LF and CR before it reads: a prefix check passed these.
    ['/\t/evil.example/a.jpg', null],
    ['/\n/evil.example/a.jpg', null],
    ['/.//evil.example/a.jpg', null],
    ['javascript:alert(1)', null],
    ['data:image/png;base64,AA', null],
    ['', null],
    [null, null],
  ])('%j → %j', (raw, url) => {
    expect(safeMediaUrl(raw)).toBe(url);
  });

  it('★★ under a base path the BFF is the mounted one: /v2/api/bff/api/…, an https link unchanged', async () => {
    /*
     * `BASE_PATH` is read once at module load, so the module is re-imported
     * with it set. At the root the prefix is empty and asserting it would
     * prove nothing (the flow-executor test learned this first).
     */
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/v2');
    try {
      const { safeMediaUrl: mounted } = await import('./media');
      expect(mounted('/api/conversations/c1/messages/m1/media/a.jpg')).toBe(
        '/v2/api/bff/api/conversations/c1/messages/m1/media/a.jpg',
      );
      expect(mounted('https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('★ a quote or a reply preview says what a media message was - never its filler', () => {
  it.each([
    [{ body: '[Image]', messageType: 'image' }, { kind: 'photo' }],
    [{ body: '', messageType: 'video' }, { kind: 'video' }],
    [{ body: '[Voice message]', messageType: 'audio' }, { kind: 'voice' }],
    [{ body: '[Document]', messageType: 'document' }, { kind: 'file' }],
    [{ body: '[Location: 32.08, 34.78]', messageType: 'text' }, { kind: 'location' }],
    [{ body: '[Sticker]', messageType: 'image' }, { kind: 'sticker' }],
    // Backend 9e68eb03: a sticker is stored as one, its body still "[Sticker]".
    [{ body: '[Sticker]', messageType: 'sticker' }, { kind: 'sticker' }],
    [{ body: '', messageType: 'sticker' }, { kind: 'sticker' }],
    [{ body: '', messageType: 'contacts' }, { kind: 'contact' }],
    [{ body: 'see this', messageType: 'image' }, { text: 'see this' }],
    [{ body: '[my own brackets]', messageType: 'text' }, { text: '[my own brackets]' }],
    [{ body: '', messageType: 'text' }, null],
  ])('%o', (message, said) => {
    expect(quoteOf(message)).toEqual(said);
  });
});

describe('★ a file reads by its sender’s name and its size (Backend 9e68eb03)', () => {
  it.each([
    [0, { unit: 'kb', size: 0 }],
    [1, { unit: 'kb', size: 1 }],
    [1536, { unit: 'kb', size: 2 }],
    [999 * 1024, { unit: 'kb', size: 999 }],
    [1000 * 1024, { unit: 'mb', size: 1 }],
    [2.34 * 1024 * 1024, { unit: 'mb', size: 2.3 }],
    [16 * 1024 * 1024, { unit: 'mb', size: 16 }],
    [null, null],
    [undefined, null],
    [-1, null],
    [Number.NaN, null],
  ])('%s bytes → %o', (bytes, size) => {
    expect(fileSizeOf(bytes)).toEqual(size);
  });

  it('the sender’s name first, then the row’s; null when neither names it', () => {
    const media = (originalName: string | null) => ({
      metadata: { media: { mimeType: 'application/pdf', byteSize: 1, originalName } },
    });
    expect(fileLabelOf({ fileName: 'a1b2-uuid.pdf', ...media('Quote.pdf') })).toBe('Quote.pdf');
    expect(fileLabelOf({ fileName: 'Terms.pdf', ...media(null) })).toBe('Terms.pdf');
    expect(fileLabelOf({ fileName: 'Terms.pdf', ...media('  ') })).toBe('Terms.pdf');
    expect(fileLabelOf({ fileName: null, metadata: null })).toBeNull();
  });
});

describe('★ a sticker is a sticker, by its own type (Backend 9e68eb03)', () => {
  it('stored as "sticker" with a .webp: a sticker, never a photo', () => {
    expect(mediaKind({ messageType: 'sticker', mediaUrl: '/api/uploads/x.webp' })).toBe('sticker');
    expect(mediaKind({ messageType: 'sticker', mediaUrl: null })).toBe('sticker');
  });
});
