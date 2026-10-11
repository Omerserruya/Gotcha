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

/* Which drawing each channel must get. */
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
    // A literal colour, or a gradient of literal colours.
    expect(coloursOf(svg).length).toBeGreaterThan(0);
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

/** Every colour a mark paints with: its fills and its gradients' stops, lower-cased. */
function coloursOf(svg: Element): string[] {
  return [svg, ...svg.querySelectorAll('[fill], stop')]
    .flatMap((el) => [el.getAttribute('fill'), el.getAttribute('stop-color')])
    .filter((c): c is string => !!c && c.startsWith('#'))
    .map((c) => c.toLowerCase());
}

/** Every `url(#…)` a mark paints through. */
function referencesOf(svg: Element): string[] {
  return [...svg.querySelectorAll('[fill]')]
    .map((el) => /^url\(#(.+)\)$/.exec(el.getAttribute('fill')!)?.[1])
    .filter((id): id is string => !!id);
}

function drawn(channel: string): SVGSVGElement {
  const { container } = render(<ChannelMark channel={channel} label={channel} />);
  return container.querySelector('svg')!;
}

/*
 * ★★ THE BRANDS' OWN CURRENT FILES (Omer, 2026-10-11), each pinned by what
 *   tells it from the copy it replaced. The file each came from is named in
 *   `design-system/brand/channel-marks.tsx`.
 */
describe('★★ each brand mark is the brand’s current official one', () => {
  it('Gmail: Google’s 2026 M - red, yellow, green and blue, not one red M', () => {
    const colours = coloursOf(drawn('GMAIL'));
    for (const c of ['#fc413d', '#ffdb0f', '#0ebc5f', '#3186ff']) expect(colours).toContain(c);
    expect(colours).not.toContain('#ea4335');
  });

  it('Instagram: Meta’s glyph in a gradient - violet corner, yellow base - not flat #E4405F', () => {
    const svg = drawn('INSTAGRAM');
    const fills = [...svg.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(f).toMatch(/^url\(#.+\)$/);
    const colours = coloursOf(svg);
    expect(colours).toEqual(expect.arrayContaining(['#6520f5', '#f8d447', '#ea3768']));
    expect(colours).not.toContain('#e4405f');
  });

  it('Messenger: Meta’s February 2025 icon - Facebook Blue with a white bolt, not #0084FF', () => {
    const colours = coloursOf(drawn('MESSENGER'));
    expect(colours).toEqual(expect.arrayContaining(['#0866ff', '#fff']));
    expect(colours).not.toContain('#0084ff');
  });

  it('Shopify: the two-green bag with its white S, not a flat #7AB55C', () => {
    const colours = coloursOf(drawn('SHOPIFY_LIVE_CHAT'));
    expect(colours).toEqual(expect.arrayContaining(['#95bf47', '#5e8e3e', '#ffffff']));
    expect(colours).not.toContain('#7ab55c');
  });

  it('Slack: the current four colours, not the pre-2026 ones', () => {
    const colours = coloursOf(drawn('SLACK'));
    expect(colours).toEqual(expect.arrayContaining(['#e3066a', '#00b3ff', '#41b658', '#fcc003']));
    for (const old of ['#e01e5a', '#36c5f0', '#2eb67d', '#ecb22e'])
      expect(colours).not.toContain(old);
  });

  it('WhatsApp: the glyph in WhatsApp green', () => {
    expect(coloursOf(drawn('WHATSAPP'))).toEqual(['#25d366']);
  });

  it('Outlook: Microsoft’s FY26 icon - gradients and a white O, not the flat hand-drawn one', () => {
    const svg = drawn('OUTLOOK');
    expect(svg.querySelectorAll('linearGradient, radialGradient').length).toBeGreaterThanOrEqual(
      10,
    );
    const colours = coloursOf(svg);
    expect(colours).toEqual(expect.arrayContaining(['#20a7fa', '#183dad']));
    expect(svg.querySelectorAll('[fill="white"]').length).toBeGreaterThan(0);
    expect(colours).not.toContain('#0364b8');
  });
});

describe('⚠⚠ a gradient is the mark’s own - per instance, inside its own <svg>', () => {
  const GRADIENT = ['GMAIL', 'INSTAGRAM', 'OUTLOOK'];

  it.each(GRADIENT)('%s: every url(#…) it paints through is defined inside that same svg', (c) => {
    const svg = drawn(c);
    const refs = referencesOf(svg);
    expect(refs.length).toBeGreaterThan(0);
    for (const id of refs) {
      const target = [...svg.querySelectorAll('[id]')].find((el) => el.id === id);
      expect(target?.tagName).toMatch(/^(linear|radial)Gradient$/);
    }
  });

  it.each(GRADIENT)('%s: two marks on one page share no id', (c) => {
    const { container } = render(
      <>
        <ChannelMark channel={c} label="a" />
        <ChannelMark channel={c} label="b" />
      </>,
    );
    const marks = [...container.querySelectorAll('svg')];
    expect(marks).toHaveLength(2);
    const [a, b] = marks as [SVGSVGElement, SVGSVGElement];
    const idsA = [...a.querySelectorAll('[id]')].map((el) => el.id);
    const idsB = [...b.querySelectorAll('[id]')].map((el) => el.id);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB).toHaveLength(idsA.length);
    for (const id of idsB) expect(idsA).not.toContain(id);
    // And each paints through its own, not the other's.
    for (const id of referencesOf(b)) expect(idsB).toContain(id);
  });

  it.each(BRANDS)('%s: no CSS variable or stylesheet - it must render as a data: image', (c) => {
    const html = drawn(c).outerHTML;
    expect(html).not.toContain('var(');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('class=');
  });
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
