'use client';

import { useState, type InputHTMLAttributes } from 'react';

/**
 * A text field for a value that has a typed form and a stored form - a day
 * written dd/mm/yyyy and stored yyyy-mm-dd, a clock written however and
 * stored HH:mm.
 *
 * What is typed stays as typed until the field is left; then it is parsed. A
 * parse commits the stored form; a miss puts the last good value back rather
 * than handing the form something it cannot send. Empty commits empty.
 */
export function EntryInput({
  value,
  onCommit,
  parse,
  show = (v) => v,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'type'> & {
  /** The stored form, or `''`. */
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly parse: (typed: string) => string | null;
  readonly show?: (stored: string) => string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={draft ?? show(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const typed = draft.trim();
        const next = typed === '' ? '' : parse(typed);
        if (next !== null) onCommit(next);
        setDraft(null);
      }}
    />
  );
}
