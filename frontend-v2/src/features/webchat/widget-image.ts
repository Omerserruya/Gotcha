import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * ★★ W3/W4 (Omer, 2026-10-14; conversation 7f9e204f): the widget's logo and
 * cover, uploaded or given by a link (a Google Drive share link too), checked
 * from the bytes and re-hosted by the platform. Each slot has its limits,
 * the layout's: said on the uploader, checked here first, and by the server
 * again - every refusal in words.
 */
export const IMAGE_SLOTS = {
  logo: { maxBytes: 1_000_000, maxWidth: 1024, maxHeight: 1024 },
  cover: { maxBytes: 3_000_000, maxWidth: 2400, maxHeight: 1600 },
} as const;
export type ImageSlot = keyof typeof IMAGE_SLOTS;

/** What the route takes - never SVG. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageProblem =
  | { readonly reason: 'not_image' | 'url_invalid' | 'not_image_link' | 'fetch_failed' }
  | { readonly reason: 'too_large'; readonly maxBytes: number }
  | {
      readonly reason: 'too_big';
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly width: number | null;
      readonly height: number | null;
    }
  | { readonly reason: 'forbidden' | 'failed' };

export type ImageUpload =
  { readonly ok: true; readonly url: string } | ({ readonly ok: false } & ImageProblem);

const uploadedSchema = z.object({ url: z.string().min(1) });

/** The file's own pixel size, where the browser can read it; `null` when it cannot. */
async function sizeOf(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** Why a file cannot be this slot's, before anything is sent - or `null`. */
export async function fileProblem(slot: ImageSlot, file: File): Promise<ImageProblem | null> {
  const limits = IMAGE_SLOTS[slot];
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return { reason: 'not_image' };
  if (file.size > limits.maxBytes) return { reason: 'too_large', maxBytes: limits.maxBytes };
  const size = await sizeOf(file);
  if (size && (size.width > limits.maxWidth || size.height > limits.maxHeight)) {
    return { reason: 'too_big', maxWidth: limits.maxWidth, maxHeight: limits.maxHeight, ...size };
  }
  return null;
}

export async function uploadWidgetImage(
  slot: ImageSlot,
  source: File | string,
): Promise<ImageUpload> {
  const limits = IMAGE_SLOTS[slot];
  if (typeof source === 'string') {
    try {
      if (new URL(source.trim()).protocol !== 'https:') return { ok: false, reason: 'url_invalid' };
    } catch {
      return { ok: false, reason: 'url_invalid' };
    }
  } else {
    const problem = await fileProblem(slot, source);
    if (problem) return { ok: false, ...problem };
  }
  let body: FormData | { slot: ImageSlot; url: string };
  if (typeof source === 'string') body = { slot, url: source.trim() };
  else {
    body = new FormData();
    body.append('slot', slot);
    body.append('file', source, source.name);
  }
  try {
    const answer = await browserApi.post({
      endpoint: channelEndpoints.widgetImage(),
      payload: uploadedSchema,
      body,
      timeoutMs: 60_000,
    });
    return { ok: true, url: answer.url };
  } catch (cause) {
    logger.warn('website_widget.image_failed', {
      slot,
      status: isApiError(cause) ? cause.status : undefined,
      code: isApiError(cause) ? cause.code : undefined,
    });
    if (!isApiError(cause)) return { ok: false, reason: 'failed' };
    if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    switch (cause.code) {
      case 'IMAGE_TOO_LARGE':
        return { ok: false, reason: 'too_large', maxBytes: cause.maxBytes ?? limits.maxBytes };
      case 'IMAGE_DIMENSIONS_TOO_LARGE':
        return {
          ok: false,
          reason: 'too_big',
          maxWidth: cause.maxWidth ?? limits.maxWidth,
          maxHeight: cause.maxHeight ?? limits.maxHeight,
          width: cause.width ?? null,
          height: cause.height ?? null,
        };
      case 'NOT_AN_IMAGE':
        return { ok: false, reason: typeof source === 'string' ? 'not_image_link' : 'not_image' };
      case 'URL_INVALID':
        return { ok: false, reason: 'url_invalid' };
      case 'FETCH_FAILED':
        return { ok: false, reason: 'fetch_failed' };
      default:
        return { ok: false, reason: 'failed' };
    }
  }
}
