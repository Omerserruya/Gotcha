"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getOnboardingMissions, type OnboardingMission } from "@/lib/api";
import clsx from "clsx";

const HIDE_KEY = "onboarding.missions.hidden";
const POLL_MS = 30_000;
const TOTAL = 4;

// Module-level cache: the Sidebar (and this panel) remount on EVERY page
// navigation, and starting from null made the panel disappear and pop back
// in on each click - the menu looked like it was "refreshing". The module
// survives SPA navigations, so remounts paint the last known missions
// instantly and the fetch below only updates them in the background.
let cachedMissions: OnboardingMission[] | null = null;

interface Props {
  collapsed: boolean;
}

export function MissionPanel({ collapsed }: Props) {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [missions, setMissions] = useState<OnboardingMission[] | null>(cachedMissions);
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
      cachedMissions = res.data.missions;
      setMissions(res.data.missions);
    } catch {
      /* silent - sidebar shouldn't break if endpoint is unavailable */
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
  // Auto-dismiss: once every step is done the checklist disappears for good.
  if (doneCount >= TOTAL) return null;

  function setHiddenPersisted(next: boolean) {
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

  // Collapsed sidebar - just a progress dot that expands the rail's panel
  // (clicking restores the full panel if it was dismissed).
  if (collapsed) {
    return (
      <div className="px-2 pb-2 flex justify-center">
        <button
          type="button"
          onClick={() => setHiddenPersisted(false)}
          title={`${t("onboarding.missions.title")} · ${doneCount}/${TOTAL}`}
          className="w-9 h-9 rounded-xl bg-primary-50 text-primary-600 text-[11px] font-bold flex items-center justify-center hover:bg-primary-100 transition"
        >
          {doneCount}/{TOTAL}
        </button>
      </div>
    );
  }

  // Dismissed - a slim restore bar so the user can bring it back any time.
  if (hidden) {
    return (
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => setHiddenPersisted(false)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-50 hover:bg-gray-100 transition text-xs text-gray-600"
        >
          <span className="w-5 h-5 shrink-0 rounded-full bg-primary-100 text-primary-600 text-[10px] font-bold flex items-center justify-center">
            {doneCount}/{TOTAL}
          </span>
          <span className="truncate flex-1 text-left font-medium">{t("onboarding.missions.show")}</span>
          <svg className="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>
    );
  }

  const progressPct = Math.round((doneCount / TOTAL) * 100);

  return (
    <div className="mx-3 mb-3 rounded-2xl border border-primary-100 bg-gradient-to-br from-primary-50/70 to-white p-3.5 shadow-sm">
      {/* Header: clear title + what it is, with a real dismiss button. */}
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-gray-900 leading-tight">{t("onboarding.missions.title")}</h4>
          <p className="text-[11px] text-gray-500 leading-snug mt-0.5">{t("onboarding.missions.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setHiddenPersisted(true)}
          aria-label={t("onboarding.missions.dismiss")}
          title={t("onboarding.missions.dismiss")}
          className="shrink-0 -mr-1 -mt-1 w-6 h-6 rounded-lg flex items-center justify-center text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-2 mb-3">
        <div className="h-1.5 flex-1 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full rounded-full bg-primary-500 transition-all duration-500" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="text-[11px] font-medium text-gray-500 shrink-0 tabular-nums">{doneCount}/{TOTAL}</span>
      </div>

      <ul className="space-y-1">
        {missions.map((m, idx) => {
          const label = t(`onboarding.missions.items.${m.id}`);
          const description = t(`onboarding.missions.descriptions.${m.id}`);
          const isActive = m.status === "active";
          const isDone = m.status === "done";
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => go(m)}
                disabled={isDone}
                data-tour={`mission-${m.id}`}
                className={clsx(
                  "w-full flex items-start gap-2.5 px-2 py-2 rounded-xl text-left transition",
                  isActive && "bg-white ring-2 ring-primary-300 shadow-sm",
                  !isActive && !isDone && "hover:bg-white/70",
                  isDone && "cursor-default opacity-70",
                )}
              >
                {/* Status indicator: check / pulsing dot / step number */}
                <span className="w-5 h-5 mt-0.5 shrink-0 flex items-center justify-center">
                  {isDone ? (
                    <span className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
                      <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </span>
                  ) : isActive ? (
                    <span className="relative inline-flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-primary-400 opacity-75 animate-ping" />
                      <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-primary-500" />
                    </span>
                  ) : (
                    <span className="w-5 h-5 rounded-full bg-gray-100 text-gray-400 text-[10px] font-bold flex items-center justify-center">
                      {idx + 1}
                    </span>
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={clsx(
                        "text-xs truncate",
                        isActive && "font-semibold text-primary-700",
                        isDone && "text-gray-400 line-through",
                        !isActive && !isDone && "text-gray-600 font-medium",
                      )}
                    >
                      {label}
                    </span>
                    {isActive && (
                      <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide bg-primary-500 text-white rounded-full px-1.5 py-0.5">
                        {t("onboarding.missions.next")}
                      </span>
                    )}
                  </span>
                  {/* Description only on the active step - keeps it clear without clutter. */}
                  {isActive && description && (
                    <span className="block text-[11px] text-gray-500 leading-snug mt-0.5">{description}</span>
                  )}
                  {/* Live detail from the server (detected identifiers / open-gap count). */}
                  {isActive && m.hint && (
                    <span className="block text-[10px] text-gray-400 leading-snug mt-0.5 truncate" dir="ltr">{m.hint}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Bridge to the ledger's permanent home - one "what's next" surface, not
          two. The full living backlog + twin live on /settings/business. */}
      <button
        type="button"
        onClick={() => router.push("/settings/business")}
        className="mt-2.5 w-full text-[11px] font-medium text-primary-600 hover:text-primary-700 text-center py-1"
      >
        {t("onboarding.missions.viewBusiness")}
      </button>
    </div>
  );
}
