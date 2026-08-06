"use client";

import { useAppPathname } from "@/lib/pathname";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { AppLayout } from "@/components/AppLayout";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import { usePermissions } from "@/context/PermissionsContext";
import clsx from "clsx";

import { settingsNav, type SettingsNavItem } from "./settings-nav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = useAppPathname();
  const router = useRouter();
  const flags = useVoiceFlags();
  const { user } = useAuth();
  const { can, atLeastRole } = usePermissions();

  // Since Account moved under /settings, EVERY role legitimately enters this
  // area - so workspace administration must be gated per item, not by "you got
  // here at all". atLeastRole derives synchronously from user.role.
  const isWorkspaceAdmin = atLeastRole("admin");

  const visibleNav = settingsNav.filter((item) => {
    if (item.voiceOnly && !flags.voiceCopilotEnabled) return false;
    // Workspace items are admin-only; non-admins get only the personal group.
    if ((item.group ?? "workspace") === "workspace" && !isWorkspaceAdmin) return false;
    // Permission-gated items are additionally hidden unless held.
    if (item.perm && !can(item.perm)) return false;
    if (item.adminOnly && !isWorkspaceAdmin) return false;
    return true;
  });

  // Deep links too, not just the nav: a non-admin typing /settings/usage (or
  // any workspace page) is bounced to their Account page. The backend still
  // enforces roles on every write; this keeps the UI honest.
  const onPersonalRoute = pathname.startsWith("/settings/account");
  useEffect(() => {
    if (user && !isWorkspaceAdmin && !onPersonalRoute) {
      router.replace("/settings/account");
    }
  }, [user, isWorkspaceAdmin, onPersonalRoute, router]);
  if (user && !isWorkspaceAdmin && !onPersonalRoute) return null;

  function labelFor(item: SettingsNavItem): string {
    return item.labelKey ? t(item.labelKey) : item.label ?? "";
  }

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-16px)] md:gap-2 md:p-2">
        {/* Settings sidebar - hidden on mobile, shown on md+ */}
        {/* data-tour hooks: the GuidedTour spotlights this menu ("settings-nav")
            and individual entries ("settings-nav-channels") to teach the
            Settings → section navigation path. */}
        <aside data-tour="settings-nav" className="hidden md:flex w-[220px] flex-col bg-white rounded-2xl shadow-subtle overflow-hidden shrink-0">
          <div className="px-4 py-3 bg-gray-50/50">
            <h2 className="text-sm font-semibold text-gray-900">{t("nav.settings")}</h2>
          </div>
          <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
            {visibleNav.map((item, i) => {
              const isActive = item.href === "/settings/account"
                ? pathname.startsWith("/settings/account")
                : item.exact
                ? pathname === item.href
                : pathname.startsWith(item.href) && !pathname.startsWith("/settings/account");
              const grp = item.group ?? "workspace";
              const prevGrp = i === 0 ? null : (visibleNav[i - 1].group ?? "workspace");
              const showHeader = grp !== prevGrp;
              return (
                <div key={item.href}>
                  {showHeader && (
                    <p className={clsx("px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-300", i > 0 && "pt-3")}>
                      {grp === "personal" ? t("settings.nav.groupAccount") : t("settings.nav.groupWorkspace")}
                    </p>
                  )}
                  <Link
                    href={item.href}
                    data-tour={`settings-nav-${item.href.split("/")[2] || item.href.split("/")[1] || "general"}`}
                    className={clsx(
                      "flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all",
                      isActive
                        ? "bg-primary-50/70 text-primary-600"
                        : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                    )}
                  >
                    <item.icon className="w-4 h-4 shrink-0" />
                    {labelFor(item)}
                  </Link>
                </div>
              );
            })}
          </nav>
        </aside>

        {/* Main content */}
        <div className="flex-1 overflow-y-auto md:rounded-2xl md:bg-white md:shadow-subtle">
          {/* Mobile settings tabs */}
          <div data-tour="settings-nav" className="md:hidden flex overflow-x-auto bg-white shadow-subtle px-2 py-2 gap-1 sticky top-0 z-10">
            {visibleNav.map((item) => {
              const isActive = item.exact
                ? pathname === item.href
                : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-tour={`settings-nav-${item.href.split("/")[2] || "general"}`}
                  className={clsx(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap transition shrink-0",
                    isActive
                      ? "bg-primary-50 text-primary-600"
                      : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
                  )}
                >
                  {labelFor(item)}
                </Link>
              );
            })}
          </div>
          {children}
        </div>
      </div>
    </AppLayout>
  );
}

