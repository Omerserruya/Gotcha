"use client";

// Roles & Permissions management was unified into the Users page (Roles tab).
// Redirect kept so old links/bookmarks still work.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SettingsPermissionsPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/people?tab=users");
  }, [router]);
  return null;
}
