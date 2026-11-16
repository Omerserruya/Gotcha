'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/design-system/primitives/button/Button';

/**
 * The waits after each Try again, in seconds: the first try is at once, every
 * try after it waits longer, and none waits more than a minute.
 */
export const RETRY_WAITS_S = [5, 15, 30, 60] as const;

/** How long the button rests after the `attempt`-th try (0-based). */
export function retryWait(attempt: number): number {
  return RETRY_WAITS_S[Math.min(Math.max(attempt, 0), RETRY_WAITS_S.length - 1)]!;
}

/**
 * ★★ A FAILED READ IS RETRIED BY A PERSON, NEVER BY THE PAGE (prod,
 * 2026-11-16). One console tab asked the server for /he/system 4-5 times a
 * second for an hour; each ask was a server render that called the platform,
 * and the platform's rate limit then refused every OTHER customer's server
 * calls, since they all leave from one address. So a screen that could not
 * read what it needs says so and offers this button, and:
 *
 *   - nothing here runs on its own: no timer refreshes, no effect navigates;
 *   - a try is `router.refresh()`, a fresh server render of the same page,
 *     never `location.reload()` (which would also forget the wait below);
 *   - after each try the button rests, longer each time (`RETRY_WAITS_S`),
 *     and says for how long.
 */
export function BackoffRetry({
  label,
  className,
  testid = 'backoff-retry',
}: {
  /** The button's words; "Try again" when not given. */
  readonly label?: string;
  readonly className?: string;
  readonly testid?: string;
}) {
  const t = useTranslations('common');
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  const [restUntil, setRestUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (restUntil === null) return;
    const tick = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= restUntil) setRestUntil(null);
    }, 1000);
    return () => window.clearInterval(tick);
  }, [restUntil]);

  const resting = restUntil !== null && now < restUntil;
  const seconds = resting ? Math.ceil((restUntil - now) / 1000) : 0;

  const onClick = () => {
    const at = Date.now();
    setNow(at);
    setRestUntil(at + retryWait(attempts) * 1000);
    setAttempts((n) => n + 1);
    router.refresh();
  };
  const words = resting ? t('retryIn', { seconds }) : (label ?? t('actions.retry'));

  // A caller with its own look (the workspace gate) brings its class; anyone
  // else gets the design system's primary button.
  return className !== undefined ? (
    <button type="button" className={className} disabled={resting} data-testid={testid} onClick={onClick}>
      {words}
    </button>
  ) : (
    <Button variant="primary" disabled={resting} data-testid={testid} onClick={onClick}>
      {words}
    </Button>
  );

}
