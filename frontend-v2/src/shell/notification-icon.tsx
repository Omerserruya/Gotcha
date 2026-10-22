'use client';

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { ChannelMark } from '@/design-system/brand/channel-marks';
import { PLATE_GEOMETRY } from '@/design-system/brand/channel-plate';

/**
 * The channel's mark as a desktop notification's icon: the same brand mark
 * on the same plate every screen draws (`ChannelPlate`), as a PNG.
 *
 * A notification takes an image URL, not an element, and SVG is not an icon
 * every platform's notification centre draws - so the mark is rendered once,
 * drawn on the plate and rasterised. No stylesheet reaches a `data:` image,
 * so the plate is drawn here from the same numbers (`PLATE_GEOMETRY.xxl`,
 * scaled) and the same tokens: `--channel-mark-plate`, a `--border-subtle`
 * hairline, and `--channel-web-mark` for a neutral glyph's ink. The plate is
 * what keeps a brand's colours legible in a dark notification centre
 * (Outlook's navy layer vanishes on dark without it). A `data:` URL:
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

/** The plate's proportions, from the largest preset, scaled to the icon. */
const PLATE = PLATE_GEOMETRY.xxl;
const SCALE = SIZE / PLATE.box;
const MARK = Math.round(PLATE.mark * SCALE);
const OFFSET = (SIZE - MARK) / 2;
/* The plate's hairline is `--border-width-thin`, 1px on the plate's box. */
const HAIRLINE = SCALE;
/** A coordinate as the markup writes it: `25.2`, never `25.200000000000003`. */
const px = (value: number) => Number(value.toFixed(2));

/**
 * The icon's SVG: the plate - its white, its hairline, its radius - and the
 * channel's mark centred on it at the plate's proportion. `undefined` when
 * the mark did not render as an `<svg>`.
 */
export function notificationSvg(
  channel: string | null,
  colours: { readonly plate: string; readonly edge: string; readonly ink: string },
): string | undefined {
  // The mark's markup, from the same component the inbox renders.
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(<ChannelMark channel={channel} size={MARK} decorative />));
  const glyph = host.innerHTML;
  root.unmount();
  if (!glyph.startsWith('<svg')) return undefined;

  // The stroke is centred on the edge: inset by half of it, so all of it shows.
  const inset = px(HAIRLINE / 2);
  const side = px(SIZE - HAIRLINE);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${px(PLATE.radius * SCALE - HAIRLINE / 2)}" ` +
    `fill="${colours.plate}" stroke="${colours.edge}" stroke-width="${px(HAIRLINE)}"/>` +
    `<g transform="translate(${px(OFFSET)} ${px(OFFSET)})" color="${colours.ink}" style="color:${colours.ink}">${glyph}</g>` +
    `</svg>`
  );
}

async function draw(channel: string | null): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  const tokens = getComputedStyle(document.documentElement);
  const plate = tokens.getPropertyValue('--channel-mark-plate').trim();
  const edge = tokens.getPropertyValue('--border-subtle').trim();
  const ink = tokens.getPropertyValue('--channel-web-mark').trim();
  if (!plate || !edge || !ink) return undefined;

  const svg = notificationSvg(channel, { plate, edge, ink });
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
