import { undeliveredReason, type InboxMessage, type UndeliveredReason } from '@/api/contracts/inbox';

import { mediaKind } from './media';

/**
 * ★★ AN ALBUM IS ANNOUNCED AS "UNSUPPORTED", AND THEN ITS PICTURES ARRIVE.
 *
 * Meta sends a WhatsApp album as `type: "unsupported"` (131051) and then
 * delivers each picture as its own message (prod 2026-11-15 06:29, see
 * undeliverable-message.service.ts). Read alone, the announcement says the
 * message cannot be seen here, above pictures that are right there.
 *
 * So an unsupported message followed within a minute by the customer's
 * media is part of something that did arrive: a soft line
 * (Supervisior, 2026-11-17). Meta's own marker (`raw.unsupported.type:
 * "album"`) counts too, when the pictures are not on this page.
 *
 * ⚠ "All of it arrived" cannot be known: the announcement carries no count,
 *   so the soft line stays rather than guessing it away.
 */
export const ALBUM_WINDOW_MS = 60_000;

export type StreamUndelivered = UndeliveredReason | 'albumPart';

export function streamUndelivered(
  message: InboxMessage,
  messages: readonly InboxMessage[],
): StreamUndelivered | null {
  const reason = undeliveredReason(message);
  if (reason === null || message.direction !== 'INBOUND') return reason;
  if (albumMarked(message)) return 'albumPart';
  // A bad time is NaN, and every comparison below is then false: no album.
  const at = Date.parse(message.createdAt);
  const followed = messages.some((other) => {
    if (other.id === message.id || other.direction !== 'INBOUND') return false;
    const gap = Date.parse(other.createdAt) - at;
    return gap >= 0 && gap <= ALBUM_WINDOW_MS && mediaKind(other) !== null;
  });
  return followed ? 'albumPart' : reason;
}

/** Meta's `raw.unsupported.type` (parsed tolerantly by the contract). */
function albumMarked(message: InboxMessage): boolean {
  return message.metadata?.unsupported?.raw?.unsupported?.type?.trim().toLowerCase() === 'album';
}
