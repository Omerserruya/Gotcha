'use client';

import { useTransition } from 'react';

import { markAllRead, markRead } from './mark-read';

/**
 * Clears the unread count.
 *
 * Deliberately not optimistic. Unlike settling a knowledge conflict, this is
 * the operator declaring they have seen everything - if it silently failed and
 * the interface said otherwise, they would stop checking. The pending state is
 * short and honest.
 */
export function MarkAllRead({ label, className }: { label: string; className?: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      data-testid="notifications-mark-all"
      onClick={() => startTransition(() => void markAllRead())}
    >
      {label}
    </button>
  );
}

/** One notification read - all the platform can do to one. */
export function MarkRead({
  id,
  label,
  className,
}: {
  id: string;
  label: string;
  className?: string;
}) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className={className}
      disabled={isPending}
      data-testid={`notification-read-${id}`}
      onClick={() => startTransition(() => void markRead(id))}
    >
      {label}
    </button>
  );
}
