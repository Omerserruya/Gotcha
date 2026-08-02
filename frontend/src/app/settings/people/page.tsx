"use client";

// People & Teams - the one Settings destination for humans and their
// structure: Users (members, roles, permissions) and Departments as tabs.
// This is a NAVIGATION consolidation only: the underlying User, Membership
// and Department models (and their pages' components) are unchanged.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import { UsersContent } from "../users/content";
import { DepartmentsContent } from "@/app/departments/content";

type PeopleTab = "users" | "departments";

function PeopleInner() {
  const { t } = useI18n();
  const router = useRouter();
  const search = useSearchParams();

  const fromUrl = search.get("tab");
  const [tab, setTabState] = useState<PeopleTab>(fromUrl === "departments" ? "departments" : "users");

  // Keep the tab in the URL so deep links (and the legacy /settings/users,
  // /settings/departments redirects) land on the right tab.
  useEffect(() => {
    if (fromUrl === "departments" || fromUrl === "users") setTabState(fromUrl);
  }, [fromUrl]);

  const setTab = useCallback((next: PeopleTab) => {
    setTabState(next);
    router.replace(`/settings/people?tab=${next}`, { scroll: false });
  }, [router]);

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">{t("settings.people.title")}</h1>
        <p className="mt-0.5 text-sm text-gray-500">{t("settings.people.subtitle")}</p>
      </div>
      <div className="mb-5 inline-flex rounded-xl bg-gray-100 p-1">
        {(["users", "departments"] as PeopleTab[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={clsx(
              "rounded-lg px-4 py-1.5 text-sm font-medium transition",
              tab === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
            )}
          >
            {t(`settings.people.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === "users" ? (
        <RequirePermission perm="settings:members:manage">
          <UsersContent />
        </RequirePermission>
      ) : (
        <DepartmentsContent />
      )}
    </div>
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={null}>
      <PeopleInner />
    </Suspense>
  );
}
