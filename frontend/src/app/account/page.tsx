"use client";

/**
 * Account & Security - native self-service experience.
 *
 * The experience itself lives in AccountExperience.tsx because it is rendered
 * in two places: standalone here, and embedded inside the Settings shell at
 * /settings/account. It cannot be exported from this file - a route module may
 * only export a default and Next's route config, and a named export fails the
 * production build while `tsc --noEmit` passes, which is how it went unnoticed.
 */

import { AccountExperience } from "./AccountExperience";

export default function AccountPage() {
  return <AccountExperience />;
}
