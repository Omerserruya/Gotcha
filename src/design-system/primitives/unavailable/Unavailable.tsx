import type { ReactNode } from 'react';

import styles from './Unavailable.module.css';

/**
 * Unavailable, in one look everywhere (Omer, 2026-10-07): what cannot be
 * done yet is a STATUS, never something that looks like an action - no
 * button, no switch, no hover, a default cursor, `aria-disabled`; a tag on
 * the item itself ("Coming soon" where it is being built, "Not available
 * yet" where it is not), and the reason as its line. A click does nothing.
 *
 * The words are the caller's: a primitive reads no catalogue.
 */
export function UnavailableTag({ label }: { readonly label: string }) {
  return <span className={styles.tag}>{label}</span>;
}

/**
 * The status alone, where there is no room for a button's label (a table's
 * column head): the tag, wrapping if it must, the reason on hover and for a
 * screen reader. Same look, same semantics.
 */
export function UnavailableStatus({
  tag,
  why,
  testid,
}: {
  readonly tag: string;
  readonly why: string;
  readonly testid?: string;
}) {
  return (
    <span
      className={styles.status}
      aria-disabled="true"
      title={why}
      data-unavailable=""
      data-testid={testid}
    >
      <span className={styles.tag}>{tag}</span>
      <span className={styles.srOnly}>{` ${why}`}</span>
    </span>
  );
}

/** In place of a button: its label, the tag, the reason on hover and for a screen reader. */
export function UnavailableAction({
  label,
  tag,
  why,
  testid,
}: {
  readonly label: string;
  readonly tag: string;
  readonly why: string;
  readonly testid?: string;
}) {
  return (
    <span
      className={styles.action}
      aria-disabled="true"
      title={why}
      data-unavailable=""
      data-testid={testid}
    >
      {label}
      <UnavailableTag label={tag} />
      <span className={styles.srOnly}>{` ${why}`}</span>
    </span>
  );
}

/** In place of a card, a row, a toggle: its content, the tag, the reason as its line. */
export function UnavailableItem({
  title,
  tag,
  why,
  icon,
  testid,
}: {
  readonly title: ReactNode;
  readonly tag: string;
  readonly why: string;
  readonly icon?: ReactNode;
  readonly testid?: string;
}) {
  return (
    <div className={styles.item} aria-disabled="true" data-unavailable="" data-testid={testid}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        <span className={styles.why}>{why}</span>
      </span>
      <UnavailableTag label={tag} />
    </div>
  );
}
