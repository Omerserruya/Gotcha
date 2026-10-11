'use client';

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { channelMark } from '@/design-system/brand/channel-marks';

/**
 * The channel's mark as a desktop notification's icon: the same glyph and
 * tint the inbox draws on a row (`channelMark`), as a PNG.
 *
 * A notification takes an image URL, not an element, and SVG is not an icon
 * every platform's notification centre draws - so the glyph is rendered once,
 * drawn on a disc in the channel's colours (read from the tokens, so dark
 * mode is the tokens' too) and rasterised. A `data:` URL: `img-src` allows
 * it, and nothing is fetched.
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

async function draw(channel: string | null): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  const { Icon, tone } = channelMark(channel);
  const tokens = getComputedStyle(document.documentElement);
  const surface = tokens.getPropertyValue(`--channel-${tone}-surface`).trim();
  const mark = tokens.getPropertyValue(`--channel-${tone}-mark`).trim();
  if (!surface || !mark) return undefined;

  // The glyph's markup, from the same component the inbox renders.
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(<Icon size={48} strokeWidth={2} />));
  const glyph = host.innerHTML;
  root.unmount();
  if (!glyph.startsWith('<svg')) return undefined;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<circle cx="48" cy="48" r="48" fill="${surface}"/>` +
    `<g transform="translate(24 24)" color="${mark}" style="color:${mark}">${glyph}</g>` +
    `</svg>`;

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
