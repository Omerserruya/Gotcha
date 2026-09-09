'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Cookie consent, stored on the visitor's own device.
 *
 * There are two categories and only two. Strictly necessary cannot be turned
 * off - it is what makes signing in work - and analytics is off until someone
 * turns it on. Nothing here asks for "marketing" or "personalisation" consent,
 * because the site does not have either and a consent form should not imply
 * capabilities that do not exist.
 *
 * The record is versioned. If the categories ever change, bumping VERSION makes
 * every stored decision stale and asks again, rather than silently treating a
 * yes to one question as a yes to a different one.
 */

export const CONSENT_VERSION = 1;
const KEY = 'gotcha.consent';

export type Consent = {
  version: number;
  /** Always true. Present so a stored record is self-describing. */
  necessary: true;
  analytics: boolean;
  /** ISO timestamp of the decision, so it can be shown back to the visitor. */
  decidedAt: string;
};

export function readConsent(): Consent | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Consent;
    if (parsed?.version !== CONSENT_VERSION) return null;
    return { ...parsed, necessary: true };
  } catch {
    // A private window, or a corrupt value: treat as "not asked yet".
    return null;
  }
}

export function writeConsent(analytics: boolean): Consent {
  const record: Consent = {
    version: CONSENT_VERSION,
    necessary: true,
    analytics,
    decidedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Not being able to remember means we ask again next time, which is the
    // safe direction: it never turns into consent we did not get.
  }
  return record;
}

/**
 * The decision, and whether we are still waiting for one.
 *
 * `pending` starts false and only becomes true after mount. These pages are
 * statically generated, so the server cannot know what this visitor chose; the
 * banner has to appear from the client or every cached page would ship with it
 * baked in.
 */
export function useConsent() {
  const [consent, setConsent] = useState<Consent | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const found = readConsent();
    if (found) setConsent(found);
    else setPending(true);
  }, []);

  const decide = useCallback((analytics: boolean) => {
    setConsent(writeConsent(analytics));
    setPending(false);
  }, []);

  const reopen = useCallback(() => setPending(true), []);

  return { consent, pending, decide, reopen };
}
