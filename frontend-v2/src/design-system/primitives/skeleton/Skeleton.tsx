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

/*
 * ── Presets (Omer, 2026-10-07: placeholders inside the app, not the loader) ──
 * One per shape, each the size of what it stands in for, so nothing jumps
 * when the data lands. Every one is a region that says it is loading (the
 * label is the caller's - a primitive reads no catalogue); the shapes
 * themselves are hidden from screen readers.
 */

/** A table or list: rows of a mark and two lines, at `height` each. */
export function SkeletonRows({
  label,
  rows = 6,
  height = 54,
  mark = true,
  tone = 'default',
  testid = 'skeleton-rows',
}: {
  readonly label: string;
  readonly rows?: number;
  readonly height?: number;
  readonly mark?: boolean;
  readonly testid?: string;
  /** `light` on a dark surface (the Copilot wall). */
  readonly tone?: 'default' | 'light';
}) {
  return (
    <SkeletonRegion label={label}>
      <div className={styles.rows} data-tone={tone} data-testid={testid}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={styles.row} style={{ blockSize: height }}>
            {mark ? <Skeleton shape="circle" width="30px" height="30px" /> : null}
            <span className={styles.lines}>
              <Skeleton shape="text" width={`${46 - (i % 3) * 8}%`} />
              <Skeleton shape="text" width={`${28 + (i % 2) * 12}%`} />
            </span>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Cards in a grid: a title line, two body lines. */
export function SkeletonCards({
  label,
  count = 3,
  height = 120,
  columns = 3,
  tone = 'default',
  testid = 'skeleton-cards',
}: {
  readonly label: string;
  readonly count?: number;
  readonly height?: number;
  readonly columns?: number;
  readonly testid?: string;
  /** `light` on a dark surface (the Copilot wall). */
  readonly tone?: 'default' | 'light';
}) {
  return (
    <SkeletonRegion label={label}>
      <div
        className={styles.cards}
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        data-tone={tone}
        data-testid={testid}
      >
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={styles.card} style={{ blockSize: height }}>
            <Skeleton shape="text" width="40%" />
            <Skeleton shape="text" width="85%" />
            <Skeleton shape="text" width="65%" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Figures: a small label over a large number. */
export function SkeletonStats({
  label,
  count = 4,
  tone = 'default',
  testid = 'skeleton-stats',
}: {
  readonly label: string;
  readonly count?: number;
  readonly testid?: string;
  /** `light` on a dark surface (the Copilot wall). */
  readonly tone?: 'default' | 'light';
}) {
  return (
    <SkeletonRegion label={label}>
      <div
        className={styles.cards}
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
        data-tone={tone}
        data-testid={testid}
      >
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={styles.card} style={{ blockSize: 92 }}>
            <Skeleton shape="text" width="45%" />
            <Skeleton width="38%" height="26px" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** A conversation: bubbles from both sides. `tone="light"` on a dark surface. */
export function SkeletonBubbles({
  label,
  count = 4,
  tone = 'default',
  testid = 'skeleton-bubbles',
}: {
  readonly label: string;
  readonly count?: number;
  readonly tone?: 'default' | 'light';
  readonly testid?: string;
}) {
  return (
    <SkeletonRegion label={label}>
      <div className={styles.bubbles} data-tone={tone} data-testid={testid}>
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={styles.bubble} data-side={i % 2 === 0 ? 'in' : 'out'}>
            <Skeleton width={`${150 + (i % 3) * 50}px`} height={`${34 + (i % 2) * 18}px`} />
          </span>
        ))}
      </div>
    </SkeletonRegion>
  );
}
