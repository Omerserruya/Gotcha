'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { checkMfaGate } from './mfa-actions';

/**
 * At most one check a minute. The route reads Authentik live for every
 * caller, so a check on every click would be every user's clicks on the
 * identity provider; the platform caches a pass for a minute as well.
 */
export const MFA_WATCH_EVERY_MS = 60_000;

/**
 * ★ The gate while the product is open (the legacy gate checked on every
 * route change and on focus). A layout runs once per full load, so a person
 * whose workspace starts requiring two-step sign-in mid-session would meet
 * the platform's 403 mfa_enrollment_required on every read instead of the
 * gate. Owed: refresh, and the layout draws the gate. Unread: nothing.
 */
export function MfaWatch() {
  const router = useRouter();
  const pathname = usePathname();
  const refreshed = useRef(false);
  const last = useRef(-Infinity);

  useEffect(() => {
    let current = true;
    const check = () => {
      const now = Date.now();
      if (now - last.current < MFA_WATCH_EVERY_MS) return;
      last.current = now;
      void checkMfaGate()
        .catch(() => null)
        .then((gate) => {
          if (!current || !gate?.mustEnroll || refreshed.current) return;
          refreshed.current = true;
          router.refresh();
        });
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      current = false;
      window.removeEventListener('focus', check);
    };
  }, [pathname, router]);

  return null;
}
