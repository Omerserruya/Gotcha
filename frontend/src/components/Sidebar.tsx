"use client";

import { useAppPathname } from "@/lib/pathname";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionsContext";
import { useI18n } from "@/context/I18nContext";
import clsx from "clsx";
import { NotificationBell } from "./NotificationBell";
import { cachedJourneyIncomplete, cachedJourneySummary, refreshJourneyIncomplete, subscribeJourney } from "@/lib/journey-cache";
import { IncomingCallBannerSidebar } from "./voice/IncomingCallBanner";
import { MissionPanel } from "./onboarding/MissionPanel";

// `domain` ties a nav item to its licensed feature domain: when the tenant's
// license disables that domain (system console / plan / POC feature set), the
// item disappears here - /api/permissions/me returns no keys under it.
const navItems = [
  // journeyGated: shown only while the first-steps journey is incomplete
  // (mirrors MissionPanel's auto-dismiss - once done it's gone for good).
  // The old "Your Business" slot is gone entirely - what it showed is now
  // Knowledge Base content (AI Studio → Knowledge).
  { href: "/getting-started", icon: RocketIcon, labelKey: "nav.gettingStarted", adminOnly: true, journeyGated: true },
  { href: "/conversations", icon: ChatIcon, labelKey: "nav.conversations" },
  { href: "/history", icon: HistoryIcon, labelKey: "nav.history", managerOrAdmin: true },
  { href: "/approvals", icon: ApprovalsIcon, labelKey: "nav.approvals", adminOnly: true, domain: "approvals" },
  { href: "/dashboard", icon: DashboardIcon, labelKey: "nav.dashboard", adminOnly: true, domain: "analytics" },
  { href: "/analytics", icon: AnalyticsIcon, labelKey: "nav.analytics", adminOnly: true, domain: "analytics" },
  { href: "/outbound", icon: OutboundIcon, labelKey: "nav.outbound", adminOnly: true, domain: "channels" },
  { href: "/ai-studio", icon: AIStudioIcon, labelKey: "nav.aiStudio", adminOnly: true, domain: "ai" },
  { href: "/settings", icon: SettingsIcon, labelKey: "nav.settings", adminOnly: true },
];

function RocketIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
    </svg>
  );
}

function ApprovalsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
    </svg>
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onMobileClose?: () => void;
}

export function Sidebar({ collapsed, onToggle, onMobileClose }: SidebarProps) {
  const { user, token, logout } = useAuth();
  const { atLeastRole, permissions, loaded, roleKey } = usePermissions();
  const { t } = useI18n();
  const pathname = useAppPathname();

  // Getting Started nav: instant answer from the localStorage cache (the
  // Sidebar remounts on every navigation - a per-mount fetch made every click
  // feel laggy and the item pop in late, shifting the menu). The cache
  // refreshes from the server at most once per page load, in the background.
  const [journeyIncomplete, setJourneyIncomplete] = useState<boolean>(() => cachedJourneyIncomplete() === true);
  // Remaining-steps badge on the Getting Started item - same canonical store
  // as the page and the setup panel, so the counts always match.
  const [journeyRemaining, setJourneyRemaining] = useState<number | null>(() => {
    const s = cachedJourneySummary();
    return s ? Math.max(0, s.total - s.done) : null;
  });
  useEffect(() => {
    if (!token || user?.role !== "ADMIN") return;
    refreshJourneyIncomplete(token).then((v) => {
      if (v !== null) setJourneyIncomplete(v);
    });
  }, [token, user?.role]);
  useEffect(() =>
    subscribeJourney((j) => {
      if (!j) return;
      setJourneyIncomplete(!j.complete);
      setJourneyRemaining(Math.max(0, (j.summary?.total ?? 0) - (j.summary?.done ?? 0)));
    }),
  []);

  return (
    <aside
      className={clsx(
        "bg-white flex flex-col shrink-0 h-screen md:h-[calc(100vh-16px)] sticky top-0 transition-all duration-300 shadow-float md:rounded-2xl md:overflow-hidden",
        collapsed ? "w-[68px]" : "w-64"
      )}
    >
      {/* Logo + Collapse toggle */}
      <div className={clsx(
        "bg-gray-50/50",
        collapsed ? "flex flex-col items-center py-3 gap-2" : "p-4 flex items-center justify-between"
      )}>
        <div className={clsx("flex items-center min-w-0", collapsed ? "justify-center" : "gap-3")}>
          <Image src="/apple-touch-icon.png" alt="GOTCHA" width={36} height={36} className="w-9 h-9 shrink-0" />
          {!collapsed && (
            <Image src="/logo.png" alt="GOTCHA" width={100} height={28} className="h-7 w-auto" />
          )}
        </div>
        {/* Close button on mobile */}
        {onMobileClose && (
          <button
            onClick={onMobileClose}
            className="md:hidden w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition"
            aria-label="Close menu"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {/* Collapse toggle on desktop - moves below logo when collapsed */}
        {!collapsed && (
          <button
            onClick={onToggle}
            className="hidden md:flex w-7 h-7 rounded-lg items-center justify-center text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition"
            title="Collapse"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
        )}
      </div>

      {/* Scrollable middle: nav + call banner + mission panel.
          It MUST carry min-h-0 - a flex child defaults to min-height:auto, so
          without it the nav refuses to shrink, the column overflows its fixed
          h-screen, and md:overflow-hidden silently eats the footer below
          (that's how the first-steps mission panel made the whole bottom of
          the menu disappear). The user block stays outside, always visible. */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {/* Navigation */}
        <nav className="py-3 space-y-1 px-2">
          {navItems
            .filter((item) => {
              // Gated by effective built-in role (consistent with the backend
              // requireRole bridge - assigned roles drive nav, no dead links).
              if (item.adminOnly && !atLeastRole("admin")) return false;
              if ((item as any).managerOrAdmin && !atLeastRole("department_manager")) return false;
              if ((item as any).journeyGated && !journeyIncomplete) return false;
              // License gate: hide areas the tenant isn't entitled to. Only once
              // /permissions/me has loaded (never flicker-hide during boot), and
              // never for SYSTEM_ADMIN.
              const domain = (item as any).domain as string | undefined;
              if (domain && loaded && roleKey !== "system_admin") {
                let licensed = false;
                permissions.forEach((k) => { if (k.startsWith(domain + ":")) licensed = true; });
                if (!licensed) return false;
              }
              return true;
            })
            .map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? t(item.labelKey) : undefined}
                  // data-tour hook used by the first-time GuidedTour to
                  // spotlight nav targets like /ai-studio and /conversations.
                  data-tour={`nav-${item.href.replace(/^\//, "").split("/")[0] || "home"}`}
                  className={clsx(
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all",
                    isActive
                      ? "bg-primary-50/70 text-primary-600 font-medium"
                      : "text-gray-500 hover:text-primary-600 hover:bg-gray-50/80"
                  )}
                >
                  <item.icon className="w-5 h-5 shrink-0" />
                  {!collapsed && <span className="text-sm">{t(item.labelKey)}</span>}
                  {!collapsed && item.href === "/getting-started" && (journeyRemaining ?? 0) > 0 && (
                    <span className="ms-auto shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-primary-100 text-primary-700 text-[11px] font-bold flex items-center justify-center tabular-nums">
                      {journeyRemaining}
                    </span>
                  )}
                </Link>
              );
            })}
        </nav>

        {/* Incoming call banner - desktop sidebar slot */}
        <IncomingCallBannerSidebar />

        {/* Onboarding mission panel - auto-hides when all 5 are done */}
        <MissionPanel collapsed={collapsed} />
      </div>

      {/* Language switcher moved to Settings → Language (system-wide
          setting that also affects AI-generated content like briefs,
          summaries, and co-pilot insights). */}

      {/* Expand toggle - shown above avatar when collapsed */}
      {collapsed && (
        <div className="px-3 pb-1 hidden md:flex justify-center">
          <button
            onClick={onToggle}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition"
            title="Expand"
          >
            <svg className="w-4 h-4 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
        </div>
      )}

      {/* Workspace switcher - only for identities with several tenants */}
      <WorkspaceSwitcher collapsed={collapsed} />

      {/* User & Logout */}
      <div className="p-3 bg-gray-50/30">
        <div className={clsx("flex items-center", collapsed ? "justify-center" : "gap-3")}>
          <div className="w-9 h-9 bg-gradient-to-br from-primary-400 to-primary-600 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm">
            {user?.name?.charAt(0).toUpperCase() || "?"}
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{user?.name}</p>
                <p className="text-xs text-gray-400 truncate">{user?.role}</p>
              </div>
              <div className="flex items-center gap-1">
                <NotificationBell />
                <Link
                  href="/settings/account"
                  className="text-gray-400 hover:text-primary-600 transition p-1.5 rounded-lg hover:bg-primary-50"
                  title={t("nav.account") || "Account & Security"}
                >
                  <AccountIcon className="w-5 h-5" />
                </Link>
                <button
                  onClick={logout}
                  className="text-red-400 hover:text-red-600 transition p-1.5 rounded-lg hover:bg-red-50"
                  title={t("nav.logout")}
                >
                  <LogoutIcon className="w-5 h-5" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── Workspace switcher ─────────────────────────────────────
// Fast tenant switching for identities that belong to several workspaces.
// The switch itself is a validated server call + full reload (AuthContext.
// switchTenant), which rebuilds permissions, entitlements, departments,
// branding, and AI config against the new tenant.

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { user, memberships, tenantName, switchTenant } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (memberships.length < 2) return null;
  const activeName = tenantName || memberships.find((m) => m.tenant.id === user?.tenantId)?.tenant.name || "";

  const pick = async (tenantId: string) => {
    if (busy || tenantId === user?.tenantId) { setOpen(false); return; }
    setBusy(tenantId);
    try { await switchTenant(tenantId); } catch { setBusy(null); }
  };

  return (
    <div ref={ref} className="relative px-2 pb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t("tenant.switchWorkspace") || "Switch workspace"}
        className={clsx(
          "w-full flex items-center rounded-xl border border-gray-100 bg-white hover:border-primary-200 hover:bg-primary-50/40 transition",
          collapsed ? "justify-center p-2" : "gap-2.5 px-3 py-2"
        )}
        data-tour="workspace-switcher"
      >
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-[11px] font-bold text-white shrink-0">
          {activeName.charAt(0).toUpperCase() || "?"}
        </div>
        {!collapsed && (
          <>
            <span className="flex-1 min-w-0 text-start text-sm font-medium text-gray-800 truncate">{activeName}</span>
            <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 15L12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9" />
            </svg>
          </>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 inset-x-2 z-50 bg-white rounded-xl shadow-float border border-gray-100 p-1.5 max-h-72 overflow-y-auto min-w-[220px]">
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            {t("tenant.workspaces") || "Workspaces"}
          </p>
          {memberships.map((m) => {
            const isActive = m.tenant.id === user?.tenantId;
            return (
              <button
                key={m.tenant.id}
                onClick={() => void pick(m.tenant.id)}
                disabled={!!busy}
                className={clsx(
                  "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition text-start",
                  isActive ? "bg-primary-50/70" : "hover:bg-gray-50"
                )}
              >
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                  {m.tenant.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 truncate">{m.tenant.name}</p>
                  <p className="text-[11px] text-gray-400">{t(`tenant.role.${m.role}`) || m.role}</p>
                </div>
                {busy === m.tenant.id ? (
                  <div className="w-4 h-4 border-2 border-gray-200 border-t-primary-500 rounded-full animate-spin shrink-0" />
                ) : isActive ? (
                  <svg className="w-4 h-4 text-primary-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Icons ──────────────────────────────────────────────────

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  );
}

function BotIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  );
}

function AIStudioIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

function CopilotIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
    </svg>
  );
}

function OutboundIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0121.485 12 59.768 59.768 0 013.27 20.875L5.999 12zm0 0h7.5" />
    </svg>
  );
}

function ChannelsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  );
}

function DepartmentsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z" />
    </svg>
  );
}

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.5 1.5 0 012.122 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" />
    </svg>
  );
}

function KnowledgeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
    </svg>
  );
}

function ToolsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function UsageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  );
}

function FirstTakeCareIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  );
}

function AnalyticsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  );
}

function LogoutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
    </svg>
  );
}

function AccountIcon({ className }: { className?: string }) {
  // Shield-check: account & security.
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  );
}
