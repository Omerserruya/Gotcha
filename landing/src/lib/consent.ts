'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Cookie consent, remembered across every hostname the site answers on.
 *
 * There are two categories and only two. Strictly necessary cannot be turned
 * off - it is what makes signing in work - and analytics is off until someone
 * turns it on. Nothing here asks for "marketing" or "personalisation" consent,
 * because the site does not have either and a consent form should not imply
 * capabilities that do not exist.
 *
 * The record lives in a COOKIE, not in localStorage. localStorage is keyed by
 * origin, and this site is four origins - gotcha.co.il, help., trust. and app.
 * - so answering the question on the marketing page left help.gotcha.co.il
 * still asking, and answering it there left trust. still asking. A cookie set
 * on the registrable domain is shared by all of them, which is the only
 * storage the browser offers that matches the question being asked once.
 *
 * The record is versioned. If the categories ever change, bumping VERSION makes
 * every stored decision stale and asks again, rather than silently treating a
 * yes to one question as a yes to a different one.
 */

export const CONSENT_VERSION = 1;

/** Read by nothing but this module; named in the Cookie Policy. */
const NAME = 'gotcha_consent';

/** The localStorage key this used to live under, still read once, to migrate. */
const LEGACY_KEY = 'gotcha.consent';

/**
 * Six months. Long enough that nobody is nagged, short enough that a decision
 * is not treated as permanent - which is the direction the guidance points, and
 * the safe direction for an answer that was "no".
 */
const MAX_AGE_SECONDS = 182 * 24 * 60 * 60;

export type Consent = {
  version: number;
  /** Always true. Present so a stored record is self-describing. */
  necessary: true;
  analytics: boolean;
  /** ISO timestamp of the decision, so it can be shown back to the visitor. */
  decidedAt: string;
};

/**
 * The broadest domain this browser will accept a cookie for, found by asking it.
 *
 * The alternative is to derive it from the hostname, and that needs the Public
 * Suffix List: `gotcha.co.il` has a two-label suffix, so "everything after the
 * first dot" yields `.co.il`, which browsers refuse outright - the cookie would
 * silently never be set and the banner would come back exactly as it does now.
 * Setting a probe and reading it back is exact, needs no list, and works the
 * same on a `.com` or a `localhost`.
 */
function sharedDomain(): string | null {
  const host = window.location.hostname;
  // An IP address or a single label has no parent domain to share with.
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return null;

  const parts = host.split('.');
  // Widest first: `.co.il` is tried and rejected before `.gotcha.co.il` is
  // tried and accepted, so the answer is the broadest one that actually works.
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = '.' + parts.slice(i).join('.');
    const probe = `__gotcha_probe_${Date.now()}`;
    document.cookie = `${probe}=1;domain=${candidate};path=/;SameSite=Lax`;
    if (document.cookie.includes(`${probe}=`)) {
      document.cookie = `${probe}=;domain=${candidate};path=/;max-age=0;SameSite=Lax`;
      return candidate;
    }
  }
  return null;
}

function readCookie(name: string): string | null {
  const prefix = name + '=';
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
  }
  return null;
}

function parse(raw: string | null): Consent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Consent;
    if (parsed?.version !== CONSENT_VERSION) return null;
    return { ...parsed, necessary: true };
  } catch {
    return null;
  }
}

export function readConsent(): Consent | null {
  try {
    const fromCookie = parse(readCookie(NAME));
    if (fromCookie) return fromCookie;

    // Someone who answered before this moved to a cookie. Honour their answer
    // and carry it over, so they are not asked a second time for the same thing.
    const legacy = parse(window.localStorage.getItem(LEGACY_KEY));
    if (legacy) {
      persist(legacy);
      return legacy;
    }
    return null;
  } catch {
    // A private window, or storage refused: treat as "not asked yet".
    return null;
  }
}

function persist(record: Consent): void {
  const value = encodeURIComponent(JSON.stringify(record));
  const domain = sharedDomain();
  const secure = window.location.protocol === 'https:' ? ';Secure' : '';
  const attrs = `path=/;max-age=${MAX_AGE_SECONDS};SameSite=Lax${secure}`;

  document.cookie = domain ? `${NAME}=${value};domain=${domain};${attrs}` : `${NAME}=${value};${attrs}`;

  try {
    // A same-origin backstop, for the case where the cookie is refused but
    // storage is not. It is never read in preference to the cookie.
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(record));
  } catch {
    // Not being able to remember means we ask again next time, which is the
    // safe direction: it never turns into consent we did not get.
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
    persist(record);
  } catch {
    // As above: forgetting is safe, inventing consent is not.
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
