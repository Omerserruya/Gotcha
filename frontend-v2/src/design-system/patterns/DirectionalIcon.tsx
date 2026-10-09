'use client';

import type { ReactElement } from 'react';

import { useDirection } from '@/i18n/direction-context';

import styles from './directional-icon.module.css';

/**
 * Mirrors an icon only when its meaning is directional.
 *
 * A chevron that means "forward" must point left in Hebrew. A clock, a
 * checkmark, a person, a magnifying glass and a company logo must not be
 * mirrored - flipping them produces a broken-looking glyph that means nothing
 * in any language. So mirroring is opt-in per icon, at the call site that
 * knows what the icon means, rather than a blanket CSS transform on every SVG.
 */
export function DirectionalIcon({ children }: { children: ReactElement }) {
  const direction = useDirection();
  return (
    <span className={direction === 'rtl' ? styles.mirrored : undefined} aria-hidden="true">
      {children}
    </span>
  );
}
