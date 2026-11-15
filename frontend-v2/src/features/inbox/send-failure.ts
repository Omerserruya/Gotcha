/**
 * Why a message did not send, in the stream's words - from
 * `metadata.sendError` (`ProviderSendError`: `{ channel, phase, code, type, … }`,
 * written by the outgoing worker at send and by the status webhook later).
 *
 *   type TEMPLATE_REQUIRED / REPLY_WINDOW_CLOSED   the 24 hours (Backend 47e376a4)
 *   WhatsApp code 131053                           Meta refused the media's format:
 *                                                  an image, or another file
 *   anything else                                  "did not send" - never Meta's English
 *
 * ★ 131053 ONLY ON WHATSAPP. The code is Cloud API's; Instagram and Messenger
 *   number their Graph errors differently, and a guessed reason is worse than none.
 */
export type SendFailure =
  | 'failedTemplateRequired'
  | 'failedWindowClosed'
  | 'failedImageFormat'
  | 'failedMediaFormat'
  | 'failed';

/** Meta's "media upload error": the file's format is not one WhatsApp takes. */
export const WHATSAPP_MEDIA_FORMAT = 131053;

export function sendFailure(message: {
  readonly messageType?: string | null;
  readonly metadata?: {
    readonly sendError?: {
      readonly type?: string;
      readonly code?: number;
      readonly channel?: string;
    };
    readonly media?: { readonly mimeType?: string | null };
  } | null;
}): SendFailure {
  const error = message.metadata?.sendError;
  if (error?.type === 'TEMPLATE_REQUIRED') return 'failedTemplateRequired';
  if (error?.type === 'REPLY_WINDOW_CLOSED') return 'failedWindowClosed';
  if (error?.channel === 'WHATSAPP' && error.code === WHATSAPP_MEDIA_FORMAT) {
    const image =
      message.messageType === 'image' ||
      (message.metadata?.media?.mimeType ?? '').toLowerCase().startsWith('image/');
    return image ? 'failedImageFormat' : 'failedMediaFormat';
  }
  return 'failed';
}
