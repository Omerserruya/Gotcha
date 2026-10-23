'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useTransition } from 'react';

import type { SavedStep } from '@/api/contracts/onboarding-v2';
import { Link, useRouter } from '@/i18n/navigation';

import type { stepHref } from './preview';
import { saveStep } from './step-actions';

/**
 * A way on that remembers itself: the step reached is saved, THEN the next
 * screen opens. A save that fails never blocks the way on (resuming falls
 * back to what the server proves). In preview nothing is saved: a preview
 * writes nothing.
 */
export function StepLink({
  href,
  step,
  preview = false,
  children,
  ...rest
}: Omit<ComponentProps<typeof Link>, 'href' | 'onClick'> & {
  /** A step's href, as `stepHref` makes it. */
  readonly href: ReturnType<typeof stepHref>;
  /** The step this link leads to, as the server keeps it. */
  readonly step: SavedStep;
  readonly preview?: boolean;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  return (
    <Link
      {...rest}
      href={href}
      aria-disabled={isPending || undefined}
      onClick={(event) => {
        if (preview) return;
        event.preventDefault();
        if (isPending) return;
        start(async () => {
          await saveStep(step).catch(() => false);
          router.push(href);
        });
      }}
    >
      {children}
    </Link>
  );
}
