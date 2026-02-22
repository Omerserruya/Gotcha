"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getBusinessHours, updateBusinessHours, getAutoGreeting, updateAutoGreeting } from "@/lib/api";
import { AppLayout } from "@/components/AppLayout";
import clsx from "clsx";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const TIMEZONES = [
  "Asia/Jerusalem",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

interface DaySchedule {
  enabled: boolean;
  open?: string;
  close?: string;
}

interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  autoResponse: string;
  schedule: Record<string, DaySchedule>;
}

const DEFAULT_CONFIG: BusinessHoursConfig = {
  enabled: false,
  timezone: "Asia/Jerusalem",
  autoResponse: "",
  schedule: {
    sunday:    { enabled: true,  open: "09:00", close: "18:00" },
    monday:    { enabled: true,  open: "09:00", close: "18:00" },
    tuesday:   { enabled: true,  open: "09:00", close: "18:00" },
    wednesday: { enabled: true,  open: "09:00", close: "18:00" },
    thursday:  { enabled: true,  open: "09:00", close: "18:00" },
    friday:    { enabled: false },
    saturday:  { enabled: false },
  },
};

export default function SettingsPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const [config, setConfig] = useState<BusinessHoursConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [greetingTemplate, setGreetingTemplate] = useState("");

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const [data, greetingData] = await Promise.all([
        getBusinessHours(token),
        getAutoGreeting(token).catch(() => ({ template: "" })),
      ]);
      setConfig(data);
      setGreetingTemplate(greetingData.template || "");
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    try {
      await Promise.all([
        updateBusinessHours(token, config),
        updateAutoGreeting(token, greetingTemplate),
      ]);
      setMessage(t("settings.saved"));
    } catch (err: any) {
      setMessage(err.message || "Error");
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(""), 3000);
    }
  }

  function updateDay(day: string, field: string, value: any) {
    setConfig((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        [day]: { ...prev.schedule[day], [field]: value },
      },
    }));
  }

  if (user?.role !== "ADMIN") {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-full">
          <p className="text-gray-400">Admin access required</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("settings.title")}</h1>
        <p className="text-sm text-gray-500 mt-1">{t("settings.subtitle")}</p>
      </div>

      {/* Toast message */}
      {message && (
        <div className="bg-green-50 text-green-700 text-sm px-4 py-2.5 rounded-xl border border-green-200">
          {message}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Business Hours */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-gray-900">{t("settings.businessHours")}</h2>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500">{t("settings.enabled")}</span>
                <button
                  onClick={() => setConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
                  className={clsx(
                    "relative w-10 h-5 rounded-full transition-colors",
                    config.enabled ? "bg-primary-500" : "bg-gray-300"
                  )}
                >
                  <span className={clsx(
                    "absolute left-0 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                    config.enabled ? "translate-x-5" : "translate-x-0.5"
                  )} />
                </button>
              </label>
            </div>
            <p className="text-xs text-gray-500 mb-5">{t("settings.businessHoursDesc")}</p>

            {config.enabled && (
              <div className="space-y-5">
                {/* Timezone */}
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.timezone")}</label>
                  <select
                    value={config.timezone}
                    onChange={(e) => setConfig((prev) => ({ ...prev, timezone: e.target.value }))}
                    className="w-full max-w-xs text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>

                {/* Schedule */}
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-3">{t("settings.schedule")}</label>
                  <div className="space-y-2">
                    {DAYS.map((day) => {
                      const dayConfig = config.schedule[day] || { enabled: false };
                      return (
                        <div key={day} className="flex items-center gap-3 py-2 px-3 rounded-xl bg-gray-50">
                          {/* Day toggle */}
                          <button
                            onClick={() => updateDay(day, "enabled", !dayConfig.enabled)}
                            className={clsx(
                              "relative w-9 h-5 rounded-full transition-colors shrink-0",
                              dayConfig.enabled ? "bg-primary-500" : "bg-gray-300"
                            )}
                          >
                            <span className={clsx(
                              "absolute left-0 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                              dayConfig.enabled ? "translate-x-4" : "translate-x-0.5"
                            )} />
                          </button>
                          {/* Day name */}
                          <span className={clsx(
                            "text-sm w-28 shrink-0",
                            dayConfig.enabled ? "text-gray-900 font-medium" : "text-gray-400"
                          )}>
                            {t(`settings.days.${day}`)}
                          </span>
                          {/* Time pickers */}
                          {dayConfig.enabled ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="time"
                                value={dayConfig.open || "09:00"}
                                onChange={(e) => updateDay(day, "open", e.target.value)}
                                className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                              />
                              <span className="text-xs text-gray-400">—</span>
                              <input
                                type="time"
                                value={dayConfig.close || "18:00"}
                                onChange={(e) => updateDay(day, "close", e.target.value)}
                                className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                              />
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400 italic">Closed</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Auto-Response */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-1">{t("settings.autoResponse")}</h2>
            <p className="text-xs text-gray-500 mb-4">{t("settings.autoResponseDesc")}</p>
            <textarea
              value={config.autoResponse}
              onChange={(e) => setConfig((prev) => ({ ...prev, autoResponse: e.target.value }))}
              placeholder={t("settings.autoResponsePlaceholder")}
              rows={3}
              className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
            />
          </div>

          {/* Auto-Greeting */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-1">{t("settings.autoGreeting")}</h2>
            <p className="text-xs text-gray-500 mb-4">{t("settings.autoGreetingDesc")}</p>
            <textarea
              value={greetingTemplate}
              onChange={(e) => setGreetingTemplate(e.target.value)}
              placeholder={t("settings.autoGreetingPlaceholder")}
              rows={3}
              className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
            />
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2.5 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition font-medium text-sm disabled:opacity-40"
            >
              {saving ? t("common.loading") : t("settings.save")}
            </button>
          </div>
        </>
      )}
    </div>
    </AppLayout>
  );
}
