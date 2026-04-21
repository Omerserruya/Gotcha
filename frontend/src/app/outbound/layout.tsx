"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import clsx from "clsx";

const tabs = [
  { href: "/outbound/call", labelKey: "outbound.nav.call" },
  { href: "/outbound/templates", labelKey: "outbound.nav.templates" },
  { href: "/outbound/broadcasts", labelKey: "outbound.nav.broadcasts" },
  { href: "/outbound/scheduled", labelKey: "outbound.nav.scheduled" },
];

export default function OutboundLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { state: callState } = useVoiceCall();

  // While on a voice call, hand the whole content area to the Stage UI —
  // skip the outbound title + tabs (sidebar stays via AppLayout).
  const inCall = callState !== "idle" && pathname === "/outbound/call";

  if (inCall) {
    return (
      <AppLayout>
        <div className="h-full w-full md:pb-2">{children}</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen flex flex-col">
        <div className="mb-4 md:mb-6">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("outbound.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("outbound.subtitle")}</p>
        </div>

        <div className="flex gap-1 bg-gray-100/80 p-1 rounded-xl mb-5 w-fit">
          {tabs.map((tab) => {
            const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={clsx(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-all",
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

        <div className="flex-1">{children}</div>
      </div>
    </AppLayout>
  );
}
