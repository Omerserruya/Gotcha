import framedUrl from './mark-framed.png';
import markUrl from './mark.png';

import styles from './Logo.module.css';

/**
 * The GOTCHA mark.
 *
 * Takes the colour of whatever contains it, so the rail's light-on-dark and a
 * panel's dark-on-light are the same component with no colour prop and no
 * second asset per colour. The mark is a single-colour silhouette, so it is
 * used as a CSS mask and painted with `currentColor`.
 *
 * Two shapes, and the choice is about size rather than taste:
 *
 *   `mark`   - the glyph alone. Solid, so it survives being drawn at 16px.
 *   `framed` - the glyph inside its rounded-square outline. The outline is a
 *              thin stroke; below roughly 32px it closes up into a smudge, so
 *              this belongs at brand sizes, not in a rail or a favicon.
 */
export type LogoVariant = 'mark' | 'framed';

const SOURCE: Record<LogoVariant, string> = {
  mark: markUrl.src,
  framed: framedUrl.src,
};

export function Logo({
  size = 26,
  variant = 'mark',
  title,
}: {
  size?: number;
  variant?: LogoVariant;
  title?: string;
}) {
  return (
    <span
      className={styles.mark}
      style={{
        inlineSize: size,
        blockSize: size,
        // Next hashes the asset URL at build time; the mask reads it from here.
        ['--brand-mark' as string]: `url(${SOURCE[variant]})`,
      }}
      // Where the mark sits beside the wordmark it needs no name of its own:
      // the text already says GOTCHA, and announcing it twice is noise.
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
}
