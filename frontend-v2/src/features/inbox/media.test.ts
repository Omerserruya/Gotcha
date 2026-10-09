import { describe, expect, it } from 'vitest';

import { quoteOf, safeMediaUrl } from './media';

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
    [{ body: '', messageType: 'contacts' }, { kind: 'contact' }],
    [{ body: 'see this', messageType: 'image' }, { text: 'see this' }],
    [{ body: '[my own brackets]', messageType: 'text' }, { text: '[my own brackets]' }],
    [{ body: '', messageType: 'text' }, null],
  ])('%o', (message, said) => {
    expect(quoteOf(message)).toEqual(said);
  });
});
