import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { CHANNEL_TYPES } from '@/api/contracts/channels';
import { channelName } from '@/api/contracts/inbox';
import channels from '@/i18n/messages/en/channels.json';

import { ChannelMark, channelMark } from './channel-marks';

/**
 * The channels' official marks (Omer, 2026-10-11): one component, every
 * channel the platform models, each with a name a screen reader can say.
 *
 * ⚠ ENUMERATES `CHANNEL_TYPES`, NOT THE MARK TABLE. A test that walks the
 *   table cannot see a channel missing from it; this one walks the platform's
 *   own list and asks the table for each.
 */

const names = createTranslator({ locale: 'en', messages: { channels }, namespace: 'channels' });

/* Which drawing each channel must get - the design file it was copied from. */
const EXPECTED: Record<(typeof CHANNEL_TYPES)[number], string> = {
  WHATSAPP: 'whatsapp',
  MESSENGER: 'messenger',
  INSTAGRAM: 'instagram',
  EMAIL: 'mail',
  GMAIL: 'gmail',
  OUTLOOK: 'outlook',
  SLACK: 'slack',
  VOICE: 'phone',
  WEBCHAT: 'globe',
  SHOPIFY_LIVE_CHAT: 'shopify',
};

const BRANDS = [
  'WHATSAPP',
  'MESSENGER',
  'INSTAGRAM',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
  'SHOPIFY_LIVE_CHAT',
];

describe('★★ every channel the platform models gets its own mark, named', () => {
  it.each(CHANNEL_TYPES)('%s: its own drawing, with an accessible name', (channel) => {
    const label = channelName(channel, names)!;
    render(<ChannelMark channel={channel} label={label} />);
    const mark = screen.getByRole('img', { name: label });
    expect(label).not.toBe(names('name.other'));
    expect(mark).toHaveAttribute('data-glyph', EXPECTED[channel]);
    expect(mark).toHaveAttribute('data-channel-mark');
  });

  it('★ no two channels share a drawing', () => {
    const { container } = render(
      <>
        {CHANNEL_TYPES.map((c) => (
          <ChannelMark key={c} channel={c} label={c} />
        ))}
      </>,
    );
    const drawn = [...container.querySelectorAll('svg')].map((svg) => svg.innerHTML);
    expect(drawn).toHaveLength(CHANNEL_TYPES.length);
    expect(new Set(drawn).size).toBe(CHANNEL_TYPES.length);
  });

  it.each(BRANDS)('%s wears the brand’s own colours, not currentColor', (channel) => {
    const { container } = render(<ChannelMark channel={channel} label={channel} />);
    const svg = container.querySelector('svg')!;
    const fills = [svg, ...svg.querySelectorAll('[fill]')]
      .map((el) => el.getAttribute('fill'))
      .filter((f): f is string => !!f && f.startsWith('#'));
    expect(fills.length).toBeGreaterThan(0);
    expect(svg).not.toHaveAttribute('stroke', 'currentColor');
  });

  it.each(['EMAIL', 'VOICE', 'WEBCHAT'])(
    '%s has no brand: a neutral glyph in currentColor',
    (c) => {
      const { container } = render(<ChannelMark channel={c} label={c} />);
      const svg = container.querySelector('svg')!;
      expect(svg).toHaveAttribute('stroke', 'currentColor');
      expect(svg).toHaveAttribute('fill', 'none');
    },
  );
});

describe('⚠⚠ an unknown channel gets a neutral fallback, never nothing', () => {
  it.each([['SOMETHING_NEW'], [null], ['constructor'], ['']])('%s → the fallback, named', (c) => {
    const label = channelName(c, names) ?? names('name.other');
    render(<ChannelMark channel={c} label={label} />);
    const mark = screen.getByRole('img', { name: 'Another channel' });
    expect(mark).toHaveAttribute('data-glyph', 'unknown');
    expect(mark.innerHTML).not.toBe('');
  });

  it('★ the fallback is none of the real channels’ drawings', () => {
    const { container } = render(
      <>
        <ChannelMark channel="SOMETHING_NEW" label="x" />
        {CHANNEL_TYPES.map((c) => (
          <ChannelMark key={c} channel={c} label={c} />
        ))}
      </>,
    );
    const [unknown, ...known] = [...container.querySelectorAll('svg')].map((s) => s.innerHTML);
    expect(known).not.toContain(unknown);
  });
});

describe('decorative - only where the name is written beside it', () => {
  it('is hidden from a screen reader and has no name of its own', () => {
    const { container } = render(<ChannelMark channel="WHATSAPP" decorative />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('aria-label');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('★ the other screens’ `channelMark().Icon` IS the shared mark', () => {
    const { Icon } = channelMark('SLACK');
    const { container } = render(<Icon size={12} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('data-channel-mark');
    expect(svg).toHaveAttribute('data-glyph', 'slack');
    expect(svg).toHaveAttribute('width', '12');
    // One component per channel, kept: a new type each render would remount.
    expect(channelMark('SLACK').Icon).toBe(Icon);
  });
});
