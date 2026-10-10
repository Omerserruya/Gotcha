import { describe, expect, it } from 'vitest';

import { fileLabelOf, fileSizeOf, mediaKind, quoteOf, safeMediaUrl } from './media';

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
