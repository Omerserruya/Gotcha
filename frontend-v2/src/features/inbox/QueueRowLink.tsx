'use client';

import type { ComponentProps, MouseEvent, ReactNode } from 'react';

import { Link } from '@/i18n/navigation';

import { markPendingOpen, usePendingOpen, type PendingOpen } from './pending-open';
import { toggleSelected, useSelection } from './queue-selection';

/**
 * A queue row's link, which marks itself the moment it is clicked.
 *
 * ⚠ THE MARK IS THE SERVER'S UNTIL A CLICK, THEN THE CLICK'S UNTIL THE SERVER
 *   ANSWERS. With nothing pending, `data-open` and `aria-current` say what the
 *   server rendered. With a click pending, they follow the click - on this
 *   row and off every other - so exactly one row is marked throughout.
 *
 * A click that opens elsewhere (a new tab) is not this tab navigating, and
 * marks nothing. Shift-click picks the row for the queue menu.
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
  /** What to show while the click is pending - from the row, already loaded. */
  readonly pending: PendingOpen;
  readonly children: ReactNode;
}) {
  const pending = usePendingOpen();
  const selected = useSelection().includes(target.id);
  const marked = pending === null ? open : pending.id === target.id;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    /*
     * ★ 02: "Shift-click to pick several". Shift-click would otherwise open a
     *   new window; in the queue it picks the row for the menu instead, and
     *   opens nothing.
     */
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      toggleSelected(target.id);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (open && pending === null) return;
    markPendingOpen(target);
  };

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={marked ? 'true' : undefined}
      data-open={marked ? '' : undefined}
      /* For the queue menu: which conversation a right-click landed on. */
      data-conversation-id={target.id}
      data-selected={selected ? '' : undefined}
      aria-selected={selected || undefined}
      {...rest}
    >
      {children}
    </Link>
  );
}
