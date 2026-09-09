'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

import styles from './Input.module.css';

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'id'
> {
  /** Always required. A placeholder is not a label: it disappears on focus. */
  readonly label: string;
  readonly hint?: string;
  /** Presence marks the field invalid and wires it up for announcement. */
  readonly error?: string;
  readonly trailing?: ReactNode;
}

/**
 * Text input.
 *
 * The label, hint and error are wired to the control by id rather than left to
 * the caller. Doing it here is what guarantees a screen reader announces the
 * error at all - `aria-describedby` assembled by hand is the single most
 * commonly forgotten piece of an accessible form.
 *
 * Text alignment is inherited, never set: an input in a Hebrew page aligns to
 * the right because the document does, and an English value typed into it
 * still reads correctly.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, trailing, ...rest },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
        }
        {...rest}
      />
      {hint && !error ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        // `role="alert"` so the message is announced when it appears, rather
        // than only when the field is next focused.
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
      {trailing}
    </div>
  );
});
