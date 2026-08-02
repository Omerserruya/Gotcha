"use client";

// Shared redirect stub for Settings routes whose UI moved to a new canonical
// home (see lib/settings-routes.ts). Keeps old links/bookmarks working;
// persisted configuration is untouched.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LEGACY_SETTINGS_REDIRECTS } from "@/lib/settings-routes";

export function LegacyRedirect({ from }: { from: keyof typeof LEGACY_SETTINGS_REDIRECTS | string }) {
  const router = useRouter();
  const target = LEGACY_SETTINGS_REDIRECTS[from] || "/settings";
  useEffect(() => {
    router.replace(target);
  }, [router, target]);
  return null;
}
