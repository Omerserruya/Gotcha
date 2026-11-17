/**
 * What kind of message a stored body is, when it is not words.
 *
 * The adapters store a filler body for media ("[Image]", "[Voice message]",
 * "[Shared location: …]"), and GET /api/conversations serves the last
 * message's `lastMessageType` (conversation 33e6216a). Every reader that
 * shows a message's line - the inbox list, the reply quote, GO TO, the
 * people list - says it through `quoteOf`, so one kind reads as one word.
 * Here, not in a feature: the shell may not import one.
 */

/** The adapters' own filler bodies. */
export const MESSAGE_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '[Image]',
  '[Video]',
  '[Document]',
  '[Audio message]',
  '[Voice message]',
  '[Sticker]',
  '[Contact]',
]);

/** What a quote or a reply preview calls a message whose body is not words. */
export type QuoteKind =
  | 'photo'
  | 'sticker'
  | 'video'
  | 'voice'
  | 'file'
  | 'location'
  | 'contact'
  /** WhatsApp's "unsupported" (131051 and any other code): it never reached us. */
  | 'undelivered'
  /** The same, 131060: it shows only in the phone's app. Known only where the metadata is. */
  | 'undeliveredPhoneOnly';

/**
 * The adapter's body for Meta's `type: "unsupported"` (whatsapp.adapter.ts
 * `unmodelled`). A list row, a realtime event and a search hit carry only
 * the body, so this is the signal there; the code is read when there is
 * metadata to read it from.
 */
const UNSUPPORTED_BODY = '[unsupported message]';

/** Meta's first error code on an unsupported message, read without trusting the shape. */
function unsupportedCode(metadata: unknown): string | null {
  const u = field(metadata, 'unsupported');
  const first = (list: unknown) => (Array.isArray(list) ? field(list[0], 'code') : undefined);
  const code = first(field(u, 'errors')) ?? first(field(field(u, 'raw'), 'errors'));
  return typeof code === 'number' || typeof code === 'string' ? String(code) : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * A quoted message in words: its own text, or - when the body is only the
 * adapter's filler ("[Image]", "[Shared location: …]") or empty - what kind
 * of message it was. `null`: no text and no kind known.
 */
export function quoteOf(message: {
  readonly body: string;
  readonly messageType?: string | null;
  /** A message's metadata, where the reader has it: only Meta's error code is read. */
  readonly metadata?: unknown;
}): { readonly text: string } | { readonly kind: QuoteKind } | null {
  const body = message.body.trim();
  const type = (message.messageType ?? '').trim().toLowerCase();
  /*
   * ★★ NEVER THE RAW "[unsupported message]" (Supervisior, 2026-11-17): it
   * was a list preview and a notification, in English, in brackets.
   */
  if (body === UNSUPPORTED_BODY || field(field(message.metadata, 'unsupported'), 'providerType') === 'unsupported') {
    return {
      kind: unsupportedCode(message.metadata) === '131060' ? 'undeliveredPhoneOnly' : 'undelivered',
    };
  }
  const filler =
    body === '' || MESSAGE_PLACEHOLDERS.has(body) || /^\[(Shared )?[Ll]ocation\b/.test(body);
  if (!filler) return { text: body };
  if (body === '[Sticker]' || type === 'sticker') return { kind: 'sticker' };
  if (type === 'image' || body === '[Image]') return { kind: 'photo' };
  if (type === 'video' || body === '[Video]') return { kind: 'video' };
  if (type === 'audio' || type === 'voice' || /^\[(Audio|Voice) message\]$/.test(body)) {
    return { kind: 'voice' };
  }
  if (type === 'document' || body === '[Document]') return { kind: 'file' };
  if (type === 'location' || body.startsWith('[')) {
    return /^\[(Shared )?[Ll]ocation\b/.test(body) || type === 'location'
      ? { kind: 'location' }
      : null;
  }
  if (/^contacts?$/.test(type) || body === '[Contact]') return { kind: 'contact' };
  return null;
}
