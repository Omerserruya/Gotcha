'use client';

import { useSyncExternalStore, type ReactNode } from 'react';

import { nativePlatform } from './native';

const unchanging = () => () => {};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NO PURCHASE LINK INSIDE THE APP (App Store 3.1.1, 2026-11-15)
 * ════════════════════════════════════════════════════════════════════════════
 * The iOS shell opens a link to billing or checkout in the browser: a
 * purchase outside the app, which the App Store refuses. The website and the
 * web /m keep theirs.
 *
 * ★ FAIL CLOSED. The shell sends the server nothing to tell it apart (no
 *   user agent, no cookie), so the server's answer is `false` - no link in
 *   the first HTML - and the browser adds it once it knows it is not the app
 *   (`nativePlatform()`: Capacitor's own `isNativePlatform`). In the app it
 *   never appears, not even for the moment before hydration.
 */
export function usePurchaseLinksAllowed(): boolean {
  return useSyncExternalStore(
    unchanging,
    () => nativePlatform() === null,
    () => false,
  );
}

/** `children` outside the app; `fallback` (nothing, by default) inside it and in the first HTML. */
export function WebOnly({
  children,
  fallback = null,
}: {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}) {
  return usePurchaseLinksAllowed() ? children : fallback;
}
