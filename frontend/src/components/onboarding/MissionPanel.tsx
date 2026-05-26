"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getOnboardingMissions, type OnboardingMission } from "@/lib/api";
import clsx from "clsx";

const HIDE_KEY = "onboarding.missions.hidden";
const POLL_MS = 30_000;
const TOTAL = 5;

interface Props {
  collapsed: boolean;
}

export function MissionPanel({ collapsed }: Props) {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [missions, setMissions] = useState<OnboardingMission[] | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(HIDE_KEY) === "true");
    } catch { /* private mode */ }
  }, []);

  const fetchMissions = useCallback(async () => {
    if (!token || user?.role !== "ADMIN") return;
    try {
      const res = await getOnboardingMissions(token);
      setMissions(res.data.missions);
    } catch {
      /* silent — sidebar shouldn't break if endpoint is unavailable */
    }
  }, [token, user?.role]);

  useEffect(() => {
    fetchMissions();
    const id = window.setInterval(fetchMissions, POLL_MS);
    const onFocus = () => fetchMissions();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchMissions]);

  if (!missions || user?.role !== "ADMIN") return null;

  const doneCount = missions.filter((m) => m.status === "done").length;
  if (doneCount >= TOTAL) return null;

  function toggleHidden() {
    const next = !hidden;
    setHidden(next);
    try {
      localStorage.setItem(HIDE_KEY, String(next));
    } catch { /* ignore */ }
  }

  function go(m: OnboardingMission) {
    if (m.status === "done") return;
    try {
      window.dispatchEvent(new CustomEvent("onboarding:mission_click", { detail: { id: m.id } }));
    } catch { /* ignore */ }
    router.push(m.deepLink);
  }

  // Collapsed sidebar — just a progress dot.
  if (collapsed) {
    return (
      <div className="px-2 pb-2 flex justify-center">
        <button
          type="button"
          onClick={toggleHidden}
          title={t("onboarding.missions.title")}
          className="w-9 h-9 rounded-xl bg-primary-50 text-primary-600 text-[11px] font-bold flex items-center justify-center hover:bg-primary-100 transition"
        >
          {doneCount}/{TOTAL}
        </button>
      </div>
    );
  }

  if (hidden) {
    return (
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={toggleHidden}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-gray-50 hover:bg-gray-100 transition text-xs text-gray-600"
        >
          <span className="truncate">
            {t("onboarding.missions.title")} <span className="text-gray-400">({doneCount}/{TOTAL})</span>
          </span>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
      </div>
    );
  }

  const progressPct = Math.round((doneCount / TOTAL) * 100);

  return (
    <div className="mx-3 mb-3 rounded-2xl border border-primary-100 bg-gradient-to-br from-primary-50/60 to-white p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-700">{t("onboarding.missions.title")}</span>
        <span className="text-[11px] text-gray-500">{doneCount}/{TOTAL}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-100 mb-3 overflow-hidden">
        <div
          className="h-full bg-primary-500 transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <ul className="space-y-1">
        {missions.map((m) => {
          const label = t(`onboarding.missions.items.${m.id}`);
          const isActive = m.status === "active";
          const isDone = m.status === "done";
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => go(m)}
                disabled={isDone}
                className={clsx(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition",
                  isActive && "bg-white text-primary-700 font-medium ring-1 ring-primary-200 shadow-sm",
                  !isActive && !isDone && "text-gray-400 hover:text-gray-600",
                  isDone && "text-gray-400 line-through cursor-default"
                )}
              >
                <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                  {isDone ? (
                    <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : isActive ? (
                    <span className="w-2 h-2 rounded-full bg-primary-500" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
                  )}
                </span>
                <span className="truncate">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={toggleHidden}
        className="w-full mt-2 text-[11px] text-gray-400 hover:text-gray-600 transition"
      >
        {t("onboarding.missions.hide")}
      </button>
    </div>
  );
}
