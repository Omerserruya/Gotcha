import { describe, expect, it } from 'vitest';

import { channelIconUrl, notificationSvg } from './notification-icon';

/**
 * The desktop notification's icon: the inbox's own channel mark, on a plate,
 * rasterised. jsdom has no canvas and no stylesheet, so this checks the SVG
 * that would be rasterised - and that a missing token means no icon, never a
 * wrong one.
 */
const colours = { plate: '#fff', ink: '#3a3833' };

describe('★★ the notification draws the same mark the inbox does', () => {
  it('a brand mark in its own colours, on the plate', () => {
    const svg = notificationSvg('WHATSAPP', colours)!;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<circle cx="48" cy="48" r="48" fill="#fff"/>');
    expect(svg).toContain('data-channel-mark=""');
    expect(svg).toContain('data-glyph="whatsapp"');
    expect(svg).toContain('fill="#25D366"');
    // At half the icon's size, centred.
    expect(svg).toContain('width="48" height="48"');
    expect(svg).toContain('translate(24 24)');
  });

  it('★ a neutral glyph is inked in the tone’s colour, through currentColor', () => {
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
