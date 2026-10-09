import type { ElementType, ReactNode } from 'react';

import styles from './Text.module.css';

/**
 * Typography roles.
 *
 * A component asks for `heading` or `eyebrow`, never for 30px semibold with
 * -0.03em tracking. The scale can then be retuned in one place, and a heading
 * stays a heading.
 *
 * `serif` is a role rather than a font option, because the display serif
 * carries the product's voice and belongs only on the few lines that should.
 */
export type TextRole =
  | 'hero'
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'bodySm'
  | 'label'
  | 'caption'
  | 'meta'
  | 'micro'
  | 'serif'
  | 'serifInline'
  | 'eyebrow';

export type TextTone = 'primary' | 'secondary' | 'body' | 'muted' | 'subtle' | 'inherit';

const TONE_CLASS: Record<TextTone, string | undefined> = {
  primary: undefined,
  secondary: styles.secondary,
  body: styles.toneBody,
  muted: styles.muted,
  subtle: styles.subtle,
  inherit: styles.toneInherit,
};

export interface TextProps {
  readonly children: ReactNode;
  readonly role?: TextRole;
  readonly tone?: TextTone;
  /**
   * The rendered element. Kept separate from `role` on purpose: heading LEVEL
   * is document structure that screen readers navigate by, and visual size is
   * not. A `title`-sized `<h3>` is legitimate and must stay possible.
   */
  readonly as?: ElementType;
  readonly truncate?: boolean;
  /** Tabular figures, for numbers that sit in a column and must align. */
  readonly numeric?: boolean;
  readonly className?: string;
  readonly id?: string;
  readonly lang?: string;
}

export function Text({
  children,
  role = 'bodySm',
  tone = 'primary',
  as: Component = 'p',
  truncate,
  numeric,
  className,
  id,
  lang,
}: TextProps) {
  return (
    <Component
      id={id}
      lang={lang}
      className={[
        styles.text,
        styles[role],
        TONE_CLASS[tone],
        truncate && styles.truncate,
        numeric && styles.numeric,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Component>
  );
}
