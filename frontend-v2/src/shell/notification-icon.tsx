'use client';

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { ChannelMark, channelTone } from '@/design-system/brand/channel-marks';

/**
 * The channel's mark as a desktop notification's icon: the same brand mark
 * the inbox draws on a row (`ChannelMark`), as a PNG.
 *
 * A notification takes an image URL, not an element, and SVG is not an icon
 * every platform's notification centre draws - so the mark is rendered once,
 * drawn on a disc of `--channel-mark-plate` and rasterised. The plate is what
 * keeps a brand's colours legible in a dark notification centre (Outlook's
 * navy layer vanishes on dark without it); a neutral glyph is inked in its
 * tone's `--channel-*-mark`. Both read from the tokens. A `data:` URL:
 * `img-src` allows it, and nothing is fetched.
 *
 * `undefined` when any step is unavailable (no canvas, a token missing): the
 * notification then shows without an icon, never with a wrong one.
 */
const SIZE = 96;
const cache = new Map<string, Promise<string | undefined>>();

export function channelIconUrl(channel: string | null): Promise<string | undefined> {
  const key = channel ?? '';
  let found = cache.get(key);
  if (!found) {
    found = draw(channel).catch(() => undefined);
    cache.set(key, found);
  }
  return found;
}

/**
 * The icon's SVG: the plate, and the channel's mark centred on it at half
 * its size. `undefined` when the mark did not render as an `<svg>`.
 */
export function notificationSvg(
  channel: string | null,
  colours: { readonly plate: string; readonly ink: string },
): string | undefined {
  // The mark's markup, from the same component the inbox renders.
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(<ChannelMark channel={channel} size={48} decorative />));
  const glyph = host.innerHTML;
  root.unmount();
  if (!glyph.startsWith('<svg')) return undefined;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<circle cx="48" cy="48" r="48" fill="${colours.plate}"/>` +
    `<g transform="translate(24 24)" color="${colours.ink}" style="color:${colours.ink}">${glyph}</g>` +
    `</svg>`
  );
}

async function draw(channel: string | null): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  const tokens = getComputedStyle(document.documentElement);
  const plate = tokens.getPropertyValue('--channel-mark-plate').trim();
  const ink = tokens.getPropertyValue(`--channel-${channelTone(channel)}-mark`).trim();
  if (!plate || !ink) return undefined;

  const svg = notificationSvg(channel, { plate, ink });
  if (!svg) return undefined;

  const image = new Image();
  image.decoding = 'async';
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(image, 0, 0, SIZE, SIZE);
  return canvas.toDataURL('image/png');
}
