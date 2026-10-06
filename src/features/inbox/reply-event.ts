/**
 * "Reply to this one" - from a message in the stream to the composer.
 *
 * ★ An event on `window`, because the two are not in one React tree that
 *   could share state: `MessageStream` is an async server component and the
 *   composer a client one, siblings in the page. The stream's button says
 *   which message; the composer decides what to do with it.
 */
export const REPLY_TO_EVENT = 'gotcha:reply-to';

export interface ReplyTarget {
  readonly id: string;
  /** Who said it - "Customer", the AI employee's name, or "Your team". */
  readonly who: string;
  /** One line of it, as the quote block will show it. */
  readonly preview: string;
}

export function replyTo(target: ReplyTarget): void {
  window.dispatchEvent(new CustomEvent<ReplyTarget>(REPLY_TO_EVENT, { detail: target }));
}

/**
 * The Copilot wall → the composer: put this text in the reply box. "Use
 * this", "Edit" and "Ask Copilot" all land here; nothing is ever sent by it.
 */
export const FILL_COMPOSER_EVENT = 'gotcha:fill-composer';

export interface ComposerFill {
  readonly text: string;
  /** Edit: the text selected, to be changed. Otherwise the caret at its end. */
  readonly select?: boolean;
}

export function fillComposer(text: string, { select = false }: { select?: boolean } = {}): void {
  window.dispatchEvent(
    new CustomEvent<ComposerFill>(FILL_COMPOSER_EVENT, { detail: { text, select } }),
  );
}
