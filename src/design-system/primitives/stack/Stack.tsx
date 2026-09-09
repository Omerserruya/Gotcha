import type { CSSProperties, ElementType, ReactNode } from 'react';

import styles from './Stack.module.css';

type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface StackProps {
  readonly children: ReactNode;
  /** Maps to the spacing scale. There is no arbitrary gap. */
  readonly gap?: Space;
  readonly align?: CSSProperties['alignItems'];
  readonly justify?: CSSProperties['justifyContent'];
  readonly wrap?: boolean;
  readonly grow?: boolean;
  readonly as?: ElementType;
  readonly className?: string;
}

function useStackStyle({ gap = 0, align, justify }: StackProps): CSSProperties {
  return {
    gap: `var(--space-${gap})`,
    alignItems: align,
    justifyContent: justify,
  };
}

/**
 * Vertical layout. Direction-agnostic by construction: it stacks along the
 * block axis, which is unaffected by RTL.
 */
export function Stack(props: StackProps) {
  const { children, wrap, grow, as: Component = 'div', className } = props;
  return (
    <Component
      className={[
        styles.stack,
        styles.vertical,
        wrap && styles.wrap,
        grow && styles.grow,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={useStackStyle(props)}
    >
      {children}
    </Component>
  );
}

/**
 * Horizontal layout along the *inline* axis.
 *
 * Named `Inline` rather than `Row` because it follows the writing direction:
 * in Hebrew its children run right to left, and no caller has to know that.
 */
export function Inline(props: StackProps) {
  const { children, wrap, grow, as: Component = 'div', className } = props;
  return (
    <Component
      className={[
        styles.stack,
        styles.horizontal,
        wrap && styles.wrap,
        grow && styles.grow,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={useStackStyle(props)}
    >
      {children}
    </Component>
  );
}
