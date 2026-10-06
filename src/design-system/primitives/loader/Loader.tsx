import type { CSSProperties } from 'react';

import { appPath } from '@/lib/base-path';

import styles from './Loader.module.css';

/**
 * The GOTCHA loader (Omer, 2026-10-06): for AREAS that are waiting - a page,
 * a section, the panel - never inside a button, which keeps its own words
 * ("Saving…"). Where a list's shape is known, a skeleton is still better.
 *
 *   tone   `dark`: the dark mark, on light surfaces (the default).
 *          `light`: the light mark, on dark ones - the Copilot panel.
 */

export interface LoaderProps {
  readonly size?: number;
  readonly tone?: 'dark' | 'light';
  /**
   * The words a screen reader says, already translated. Required: a
   * design-system primitive reads no catalogue (the sign-in surface carries
   * `auth` and `errors` only - see namespaces.test.ts).
   */
  readonly label: string;
}

export function Loader({ size = 48, tone = 'dark', label }: LoaderProps) {
  return (
    <span
      className={styles.loader}
      data-tone={tone}
      role="status"
      aria-label={label}
      data-testid="loader"
      style={
        {
          '--size': `${size}px`,
          '--mark': `url(${appPath(`/brand/gotcha-mark-${tone}.png`)})`,
        } as CSSProperties
      }
    />
  );
}

/** The loader in the middle of the area it stands for. */
export function CenteredLoader({
  minHeight = 160,
  fill = false,
  ...loader
}: LoaderProps & {
  readonly minHeight?: number;
  /** Take the parent's whole height (a page's card, the Copilot panel) and centre in it. */
  readonly fill?: boolean;
}) {
  return (
    <div
      className={styles.centered}
      data-fill={fill ? '' : undefined}
      style={{ '--min': `${minHeight}px` } as CSSProperties}
      data-testid="centered-loader"
    >
      <Loader {...loader} />
    </div>
  );
}
