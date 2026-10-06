import type { ReactNode } from 'react';

/**
 * Text somebody typed, isolated from the direction of the page around it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ HEBREW INSIDE AN ENGLISH SCREEN REORDERS WITHOUT THIS
 * ════════════════════════════════════════════════════════════════════════════
 * A browser walk found *"What you sell"* on Settings · Workspace holding Hebrew
 * with embedded Latin: the sentence started in Hebrew, jumped to English, and
 * the closing parenthesis landed on the wrong side. **It is not the data.**
 *
 * The page sets `dir` on `<html>` from the URL's locale, and every element
 * inherits it. The Unicode bidirectional algorithm then resolves the runs
 * inside a right-to-left string against a left-to-right paragraph, and
 * neutral characters - brackets, punctuation, digits - attach to the wrong
 * side. The text is stored correctly and rendered wrongly.
 *
 * `<bdi>` is the element for exactly this: **bi-directional isolate**. It
 * resolves its content's direction on its own and prevents it from
 * reordering the text around it. `dir="auto"` is explicit rather than relied
 * upon, because `<bdi>`'s implicit auto direction is easy to lose to a CSS
 * reset or a wrapping component.
 *
 * ── WHY A COMPONENT AND NOT A FIX AT THAT FIELD ──
 * Because this appears **anywhere a Hebrew value lands on an English screen**,
 * and the product is bilingual by design: a customer's name, a note, a message
 * body, a product description, a model-written topic label. Fixing the field
 * the walk happened to find would leave the rest, and the next one would be
 * found the same way - in a browser, by somebody reading a sentence that made
 * no sense.
 *
 * ── AND IT IS FOR USER CONTENT ONLY ──
 * Our own copy comes from the message catalogue in the page's language and
 * needs no isolation. Wrapping it would be harmless and misleading: the point
 * of this element is to mark a value as *not ours*, so a reader of the code
 * knows the direction is the data's business rather than the layout's.
 */
export function UserText({
  children,
  className,
  'data-testid': testId,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}) {
  return (
    <bdi dir="auto" className={className} data-testid={testId}>
      {children}
    </bdi>
  );
}
