"use client";

// Moved - see lib/settings-routes.ts for the canonical home. Redirect kept so
// old links/bookmarks still work; persisted configuration is untouched.
import { LegacyRedirect } from "@/components/LegacyRedirect";

export default function LegacyPage() {
  return <LegacyRedirect from="/settings/users" />;
}
