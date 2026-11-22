import styles from './or-rule.module.css';

/**
 * A rule with a word in it - "או" between two ways in (Google sign-in,
 * 2026-11-22): under the password form on sign-in, and under the new
 * password on a setup link.
 *
 * ★ The word is read, the rules are not: a screen reader hears "or" between
 *   the two controls, which is what the picture says.
 */
export function OrRule({ word }: { readonly word: string }) {
  return (
    <p className={styles.rule}>
      <span className={styles.line} aria-hidden="true" />
      <span className={styles.word}>{word}</span>
      <span className={styles.line} aria-hidden="true" />
    </p>
  );
}
