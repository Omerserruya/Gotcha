"use client";

// Agents management was unified into the Users page (Members tab).
// Redirect kept so old links/bookmarks still work.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SettingsAgentsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/people?tab=users");
  }, [router]);
  return null;
}
