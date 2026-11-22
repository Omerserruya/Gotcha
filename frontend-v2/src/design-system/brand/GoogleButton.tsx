import type { MouseEventHandler } from 'react';

import { Button } from '../primitives/button/Button';

import gUrl from './google-g.png';
import styles from './GoogleButton.module.css';

/**
 * "Continue with Google" - Google's button, by Google's rules, in one place
 * (developers.google.com/identity/branding-guidelines, read 2026-11-22).
 *
 * - Light theme: fill #FFFFFF, a 1px inside stroke #747775, text #1F1F1F.
 * - Google Sans Medium 14/20, served from this repo (OFL 1.1, the licence
 *   beside the files in ../fonts). No request leaves for Google.
 * - The standard full-colour G, cropped from Google's own asset bundle
 *   (signin-assets.zip, "Light, Show text=No, Square" @4x: the 20px logo area,
 *   80px, shown at 20). Never recoloured, never redrawn, always on white.
 * - 12px before the logo, 10px after it, 12px after the text; mirrored in RTL.
 * - The same height and width as the primary beside it ("at least as
 *   prominent"): the `lg`, full-width Button underneath.
 *
 * ★ A link when it can go straight there (`href`), a button when something
 *   must happen first (`onClick`: the setup page records the Terms before it
 *   leaves). A link cannot be disabled; a button can.
 */
export function GoogleButton({
  label,
  href,
  onClick,
  disabled,
  testId,
}: {
  /** The caller's words: "המשך עם Google", or the busy line. */
  readonly label: string;
  readonly href?: string;
  readonly onClick?: MouseEventHandler<HTMLElement>;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  const content = (
    <>
      {/*
        Decorative: the label already says Google. A plain <img>: a fixed
        20px asset with nothing for next/image to optimise, on the sign-in
        origin's narrowed CSP.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.logo} src={gUrl.src} alt="" width={20} height={20} />
      <span className={styles.label}>{label}</span>
    </>
  );

  if (href !== undefined) {
    return (
      <Button asChild size="lg" fullWidth>
        <a className={styles.google} href={href} onClick={onClick} data-testid={testId}>
          {content}
        </a>
      </Button>
    );
  }

  // `Button` takes no className by design; as a slot it merges the child's.
  return (
    <Button asChild size="lg" fullWidth>
      <button
        type="button"
        className={styles.google}
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
      >
        {content}
      </button>
    </Button>
  );
}
