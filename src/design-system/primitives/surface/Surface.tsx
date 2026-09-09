import type { ElementType, ReactNode } from 'react';

import styles from './Surface.module.css';

/**
 * The design's surface tones, as a closed set.
 *
 *   `card`   - white, bordered. The most forward surface.
 *   `well`   - a warm recess, for grouped but passive content.
 *   `inset`  - a quieter step up from the ground, bordered.
 *
 * There is no `raised`, because there are no shadows to raise anything with.
 */
export type SurfaceTone = 'card' | 'well' | 'inset';

export function Surface({
  tone = 'card',
  flush,
  as: Component = 'div',
  className,
  children,
}: {
  tone?: SurfaceTone;
  /** Removes the padding, for a surface whose child manages its own. */
  flush?: boolean;
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Component
      className={[styles[tone], flush && styles.flush, className].filter(Boolean).join(' ')}
    >
      {children}
    </Component>
  );
}

/**
 * The hairline rule.
 *
 * `<hr>` rather than a styled div: it is a thematic break, and a screen reader
 * announces it as one. `subtle` is the quieter of the design's two weights.
 */
export function Divider({ subtle }: { subtle?: boolean }) {
  return (
    <hr className={[styles.divider, subtle && styles.dividerSubtle].filter(Boolean).join(' ')} />
  );
}

/**
 * A strip of figures separated by vertical rules.
 *
 * The design uses this shape wherever a period is summarised. It is foundation
 * rather than product because the arrangement is fixed; only the figures
 * differ, and those are the caller's.
 */
export function MetricRow({ children }: { children: ReactNode }) {
  return <div className={styles.metricRow}>{children}</div>;
}

export function Metric({ children }: { children: ReactNode }) {
  return <div className={styles.metric}>{children}</div>;
}
