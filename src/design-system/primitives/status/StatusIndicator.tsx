import styles from './StatusIndicator.module.css';

/**
 * The product's signal vocabulary, and only it.
 *
 * The design names three: lavender for AI, green for done, amber for waiting -
 * plus neutral for everything without a signal. There is no danger red,
 * because the design contains none; weight is carried by confirmation and
 * copy, not by the one saturated colour on the screen.
 */
export type StatusTone = 'neutral' | 'done' | 'waiting' | 'ai';

/**
 * `children` is the already-translated label; this never maps a backend code
 * to text itself. Domain codes such as `WAITING_FOR_CUSTOMER` stay stable
 * identifiers and the i18n layer turns them into copy - which is what lets a
 * status read correctly in Hebrew without the backend translating anything.
 *
 * Colour never carries the meaning alone: the label always says what the
 * status is, so it works for colour-blind users and in monochrome.
 */
export function StatusIndicator({
  tone = 'neutral',
  children,
  showDot = true,
}: {
  tone?: StatusTone;
  children: string;
  showDot?: boolean;
}) {
  return (
    <span className={[styles.indicator, styles[tone]].join(' ')}>
      {showDot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
