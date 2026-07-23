"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { Sidebar } from "./Sidebar";
import { CommandCenterProvider } from "./CommandCenter/CommandCenterProvider";
import { CommandCenterTrigger } from "./CommandCenter/CommandCenterTrigger";
import { MobileHeader, MobileBottomNav } from "./MobileNav";
import { FeatureGuides } from "./onboarding/FeatureGuides";
import { GuidedTour } from "./onboarding/GuidedTour";
import { CreditAlertBanner } from "./CreditAlertBanner";
import { getOnboardingStatus } from "@/lib/api";
import { setAnalyticsToken } from "@/lib/analytics";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, token, isLoading } = useAuth();

  // Product analytics need the session token; wiring it here covers every
  // page without threading it through each track() call site.
  useEffect(() => { setAnalyticsToken(token || null); }, [token]);
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [panelAutoCollapsed, setPanelAutoCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") {
      setCollapsed(true);
      setUserCollapsed(true);
    }
  }, []);

  // Listen for chat open/close on mobile (to hide header/bottom nav)
  useEffect(() => {
    function handleChatToggle(e: Event) {
      const detail = (e as CustomEvent).detail;
      setChatOpen(!!detail?.open);
    }
    window.addEventListener("chat:toggle", handleChatToggle);
    return () => window.removeEventListener("chat:toggle", handleChatToggle);
  }, []);

  // Auto-collapse sidebar when side panels open (desktop only)
  useEffect(() => {
    function handlePanelToggle(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.open) {
        setPanelAutoCollapsed(true);
        setCollapsed(true);
      } else {
        setPanelAutoCollapsed(false);
        if (!userCollapsed) {
          setCollapsed(false);
        }
      }
    }
    window.addEventListener("panel:toggle", handlePanelToggle);
    return () => window.removeEventListener("panel:toggle", handlePanelToggle);
  }, [userCollapsed]);

  function handleToggle() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      setUserCollapsed(next);
      return next;
    });
  }

  // Check tenant onboarding status and redirect if needed
  useEffect(() => {
    if (!isLoading && user && user.role === "ADMIN" && token && !pathname.startsWith("/setup")) {
      getOnboardingStatus(token)
        .then((res) => {
          if (res.data.tenant.status !== "ACTIVE") {
            router.replace("/setup");
          }
        })
        .catch(() => {}); // Ignore errors (e.g. system admin)
    }
  }, [user, isLoading, token, router, pathname]);

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace("/login");
    }
    if (!isLoading && user?.role === "SYSTEM_ADMIN" && !pathname.startsWith("/system")) {
      router.replace("/system");
    }
  }, [user, isLoading, router, pathname]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-gray-200 border-t-primary-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-400">{t("app.loading")}</span>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Check if current page is conversations with a selected chat (to hide bottom nav)
  const isConversationPage = pathname === "/conversations";

  return (
    <CommandCenterProvider>
      <CommandCenterTrigger />
      <div className="flex min-h-screen app-bg md:p-2 md:gap-2">
        <div className="app-bg-spots" />
        {/* Desktop sidebar - hidden on mobile */}
        <div className="hidden md:block relative z-10">
          <Sidebar collapsed={collapsed} onToggle={handleToggle} />
        </div>

        {/* Mobile layout */}
        <div className="flex-1 flex flex-col md:contents overflow-hidden relative z-10">
          {/* Mobile header - hidden when chat is open on mobile */}
          {!chatOpen && <MobileHeader />}

          {/* Main content - add bottom padding on mobile for admin bottom nav (not when chat is open) */}
          <main className={`flex-1 overflow-hidden w-full relative z-10 ${user?.role === "ADMIN" && !chatOpen ? "md:pb-0 pb-[68px]" : ""}`}>
            <CreditAlertBanner />
            {children}
          </main>

          {/* Mobile bottom nav - admin only, hidden on desktop and when chat is open */}
          {!chatOpen && <MobileBottomNav />}
        </div>
        {/* Persistent first-time guidance layer - shows a per-feature
            coachmark the first time a user opens Knowledge Base, AI
            Employees, Workflows, or Settings. Skippable + snoozable, state
            stored per-user in the DB. Renders nothing otherwise. */}
        <FeatureGuides />
        {/* First-run journey - boots once, right after onboarding completes
            (armed via localStorage "onboarding.launchTour"). Renders nothing
            otherwise. Was never mounted before, so the tour never appeared. */}
        <GuidedTour />
      </div>
    </CommandCenterProvider>
  );
}
