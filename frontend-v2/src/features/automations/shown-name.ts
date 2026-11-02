import type { Automation } from '@/api/contracts/automations';

/** The name onboarding stores on the setup route (Backend 8f68171c) - English, as stored. */
export const SETUP_ROUTE_NAME = 'Who answers new conversations';

/**
 * The name to show: the setup route's as onboarding wrote it is said in the
 * screen's words; once someone renames it, theirs, as written.
 */
export function shownName(
  automation: Pick<Automation, 'name' | 'origin'>,
  setupName: string,
): string {
  return automation.origin === 'setup' && automation.name === SETUP_ROUTE_NAME
    ? setupName
    : automation.name;
}
