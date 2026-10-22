import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChannelPlate, PLATE_GEOMETRY, type PlateSize } from './channel-plate';
import styles from './channel-plate.module.css';

/**
 * The one plate every channel mark sits on. Each migrated screen's own test
 * asserts it draws THIS (`[data-channel-plate]` with the plate class); this
 * file holds the plate itself: the mark on it, its naming, and its geometry.
 */
describe('★★ ChannelPlate - the channel’s mark on the one plate', () => {
  it('draws the shared mark on the plate class, at the preset’s mark size', () => {
    const { container } = render(<ChannelPlate channel="WHATSAPP" size="xl" decorative />);
    const plate = container.querySelector('[data-channel-plate]')!;
    expect(plate).toHaveAttribute('data-channel-plate', 'xl');
    expect(plate.classList).toContain(styles.plate);
    expect(plate.classList).toContain(styles.xl);
    const mark = plate.querySelector('svg')!;
    expect(mark).toHaveAttribute('data-channel-mark');
    expect(mark).toHaveAttribute('data-glyph', 'whatsapp');
    expect(mark).toHaveAttribute('width', String(PLATE_GEOMETRY.xl.mark));
  });

  it('labelled: the mark is an image named for the channel', () => {
    render(<ChannelPlate channel="INSTAGRAM" size="lg" label="Instagram" />);
    const mark = screen.getByRole('img', { name: 'Instagram' });
    expect(mark).toHaveAttribute('data-glyph', 'instagram');
    expect(mark.closest('[data-channel-plate]')).not.toBeNull();
  });

  it('decorative: hidden from a screen reader, never named', () => {
    const { container } = render(<ChannelPlate channel="EMAIL" size="sm" decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    const mark = container.querySelector('svg')!;
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).not.toHaveAttribute('aria-label');
  });

  it('a site’s class places it, alongside the plate - never instead of it', () => {
    const { container } = render(
      <ChannelPlate channel="SLACK" size="xs" decorative className="corner" />,
    );
    const plate = container.querySelector('[data-channel-plate]')!;
    expect([...plate.classList]).toEqual([styles.plate, styles.xs, 'corner']);
  });

  it('⚠ an unknown channel still gets a plate and the neutral mark', () => {
    const { container } = render(<ChannelPlate channel="SOMETHING_NEW" size="md" decorative />);
    expect(container.querySelector('[data-channel-plate] [data-glyph="unknown"]')).not.toBeNull();
  });
});

describe('⚠ the stylesheet draws the numbers `PLATE_GEOMETRY` says', () => {
  /*
   * The notification icon is drawn from `PLATE_GEOMETRY`, the plates from
   * the stylesheet - two documents of one plate. Read both and hold them to
   * each other, so a preset cannot drift in one of them.
   */
  const css = readFileSync('src/design-system/brand/channel-plate.module.css', 'utf8');
  const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
  const px = (name: string) => {
    const found = new RegExp(`${name}:\\s*(\\d+)px;`).exec(tokens);
    return found ? Number(found[1]) : NaN;
  };
  const rule = (size: string) => new RegExp(`\\.${size} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it.each(Object.keys(PLATE_GEOMETRY) as PlateSize[])('%s', (size) => {
    const body = rule(size);
    const token = (property: string) =>
      new RegExp(`${property}: var\\((--[a-z0-9-]+)\\)`).exec(body)?.[1] ?? '';
    const { box, mark, radius } = PLATE_GEOMETRY[size];
    expect(px(token('inline-size'))).toBe(box);
    expect(px(token('block-size'))).toBe(box);
    expect(px(token('border-radius'))).toBe(radius);
    // Room around the mark on every side, in proportion: about 0.6 of the box.
    expect(mark / box).toBeGreaterThan(0.55);
    expect(mark / box).toBeLessThan(0.65);
  });
});
