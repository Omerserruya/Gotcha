"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useI18n } from "@/context/I18nContext";
import clsx from "clsx";

const tabs = [
  { href: "/outbound/call", labelKey: "outbound.nav.call" },
  { href: "/outbound/templates", labelKey: "outbound.nav.templates" },
  { href: "/outbound/campaigns", labelKey: "outbound.nav.broadcasts" },
  { href: "/outbound/scheduled", labelKey: "outbound.nav.scheduled" },
];

export default function OutboundLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();

  // The dialer at /outbound/call hands off to /voice/[sessionId] once the
  // call connects, so the layout chrome (title + tab strip) is always shown
  // while the user is under /outbound/*.

  return (
    <AppLayout>
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Title — hidden on mobile to save vertical space, shown on md+ */}
        <div className="hidden md:block px-6 pt-6 pb-0 shrink-0">
          <h1 className="text-2xl font-bold text-gray-900">{t("outbound.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("outbound.subtitle")}</p>
        </div>

        {/* Tab row: sticky on mobile (z-10, white bg, shadow), inline on md+.
            Horizontal scroll so all 4 tabs are reachable without wrapping. */}
        <div className="sticky top-0 z-10 bg-white shadow-sm md:shadow-none md:static md:bg-transparent shrink-0 md:mt-5">
          <div className="overflow-x-auto scrollbar-none px-3 py-2 md:px-6 md:py-0">
            <div className="inline-flex gap-1 bg-gray-100/80 p-1 rounded-xl w-max">
              {tabs.map((tab) => {
                const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={clsx(
                      "px-3 md:px-4 py-2 rounded-lg text-xs md:text-sm font-medium transition-all whitespace-nowrap",
                      isActive
                        ? "bg-white text-primary-600 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    )}
                  >
                    {t(tab.labelKey)}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto min-h-0 p-3 md:p-6 md:pt-4">{children}</div>
      </div>
    </AppLayout>
  );
}
