// Shared cache for "is the first-steps journey incomplete?".
//
// AppLayout (and thus the Sidebar) remounts on every page navigation, so any
// per-mount fetch here runs on EVERY click - that made the nav feel delayed
// and the Getting Started item pop in late, shifting the whole menu. This
// module gives an instant synchronous answer from localStorage and refreshes
// from the server at most once per page load, in the background.

import { getOnboardingJourney } from "./api";

const KEY = "onboarding.journeyIncomplete";

let fetchedThisLoad = false;

/** Synchronous best-known answer. null = never fetched on this browser. */
export function cachedJourneyIncomplete(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

export function setJourneyIncompleteCache(incomplete: boolean): void {
  try { localStorage.setItem(KEY, incomplete ? "1" : "0"); } catch { /* private mode */ }
}

/**
 * Refresh from the server at most once per page load. Returns the fresh value
 * (or the cached one when already refreshed / on failure). `force` bypasses
 * the once-per-load memo (used right after actions that change milestones).
 */
export async function refreshJourneyIncomplete(token: string, force = false): Promise<boolean | null> {
  if (fetchedThisLoad && !force) return cachedJourneyIncomplete();
  fetchedThisLoad = true;
  try {
    const r = await getOnboardingJourney(token);
    const incomplete = !r.data.complete;
    setJourneyIncompleteCache(incomplete);
    return incomplete;
  } catch {
    return cachedJourneyIncomplete();
  }
}
