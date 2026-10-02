'use client';

import type { ComponentProps, MouseEvent, ReactNode } from 'react';

import { Link } from '@/i18n/navigation';

import { markPendingOpen, usePendingOpen, type PendingOpen } from './pending-open';

/**
 * A queue row's link, which marks itself the moment it is clicked.
 *
 * ⚠ THE MARK IS THE SERVER'S UNTIL A CLICK, THEN THE CLICK'S UNTIL THE SERVER
 *   ANSWERS. With nothing pending, `data-open` and `aria-current` say what the
 *   server rendered. With a click pending, they follow the click — on this
 *   row and off every other — so exactly one row is marked throughout.
 *
 * A click that opens elsewhere (a new tab, a new window) is not this tab
 * navigating, and marks nothing.
 */
export function QueueRowLink({
  href,
  open,
  pending: target,
  children,
  ...rest
}: Omit<ComponentProps<typeof Link>, 'onClick' | 'href'> & {
  readonly href: ComponentProps<typeof Link>['href'];
  /** What the server rendered: is this the open conversation? */
  readonly open: boolean;
  /** What to show while the click is pending — from the row, already loaded. */
  readonly pending: PendingOpen;
  readonly children: ReactNode;
}) {
  const pending = usePendingOpen();
  const marked = pending === null ? open : pending.id === target.id;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (open && pending === null) return;
    markPendingOpen(target);
  };

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={marked ? 'true' : undefined}
      data-open={marked ? '' : undefined}
      {...rest}
    >
      {children}
    </Link>
  );
}
