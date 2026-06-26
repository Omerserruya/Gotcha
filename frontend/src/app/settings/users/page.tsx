"use client";

import { RequirePermission } from "@/components/RequirePermission";
import { UsersContent } from "./content";

export default function UsersPage() {
  return (
    <RequirePermission perm="settings:members:manage">
      <UsersContent />
    </RequirePermission>
  );
}
