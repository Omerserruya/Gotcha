'use client';

import { useEffect } from 'react';

/**
 * Warns before the browser discards unsaved work.
 *
 * Scoped to leaving the page entirely - closing the tab, a reload, following
 * an external link - because that is the case the browser lets us intercept.
 * In-app navigation is guarded per feature, where there is enough context to
 * offer "save" and "discard" rather than a browser dialog nobody can style.
 *
 * Deliberately opt-in. Attaching this globally would nag users about forms
 * they never meant to submit.
 */
export function useUnsavedChangesWarning(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      // Browsers ignore any custom message and show their own wording; calling
      // preventDefault is what triggers the prompt at all.
      event.preventDefault();
    }

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [enabled]);
}
