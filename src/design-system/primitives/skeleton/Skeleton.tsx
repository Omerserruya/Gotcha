import styles from './Skeleton.module.css';

/**
 * Loading placeholder.
 *
 * `aria-hidden`, and the *container* carries `aria-busy` plus a live label.
 * Announcing a skeleton would read a screen reader a stream of nothing; the
 * useful announcement is one "loading" for the region, which is what
 * `SkeletonRegion` provides.
 */
export function Skeleton({
  shape = 'block',
  width,
  height,
}: {
  shape?: 'block' | 'text' | 'circle';
  width?: string;
  height?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={[
        styles.skeleton,
        shape === 'text' && styles.text,
        shape === 'circle' && styles.circle,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ display: 'block', inlineSize: width, blockSize: height }}
    />
  );
}

export function SkeletonRegion({
  label,
  children,
}: {
  /** Translated, e.g. "Loading conversations". */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite" aria-label={label}>
      {children}
    </div>
  );
}
