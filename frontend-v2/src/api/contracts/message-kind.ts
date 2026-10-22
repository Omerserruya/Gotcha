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
export type QuoteKind = 'photo' | 'sticker' | 'video' | 'voice' | 'file' | 'location' | 'contact';

/**
 * A quoted message in words: its own text, or - when the body is only the
 * adapter's filler ("[Image]", "[Shared location: …]") or empty - what kind
 * of message it was. `null`: no text and no kind known.
 */
export function quoteOf(message: {
  readonly body: string;
  readonly messageType?: string | null;
}): { readonly text: string } | { readonly kind: QuoteKind } | null {
  const body = message.body.trim();
  const type = (message.messageType ?? '').trim().toLowerCase();
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
