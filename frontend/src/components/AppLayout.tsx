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
import { destinationForTenantStatus } from "@/lib/payment-gate";
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

  // Where this organization belongs, if not here.
  //
  // Two changes from the version that let a paid tenant into the product. It no
  // longer sends every not-yet-active tenant to /setup: one that owes money
  // goes to the payment screen, because /setup was the way around paying. And
  // it is no longer ADMIN-only - the paid product is denied to every member of
  // an unpaid organization, so showing them the app to have the API refuse each
  // call was a worse experience than saying why.
  //
  // The server decides; this only obeys. A member of an unpaid organization is
  // refused at the API with 402 whatever happens here.
  useEffect(() => {
    if (isLoading || !user || !token) return;
    if (user.role === "SYSTEM_ADMIN") return; // has no tenant of their own
    let cancelled = false;

    getOnboardingStatus(token)
      .then(async (res) => {
        const target = await destinationForTenantStatus(res.data.tenant.status, {
          authToken: token,
          pathname,
        });
        if (!cancelled && target) router.replace(target);
      })
      .catch(() => {}); // Ignore errors (e.g. system admin, or no tenant yet)

    return () => {
      cancelled = true;
    };
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
