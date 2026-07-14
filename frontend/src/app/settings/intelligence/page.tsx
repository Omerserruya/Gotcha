"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/context/I18nContext";
import { useAuth } from "@/context/AuthContext";
import { listIntelligenceReviews } from "@/lib/gotcha-api";
import FieldsTab from "./FieldsTab";
import AutomationsTab from "./AutomationsTab";
import ReviewTab from "./ReviewTab";

type Tab = "fields" | "automations" | "review";

function IntelligencePageInner() {
  const { locale } = useI18n();
  const { token } = useAuth();
  const he = locale === "he";
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawTab = searchParams.get("tab");
  const activeTab: Tab =
    rawTab === "automations" || rawTab === "review" ? rawTab : "fields";

  const [pendingCount, setPendingCount] = useState(0);

  const fetchPendingCount = useCallback(async () => {
    if (!token) return;
    try {
      const res = await listIntelligenceReviews(token);
      const pending = (res.reviews ?? []).filter(
        (r) => r.status === "PENDING" || r.status === "pending",
      );
      setPendingCount(pending.length);
    } catch {
      // non-critical - badge simply stays at 0
    }
  }, [token]);

  useEffect(() => {
    fetchPendingCount();
  }, [fetchPendingCount]);

  function setTab(tab: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`/settings/intelligence?${params.toString()}`);
  }

  const tabs: { id: Tab; labelEn: string; labelHe: string }[] = [
    { id: "fields", labelEn: "Fields", labelHe: "שדות" },
    { id: "automations", labelEn: "Automations", labelHe: "אוטומציות" },
    { id: "review", labelEn: "Review Queue", labelHe: "תור סקירה" },
  ];

  return (
    <div className="p-6" dir={he ? "rtl" : "ltr"}>
      {/* Page header */}
      <div className="mb-5 max-w-4xl">
        <h1 className="text-xl font-semibold text-gray-900">
          {he ? "מודיעין" : "Intelligence"}
        </h1>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 max-w-4xl">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const showBadge = tab.id === "review" && pendingCount > 0;
          return (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={`relative px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
                isActive
                  ? "border-violet-600 text-violet-700"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {he ? tab.labelHe : tab.labelEn}
              {showBadge && (
                <span className="absolute -top-1 -end-1 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold leading-none text-white bg-violet-600 rounded-full">
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "fields" && <FieldsTab />}
      {activeTab === "automations" && <AutomationsTab />}
      {activeTab === "review" && <ReviewTab />}
    </div>
  );
}

export default function IntelligencePage() {
  return (
    <Suspense>
      <IntelligencePageInner />
    </Suspense>
  );
}
