import { describe, expect, it } from 'vitest';

import { channelIconUrl, notificationSvg } from './notification-icon';

/**
 * The desktop notification's icon: the shared channel mark, on the shared
 * plate's shape (`PLATE_GEOMETRY`), rasterised. jsdom has no canvas and no stylesheet, so this checks the SVG
 * that would be rasterised - and that a missing token means no icon, never a
 * wrong one.
 */
const colours = { plate: '#fff', edge: '#ede9e1', ink: '#3a3833' };

describe('★★ the notification draws the same mark the inbox does', () => {
  it('a brand mark in its own colours, on the plate', () => {
    const svg = notificationSvg('WHATSAPP', colours)!;
    expect(svg.startsWith('<svg')).toBe(true);
    // The plate every screen draws: its white, its hairline, its radius - the
    // `xxl` preset (40 / 24 / radius 11, 1px edge) scaled 2.4× to the icon.
    expect(svg).toContain(
      '<rect x="1.2" y="1.2" width="93.6" height="93.6" rx="25.2" fill="#fff" stroke="#ede9e1" stroke-width="2.4"/>',
    );
    expect(svg).toContain('data-channel-mark=""');
    expect(svg).toContain('data-glyph="whatsapp"');
    expect(svg).toContain('fill="#25D366"');
    // At the plate's proportion (0.6), centred.
    expect(svg).toContain('width="58" height="58"');
    expect(svg).toContain('translate(19 19)');
  });

  it.each(['INSTAGRAM', 'GMAIL', 'OUTLOOK'])(
    '★ %s: its gradients travel with it - every url(#…) is defined in the image itself',
    (channel) => {
      const svg = notificationSvg(channel, colours)!;
      const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const id of refs) expect(svg).toMatch(new RegExp(`<(linear|radial)Gradient id="${id}"`));
      expect(svg).not.toContain('var(');
    },
  );

  it('★ a neutral glyph is inked in the plate’s ink, through currentColor', () => {
    const svg = notificationSvg('VOICE', colours)!;
    expect(svg).toContain('data-glyph="phone"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('color="#3a3833"');
  });

  it('⚠ an unknown channel gets the neutral fallback, not nothing', () => {
    expect(notificationSvg('SOMETHING_NEW', colours)).toContain('data-glyph="unknown"');
    expect(notificationSvg(null, colours)).toContain('data-glyph="unknown"');
  });

  it('⚠ no tokens, no icon - never a wrong one', async () => {
    await expect(channelIconUrl('WHATSAPP')).resolves.toBeUndefined();
  });
});
