'use client';

import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

import styles from './overlay.module.css';

export const TooltipProvider = RadixTooltip.Provider;

/**
 * Tooltip.
 *
 * Deliberately narrow: a tooltip may only ever carry supplementary text. It is
 * not reachable on touch and not always announced, so anything a user must
 * read to proceed - a validation message, the reason an action is blocked -
 * belongs in the page, not here.
 *
 * `content` takes a string rather than nodes so the text is always
 * translatable and never assembled from fragments in render order, which
 * breaks in RTL.
 */
export function Tooltip({
  content,
  children,
  side = 'bottom',
}: {
  content: string;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): ReactNode {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={styles.tooltip}
          side={side}
          sideOffset={6}
          collisionPadding={8}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
