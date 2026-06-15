"use client";

/**
 * SchedulePicker - the "send now / send later" control for the broadcast wizard.
 *
 * UX brief:
 *   - Default to "Send now" because the most common newsletter action is
 *     "go right now I just finished writing it".
 *   - For scheduling: timezone label is explicit (so the operator never
 *     wonders "is this UTC or my local?"), a relative hint shows
 *     "in 14h 22m" so the chosen datetime feels concrete, and three
 *     one-tap presets cover ~80% of the planning patterns
 *     (next hour / tomorrow morning / next-week kickoff).
 */

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";

interface Props {
  sendNow: boolean;
  scheduledAt: string; // datetime-local (YYYY-MM-DDTHH:mm)
  onChangeSendNow: (v: boolean) => void;
  onChangeScheduledAt: (v: string) => void;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeFromNow(target: Date): string {
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "-";
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h`;
}

export function SchedulePicker({ sendNow, scheduledAt, onChangeSendNow, onChangeScheduledAt }: Props) {
  const { t } = useI18n();
  const tz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; }
  }, []);

  // Tick once a minute for the relative label
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  function applyPreset(p: "in1h" | "tomorrow9" | "nextMonday10") {
    const d = new Date();
    if (p === "in1h") {
      d.setHours(d.getHours() + 1, Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    } else if (p === "tomorrow9") {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    } else {
      // next Monday - if today is Monday, jump 7 days
      const day = d.getDay(); // 0=Sun, 1=Mon
      const offset = day === 1 ? 7 : (1 - day + 7) % 7 || 7;
      d.setDate(d.getDate() + offset);
      d.setHours(10, 0, 0, 0);
    }
    onChangeSendNow(false);
    onChangeScheduledAt(toLocalInput(d));
  }

  const target = scheduledAt ? new Date(scheduledAt) : null;

  return (
    <div className="space-y-4">
      {/* Send now toggle */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChangeSendNow(true)}
          className={clsx(
            "px-4 py-2 rounded-xl text-sm font-medium transition",
            sendNow
              ? "bg-primary-500 text-white shadow-sm"
              : "bg-gray-50 text-gray-700 hover:bg-gray-100"
          )}
        >
          {t("outbound.broadcasts.sendNow")}
        </button>
        <button
          type="button"
          onClick={() => onChangeSendNow(false)}
          className={clsx(
            "px-4 py-2 rounded-xl text-sm font-medium transition",
            !sendNow
              ? "bg-primary-500 text-white shadow-sm"
              : "bg-gray-50 text-gray-700 hover:bg-gray-100"
          )}
        >
          {t("outbound.broadcasts.scheduleLater")}
        </button>
      </div>

      {!sendNow && (
        <div className="space-y-3">
          {/* Presets */}
          <div className="flex flex-wrap items-center gap-2">
            <PresetChip onClick={() => applyPreset("in1h")} label={t("outbound.broadcasts.presetIn1h")} />
            <PresetChip onClick={() => applyPreset("tomorrow9")} label={t("outbound.broadcasts.presetTomorrow9")} />
            <PresetChip onClick={() => applyPreset("nextMonday10")} label={t("outbound.broadcasts.presetNextMonday10")} />
          </div>

          {/* Datetime + TZ + relative */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              {t("outbound.broadcasts.scheduleFor")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => onChangeScheduledAt(e.target.value)}
                min={toLocalInput(new Date())}
                className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
              />
              <span className="text-[11px] text-gray-500 inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 002 2 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {t("outbound.broadcasts.tzLabel")}: {tz}
              </span>
              {target && target.getTime() > Date.now() && (
                <span className="text-[11px] font-medium text-primary-600 bg-primary-50 px-2 py-1 rounded-md">
                  {t("outbound.broadcasts.relativeIn", { rel: relativeFromNow(target) })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PresetChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1.5 rounded-full text-xs font-medium bg-gray-50 text-gray-700 hover:bg-primary-50 hover:text-primary-700 border border-gray-200 hover:border-primary-200 transition"
    >
      {label}
    </button>
  );
}
