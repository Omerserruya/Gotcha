"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { usePermissions } from "@/context/PermissionsContext";
import { useI18n } from "@/context/I18nContext";

/**
 * Page-level permission guard. Wrap an admin/config page body so direct-URL
 * access is blocked (not merely hidden from nav). While permissions load it
 * shows a spinner; on denial it renders an inline "no access" state (and
 * optionally redirects).
 *
 *   export default function Page() {
 *     return (
 *       <RequirePermission perm="settings:members:manage">
 *         <UsersAdmin />
 *       </RequirePermission>
 *     );
 *   }
 */
export function RequirePermission({
  perm,
  anyOf,
  redirectTo,
  children,
}: {
  perm?: string;
  anyOf?: string[];
  redirectTo?: string;
  children: React.ReactNode;
}) {
  const { can, canAny, loading, loaded } = usePermissions();
  const router = useRouter();
  const { t } = useI18n();

  const allowed = (perm ? can(perm) : true) && (anyOf?.length ? canAny(...anyOf) : true);

  useEffect(() => {
    if (!loading && loaded && !allowed && redirectTo) {
      router.replace(redirectTo);
    }
  }, [loading, loaded, allowed, redirectTo, router]);

  if (loading && !loaded) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!allowed) {
    if (redirectTo) return null;
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-900">
          {t("permissions.noAccess.title") || "You don't have access to this page"}
        </p>
        <p className="text-xs text-gray-400 mt-1">
          {t("permissions.noAccess.subtitle") || "Ask a workspace admin if you need access."}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
