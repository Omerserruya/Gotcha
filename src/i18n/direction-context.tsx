'use client';

import { Direction } from 'radix-ui';
import { createContext, useContext, type ReactNode } from 'react';

import { directionOf } from './locales';

export type TextDirection = 'ltr' | 'rtl';

const DirectionContext = createContext<TextDirection>('ltr');

/**
 * Publishes the writing direction to the component tree.
 *
 * Direction is decided once, from locale metadata, and applied in two places:
 * `<html dir>`, which drives every logical property in the stylesheets, and
 * Radix's `DirectionProvider`, which drives keyboard behaviour and popover
 * placement inside the primitives.
 *
 * This context exists for the small number of cases CSS cannot reach - an icon
 * that must mirror, an animation that must travel the other way. It is not a
 * general-purpose "am I in Hebrew" hook: layout must come from logical
 * properties, not from branching on this value.
 */
export function DirectionProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const direction = directionOf(locale);
  return (
    <DirectionContext.Provider value={direction}>
      <Direction.Provider dir={direction}>{children}</Direction.Provider>
    </DirectionContext.Provider>
  );
}

export function useDirection(): TextDirection {
  return useContext(DirectionContext);
}
