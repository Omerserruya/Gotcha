import { describe, expect, it } from 'vitest';

import { foldWidget } from './reach';

describe('★ the Website widget is one row in "Answers on"', () => {
  it('its web chat and Shopify chat fold into one, where the first of them was', () => {
    expect(
      foldWidget([
        { channel: 'SHOPIFY_LIVE_CHAT', reach: 'always' },
        { channel: 'WHATSAPP', reach: 'sometimes' },
        { channel: 'WEBCHAT', reach: 'always' },
      ]),
    ).toEqual([
      { channel: 'SHOPIFY_LIVE_CHAT', reach: 'always', widget: true },
      { channel: 'WHATSAPP', reach: 'sometimes', widget: false },
    ]);
  });

  it('always only when every one of its parts is always', () => {
    expect(
      foldWidget([
        { channel: 'WEBCHAT', reach: 'always' },
        { channel: 'SHOPIFY_LIVE_CHAT', reach: 'sometimes' },
      ]),
    ).toEqual([{ channel: 'WEBCHAT', reach: 'sometimes', widget: true }]);
  });

  it('★ a part the read does not list is not counted against it (only active channels are listed)', () => {
    expect(foldWidget([{ channel: 'WEBCHAT', reach: 'always' }])).toEqual([
      { channel: 'WEBCHAT', reach: 'always', widget: true },
    ]);
  });

  it('no widget channel: no widget row', () => {
    expect(foldWidget([{ channel: 'WHATSAPP', reach: 'always' }])).toEqual([
      { channel: 'WHATSAPP', reach: 'always', widget: false },
    ]);
  });
});
