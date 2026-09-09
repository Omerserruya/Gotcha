'use client';

import { useTransition } from 'react';

import { Button } from '@/design-system/primitives/button/Button';

import { markAllRead } from './mark-read';

/**
 * Clears the unread count.
 *
 * Deliberately not optimistic. Unlike settling a knowledge conflict, this is
 * the operator declaring they have seen everything — if it silently failed and
 * the interface said otherwise, they would stop checking. The pending state is
 * short and honest.
 */
export function MarkAllRead({ label }: { label: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={isPending}
      onClick={() => startTransition(() => void markAllRead())}
    >
      {label}
    </Button>
  );
}
