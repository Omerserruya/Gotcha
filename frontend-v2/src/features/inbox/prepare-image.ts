import { logger } from '@/observability/logger';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ AN IMAGE META WILL TAKE (prod, 2026-11-15)
 * ════════════════════════════════════════════════════════════════════════════
 * Omer's iPhone screenshot (IMG_4538.png, 459 KB) went FAILED on WhatsApp:
 * Meta 131053, "supported are JPG/JPEG, RGB/RGBA 8 bit/channel PNG, static
 * WebP". An iPhone PNG is often 16-bit or Display P3. The same picture sent
 * as a JPEG was delivered. So before upload, an image that is not a plain
 * JPEG is drawn through a canvas, in sRGB, and sent as a JPEG.
 *
 * ★ ONLY META'S CHANNELS (WhatsApp, Instagram, Messenger), which share the
 *   media rules. Email and the web chat send the file as chosen: a logo's
 *   transparency, or a PNG the customer asked for, is not ours to change.
 *
 * ★ ANY FAILURE SENDS THE ORIGINAL - what was sent before this existed. A
 *   browser that cannot decode HEIC (Chrome) is the common case.
 */

/** The channels whose image rules are Meta's. */
export const META_IMAGE_CHANNELS: ReadonlySet<string> = new Set([
  'WHATSAPP',
  'INSTAGRAM',
  'MESSENGER',
]);

/** The long side, at most - WhatsApp's own resize keeps a phone photo under it. */
export const MAX_IMAGE_SIDE = 2560;
/** JPEG quality: no visible loss on a screenshot's text. */
export const JPEG_QUALITY = 0.9;

/** How many leading bytes the decision reads: a WebP's VP8X flags sit at 20. */
export const HEADER_BYTES = 32;

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/**
 * A WebP with no animation: a simple `VP8 ` / `VP8L` file, or `VP8X` with
 * the animation flag (bit 1 of byte 20) clear. Anything unreadable is not
 * known to be static.
 */
export function isStaticWebp(header: Uint8Array): boolean {
  if (header.length < 21 || ascii(header, 0, 4) !== 'RIFF' || ascii(header, 8, 12) !== 'WEBP') {
    return false;
  }
  const chunk = ascii(header, 12, 16);
  if (chunk === 'VP8 ' || chunk === 'VP8L') return true;
  if (chunk === 'VP8X') return (header[20]! & 0x02) === 0;
  return false;
}

/** A JPEG by its bytes (FF D8 FF), whatever the type claims. */
export function isJpeg(header: Uint8Array): boolean {
  return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

export type ImagePlan = 'send-as-is' | 'reencode';

/**
 * What to do with one chosen file before it goes to `channel`.
 *
 *   not Meta's channel, or not an image     as chosen
 *   a JPEG (by its bytes)                   as chosen - Meta takes any
 *   a static WebP                           as chosen
 *   anything else that says image/*         re-encoded: PNG (bit depth and
 *                                           colour space unknown), HEIC,
 *                                           HEIF, GIF (Meta takes none),
 *                                           an animated or unreadable WebP
 */
export function imagePlan(
  file: { readonly type: string },
  header: Uint8Array,
  channel: string | null,
): ImagePlan {
  if (channel === null || !META_IMAGE_CHANNELS.has(channel)) return 'send-as-is';
  const type = file.type.toLowerCase();
  if (!type.startsWith('image/')) return 'send-as-is';
  if (isJpeg(header)) return 'send-as-is';
  if (type === 'image/webp' && isStaticWebp(header)) return 'send-as-is';
  return 'reencode';
}

/** The size that keeps the long side at most `max`, never enlarging. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** `IMG_4538.png` → `IMG_4538.jpg`; a name with no extension gains one. */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'image'}.jpg`;
}

/**
 * The file to upload: `file` itself, or its sRGB JPEG re-encoding. Never
 * rejects - a failure to decode or encode sends `file`.
 */
export async function prepareImage(file: File, channel: string | null): Promise<File> {
  try {
    const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
    if (imagePlan(file, header, channel) === 'send-as-is') return file;

    // Decoded into sRGB: a Display P3 or 16-bit source comes out 8-bit sRGB.
    const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'default' });
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!context) throw new Error('no 2d context');
    // A JPEG has no alpha: a transparent screenshot's background is white, never black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) throw new Error('jpeg encode returned nothing');
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch (cause) {
    // The type only: a file's name can be a person's.
    logger.warn('inbox.image_reencode_failed', { type: file.type, cause });
    return file;
  }
}
