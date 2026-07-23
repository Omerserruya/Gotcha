// The ONE frontend store for setup readiness (GET /onboarding/journey).
//
// The Getting Started page, the sidebar "Complete setup" panel, and the nav
// item/badge all read THIS store - none of them computes setup state on its
// own, so they can never disagree. A refresh triggered anywhere (page load,
// OAuth return, window focus) notifies every subscriber in the same tick.
//
// AppLayout (and thus the Sidebar) remounts on every page navigation, so any
// per-mount fetch here would run on EVERY click - that made the nav feel
// delayed and the Getting Started item pop in late, shifting the whole menu.
// This module gives an instant synchronous answer from localStorage and
// module memory, and refreshes from the server in the background.

import { getOnboardingJourney, type JourneyData } from "./api";

const KEY = "onboarding.journeyIncomplete";
const SUMMARY_KEY = "onboarding.journeySummary";

let fetchedThisLoad = false;
let inflight: Promise<JourneyData | null> | null = null;
let memory: JourneyData | null = null;

type Listener = (journey: JourneyData | null) => void;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((l) => {
    try { l(memory); } catch { /* a broken subscriber must not break the rest */ }
  });
}

/** Live journey data from this page load, if any request completed yet. */
export function getCachedJourney(): JourneyData | null {
  return memory;
}

/** Synchronous best-known answer. null = never fetched on this browser. */
export function cachedJourneyIncomplete(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

/** Synchronous {done,total} from the last completed fetch (survives reloads). */
export function cachedJourneySummary(): { done: number; total: number } | null {
  try {
    const raw = localStorage.getItem(SUMMARY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.done === "number" && typeof v?.total === "number" ? v : null;
  } catch {
    return null;
  }
}

export function setJourneyIncompleteCache(incomplete: boolean): void {
  try { localStorage.setItem(KEY, incomplete ? "1" : "0"); } catch { /* private mode */ }
}

/** Store a full journey response and fan it out to every subscriber. */
export function setJourneyData(journey: JourneyData): void {
  memory = journey;
  setJourneyIncompleteCache(!journey.complete);
  try {
    if (journey.summary) localStorage.setItem(SUMMARY_KEY, JSON.stringify(journey.summary));
  } catch { /* private mode */ }
  notify();
}

/** Subscribe to journey updates. Returns the unsubscribe function. */
export function subscribeJourney(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Fetch the canonical journey. At most one request per page load unless
 * `force` (used after setup actions / OAuth returns / focus refreshes);
 * concurrent callers share one in-flight request.
 */
export async function refreshJourney(token: string, force = false): Promise<JourneyData | null> {
  if (fetchedThisLoad && !force) return memory;
  if (inflight) return inflight;
  fetchedThisLoad = true;
  inflight = getOnboardingJourney(token)
    .then((r) => {
      setJourneyData(r.data);
      return r.data;
    })
    .catch(() => memory)
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Legacy wrapper: refresh and answer "is the journey incomplete?". Kept for
 * the root-redirect and older call sites.
 */
export async function refreshJourneyIncomplete(token: string, force = false): Promise<boolean | null> {
  const j = await refreshJourney(token, force);
  return j ? !j.complete : cachedJourneyIncomplete();
}
