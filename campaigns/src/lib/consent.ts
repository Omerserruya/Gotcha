/**
 * A COPY of landing/src/lib/consent.ts, and the copy is the point of risk.
 *
 * Both apps read and write the SAME cookie - `gotcha_consent`, set on
 * `.gotcha.co.il` and therefore shared by gotcha.co.il, go.gotcha.co.il, the
 * Help Center and the Trust Center. The Cookie Policy promises exactly that:
 * "you are asked once and not again as you move between" them. Someone who
 * allowed advertising measurement on the marketing site is not asked again
 * here, and their pixel loads on arrival.
 *
 * WHICH MEANS THESE TWO FILES MUST AGREE. `CONSENT_VERSION`, the cookie name
 * and the record's shape are a wire format shared between two applications, not
 * an implementation detail of either. Bumping the version in one and not the
 * other would make each treat the other's record as stale and re-ask - the
 * exact nagging the shared cookie exists to prevent. If you change any of them
 * in landing/, change them here in the same commit.
 *
 * It is a copy rather than an import because these are separate apps with
 * separate builds and separate `@/` roots, which is the whole premise of this
 * directory. The duplication is 200 lines; the coupling is three constants.
 *
 * ---- what follows is the original file's own documentation ----
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Cookie consent, remembered across every hostname the site answers on.
 *
 * Three categories. Strictly necessary cannot be turned off - it is what makes
 * signing in work. Analytics and marketing are both off until someone turns
 * them on, and they are asked separately because they are different questions:
 * counting page views is not the same as letting an advertising network
 * recognise you. Nothing here asks for "personalisation", because the site does
 * not have any and a consent form should not imply capabilities that do not
 * exist.
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

/**
 * Bumped to 2 when marketing was added as its own category.
 *
 * Everyone who had answered was asked again, on purpose: they answered a
 * two-category question, and treating that as consent to a third would be
 * inventing an answer they never gave.
 */
export const CONSENT_VERSION = 2;

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
  /** Advertising and conversion measurement. The Meta pixel reads only this. */
  marketing: boolean;
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
    // Defaulting a missing category to false rather than to the record: a
    // decision that predates a category cannot have covered it.
    return { ...parsed, necessary: true, marketing: parsed.marketing === true };
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

export function writeConsent(analytics: boolean, marketing: boolean): Consent {
  const record: Consent = {
    version: CONSENT_VERSION,
    necessary: true,
    analytics,
    marketing,
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
 *
 * One record, shared by every caller. The card and the pixel each call this
 * hook, and while each held its own useState the card could record a yes that
 * the pixel never heard: it kept the answer it had read on mount and only
 * noticed on the next page load. A module-level record with subscribers means
 * saying yes takes effect where it was said.
 */

/** undefined until the first read; null once read and found absent. */
let current: Consent | null | undefined;
const listeners = new Set<() => void>();

export function useConsent() {
  const [consent, setConsent] = useState<Consent | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (current === undefined) current = readConsent();
    const apply = () => {
      setConsent(current ?? null);
      setPending(current == null);
    };
    apply();
    listeners.add(apply);
    return () => { listeners.delete(apply); };
  }, []);

  const decide = useCallback((analytics: boolean, marketing: boolean) => {
    current = writeConsent(analytics, marketing);
    listeners.forEach((f) => f());
  }, []);

  /** Show the card again without forgetting the stored answer. */
  const reopen = useCallback(() => setPending(true), []);

  return { consent, pending, decide, reopen };
}
