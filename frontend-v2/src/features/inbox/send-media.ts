import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { windowRefusalOf, type WindowRefusal } from './reply-window';

/**
 * Sending a file - 02's image and paperclip.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE UPLOAD IS THE SEND
 * ════════════════════════════════════════════════════════════════════════════
 * `POST …/messages/media` writes the row and enqueues it in the same request;
 * there is no draft on the server. So this runs only from the composer's Send,
 * never from choosing a file - choosing one only holds it in the box.
 *
 * ★ FROM THE BROWSER, THROUGH THE BFF, NOT THROUGH A SERVER ACTION. A server
 *   action's body is capped at 1MB by default, and a photo is bigger than
 *   that. The BFF relays the multipart body as it came.
 *
 * Like `sendReply`, it never says "sent": a 201 means queued.
 */

/**
 * The route's cap - `MAX_FILE_SIZE` in `services/conversation/src/routes/messages.ts`.
 *
 * ⚠⚠ REFUSED HERE BECAUSE THE ROUTE DOES NOT REFUSE IT. busboy's `fileSize`
 *    limit TRUNCATES the stream, and the route then saves and sends what it
 *    received with a 201 - the customer would get a file cut short.
 */
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export type MediaResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'too_large' }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'channel_not_configured' }
  /** 409 - the window closed (Backend 47e376a4). No file was stored and nothing went. */
  | { readonly ok: false; readonly reason: WindowRefusal }
  | { readonly ok: false; readonly reason: 'failed' };

const unchecked = z.unknown();

export async function sendMedia(
  conversationId: string,
  file: File,
  caption: string,
): Promise<MediaResult> {
  if (file.size > MAX_MEDIA_BYTES) return { ok: false, reason: 'too_large' };

  const form = new FormData();
  form.append('file', file, file.name);
  const text = caption.trim();
  if (text !== '') form.append('body', text);

  try {
    await browserApi.post({
      endpoint: inboxEndpoints.sendMedia(conversationId),
      payload: unchecked,
      body: form,
      // An upload, at whatever the connection allows.
      timeoutMs: 120_000,
    });
    return { ok: true };
  } catch (cause) {
    // Never the file name or the caption: both are somebody's content.
    logger.warn('inbox.media_failed', {
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (!isApiError(cause)) return { ok: false, reason: 'failed' };
    if (cause.status === 404) return { ok: false, reason: 'not_found' };
    const refusal = windowRefusalOf(cause);
    if (refusal) return { ok: false, reason: refusal };
    if (
      cause.status === 400 &&
      (cause.developerMessage?.toLowerCase() ?? '').includes('channel not configured')
    ) {
      return { ok: false, reason: 'channel_not_configured' };
    }
    return { ok: false, reason: 'failed' };
  }
}
