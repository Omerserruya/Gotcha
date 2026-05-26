"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getOnboardingMissions } from "@/lib/api";

// Renders a one-line nudge at the top of /channels ONLY while
// the "connect_channel" mission is the active one. As soon as a
// channel finishes OAuth + the next poll runs, the mission flips
// to done and this disappears — no manual dismiss.
export function ChannelsOnboardingBanner() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!token || user?.role !== "ADMIN") return;
    let cancelled = false;
    getOnboardingMissions(token)
      .then((res) => {
        if (cancelled) return;
        const active = res.data.missions.find((m) => m.status === "active");
        setShow(active?.id === "connect_channel");
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [token, user?.role]);

  if (!show) return null;

  return (
    <div className="rounded-xl border border-primary-200 bg-primary-50/70 px-4 py-3 text-sm text-primary-700 flex items-start gap-3">
      <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>{t("onboarding.channelsBanner")}</span>
    </div>
  );
}
