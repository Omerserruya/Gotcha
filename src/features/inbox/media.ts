import type { InboxMessage } from '@/api/contracts/inbox';

/**
 * What a message's attachment is, as the stream draws it — and the two
 * guards that keep it honest: a media address is followed only over https
 * or on this host, and a caption the adapter wrote for us ("[Image]") is
 * never printed as if the customer typed it.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'sticker' | 'document';

/** https, or a path on this host (`/api/uploads/…`); anything else — `javascript:`, `//evil` — is no address. */
export function safeMediaUrl(raw: string | null): string | null {
  const url = raw?.trim();
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')) return url;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function mediaKind(
  message: Pick<InboxMessage, 'messageType' | 'mediaUrl'>,
): MediaKind | null {
  const type = message.messageType.trim().toLowerCase();
  const url = message.mediaUrl ?? '';
  // messageType is authoritative; the extension only for rows written before it.
  if (type === 'sticker') return 'sticker';
  if (type === 'image' || /\.(jpe?g|png|gif|webp|bmp)$/i.test(url)) return 'image';
  if (type === 'video' || /\.(mp4|webm|mov|m4v)$/i.test(url)) return 'video';
  if (type === 'audio' || type === 'voice' || /\.(ogg|oga|mp3|m4a|aac|wav|opus)$/i.test(url)) {
    return 'audio';
  }
  if (type === 'document' || url !== '') return 'document';
  return null;
}

const PLACEHOLDERS = new Set([
  '[Image]',
  '[Video]',
  '[Document]',
  '[Audio message]',
  '[Voice message]',
  '[Sticker]',
  '[Contact]',
]);

/** The adapter's own filler, or the file's name repeated: not printed under the media. */
export function isPlaceholderCaption(
  message: Pick<InboxMessage, 'body' | 'fileName' | 'mediaUrl' | 'messageType' | 'metadata'>,
): boolean {
  const body = message.body.trim();
  if (message.messageType === 'contact' && message.metadata?.contacts?.length) return true;
  if (!message.mediaUrl && !message.metadata?.mediaError) return false;
  return PLACEHOLDERS.has(body) || (!!message.fileName && body === message.fileName);
}
