"use client";

/**
 * Account settings, rendered INSIDE the Settings shell (settings/layout.tsx
 * provides the left nav with Account/Workspace groups). This is what makes the
 * personal Account experience feel like part of Settings rather than a separate
 * page you're redirected to. Reuses the same AccountExperience component as the
 * standalone /account route.
 */

import { AccountExperience } from "@/app/account/AccountExperience";

export default function SettingsAccountPage() {
  return <AccountExperience embedded />;
}
