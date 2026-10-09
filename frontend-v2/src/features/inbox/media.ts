import type { InboxMessage } from '@/api/contracts/inbox';

/**
 * What a message's attachment is, as the stream draws it - and the two
 * guards that keep it honest: a media address is followed only over https
 * or on this host, and a caption the adapter wrote for us ("[Image]") is
 * never printed as if the customer typed it.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'sticker' | 'document';

/** https, or a path on this host (`/api/uploads/…`); anything else - `javascript:`, `//evil` - is no address. */
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

/** A shared location, as the card draws it. */
export interface SharedLocation {
  readonly latitude: number;
  readonly longitude: number;
  /** The place's name, then its address - each only when the provider sent one. */
  readonly name: string | null;
  readonly address: string | null;
  /** Where "Open in map" goes: the provider's https link, else Google Maps at the point. */
  readonly mapUrl: string;
}

const COORD = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
/** The old body: `[Location: 32.0853, 34.7818]`. */
const OLD_BODY = new RegExp(String.raw`^\[Location:\s*${COORD},\s*${COORD}\]$`);
/** Today's body, for the AI: `[Shared location: <name>, <address> (lat, lng)]`. */
const SHARED_BODY = new RegExp(
  String.raw`^\[Shared location(?::\s*(.*?))?\s*\(${COORD},\s*${COORD}\)\]$`,
);

const onEarth = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

const mapAt = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

/**
 * A message's shared location: from `metadata.location` (Backend 11094abb),
 * else read off the body a row was written with before it - never the
 * bracket text itself. `null` when there is no point to show.
 */
export function messageLocation(
  message: Pick<InboxMessage, 'body' | 'metadata'>,
): SharedLocation | null {
  const stored = message.metadata?.location;
  if (stored && onEarth(stored.latitude, stored.longitude)) {
    const url = stored.url?.trim();
    let https = false;
    try {
      https = !!url && new URL(url).protocol === 'https:';
    } catch {
      https = false;
    }
    return {
      latitude: stored.latitude,
      longitude: stored.longitude,
      name: stored.name?.trim() || null,
      address: stored.address?.trim() || null,
      mapUrl: https ? url! : mapAt(stored.latitude, stored.longitude),
    };
  }
  const body = message.body.trim();
  const old = OLD_BODY.exec(body);
  if (old) {
    const [lat, lng] = [Number(old[1]), Number(old[2])];
    return onEarth(lat, lng)
      ? { latitude: lat, longitude: lng, name: null, address: null, mapUrl: mapAt(lat, lng) }
      : null;
  }
  const shared = SHARED_BODY.exec(body);
  if (shared) {
    const [lat, lng] = [Number(shared[2]), Number(shared[3])];
    // "<name>, <address>" is one string here; it is shown as the place, whole.
    return onEarth(lat, lng)
      ? {
          latitude: lat,
          longitude: lng,
          name: shared[1]?.trim() || null,
          address: null,
          mapUrl: mapAt(lat, lng),
        }
      : null;
  }
  return null;
}

/** A location message: by its type, or by a body only a location has. */
export function isLocationMessage(
  message: Pick<InboxMessage, 'body' | 'messageType' | 'metadata'>,
): boolean {
  return (
    message.messageType.trim().toLowerCase() === 'location' ||
    messageLocation(message) !== null ||
    /^\[(Shared )?[Ll]ocation\b/.test(message.body.trim())
  );
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
  // WhatsApp writes `contacts`; some adapters `contact`.
  if (
    /^contacts?$/.test(message.messageType.trim().toLowerCase()) &&
    message.metadata?.contacts?.length
  ) {
    return true;
  }
  // A location's body is written for the AI ("[Shared location: …]"): the card says it.
  if (isLocationMessage(message)) return true;
  if (!message.mediaUrl && !message.metadata?.mediaError) return false;
  return PLACEHOLDERS.has(body) || (!!message.fileName && body === message.fileName);
}
