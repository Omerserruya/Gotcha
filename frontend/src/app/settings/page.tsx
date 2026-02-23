"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getBusinessHours, updateBusinessHours,
  getAutoGreeting, updateAutoGreeting,
  getSlaSettings, updateSlaSettings,
  getIdleAutomation, updateIdleAutomation,
  getDepartments, getDepartmentSla, updateDepartmentSla,
} from "@/lib/api";
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

interface SlaConfig {
  enabled: boolean;
  slaMinutes: number;
  warningThreshold: number;
}

interface IdleAutomationConfig {
  reminderEnabled: boolean;
  reminderDelayMinutes: number;
  reminderMessage: string;
  autoCloseEnabled: boolean;
  autoCloseDelayMinutes: number;
  autoCloseMessage: string;
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

const DEFAULT_SLA: SlaConfig = {
  enabled: false,
  slaMinutes: 30,
  warningThreshold: 70,
};

const DEFAULT_IDLE: IdleAutomationConfig = {
  reminderEnabled: false,
  reminderDelayMinutes: 60,
  reminderMessage: "Hi! We're still here and waiting for your response. Is there anything else we can help you with?",
  autoCloseEnabled: false,
  autoCloseDelayMinutes: 1440,
  autoCloseMessage: "Due to the lack of response, this conversation has been closed. Feel free to reach out again anytime!",
};

export default function SettingsPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const [config, setConfig] = useState<BusinessHoursConfig>(DEFAULT_CONFIG);
  const [slaConfig, setSlaConfig] = useState<SlaConfig>(DEFAULT_SLA);
  const [idleConfig, setIdleConfig] = useState<IdleAutomationConfig>(DEFAULT_IDLE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [greetingTemplate, setGreetingTemplate] = useState("");
  const [departments, setDepartments] = useState<any[]>([]);
  const [deptSlaMap, setDeptSlaMap] = useState<Record<string, SlaConfig>>({});
  const [showDeptSla, setShowDeptSla] = useState(false);

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const [data, greetingData, slaData, idleData, deptData] = await Promise.all([
        getBusinessHours(token),
        getAutoGreeting(token).catch(() => ({ template: "" })),
        getSlaSettings(token).catch(() => DEFAULT_SLA),
        getIdleAutomation(token).catch(() => DEFAULT_IDLE),
        getDepartments(token).catch(() => []),
      ]);
      setConfig(data);
      setGreetingTemplate(greetingData.template || "");
      setSlaConfig(slaData);
      setIdleConfig(idleData);
      const deptList = Array.isArray(deptData) ? deptData : (deptData as any)?.data || [];
      setDepartments(deptList);

      // Fetch department SLA overrides
      if (deptList.length > 0) {
        const deptSlaResults = await Promise.all(
          deptList.map((d: any) => getDepartmentSla(token, d.id).catch(() => ({ enabled: false, slaMinutes: null, warningThreshold: null })))
        );
        const map: Record<string, SlaConfig> = {};
        deptList.forEach((d: any, i: number) => {
          map[d.id] = deptSlaResults[i];
        });
        setDeptSlaMap(map);
      }
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
      const promises: Promise<any>[] = [
        updateBusinessHours(token, config),
        updateAutoGreeting(token, greetingTemplate),
        updateSlaSettings(token, slaConfig),
        updateIdleAutomation(token, idleConfig),
      ];

      // Save department SLA overrides
      for (const dept of departments) {
        const deptSla = deptSlaMap[dept.id];
        if (deptSla) {
          promises.push(updateDepartmentSla(token, dept.id, deptSla));
        }
      }

      await Promise.all(promises);
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

  function updateDeptSla(deptId: string, field: string, value: any) {
    setDeptSlaMap((prev) => ({
      ...prev,
      [deptId]: { ...prev[deptId], [field]: value },
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
    <div className="max-w-4xl mx-auto p-6 space-y-8 overflow-y-auto h-screen pb-20">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 ">{t("settings.title")}</h1>
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
          {/* SLA Settings */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-gray-900">{t("settings.sla")}</h2>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500">{t("settings.slaEnabled")}</span>
                <button
                  onClick={() => setSlaConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
                  className={clsx(
                    "relative w-10 h-5 rounded-full transition-colors",
                    slaConfig.enabled ? "bg-primary-500" : "bg-gray-300"
                  )}
                >
                  <span className={clsx(
                    "absolute left-0 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                    slaConfig.enabled ? "translate-x-5" : "translate-x-0.5"
                  )} />
                </button>
              </label>
            </div>
            <p className="text-xs text-gray-500 mb-5">{t("settings.slaDesc")}</p>

            {slaConfig.enabled && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.slaMinutes")}</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={slaConfig.slaMinutes}
                        onChange={(e) => setSlaConfig((prev) => ({ ...prev, slaMinutes: parseInt(e.target.value) || 30 }))}
                        className="w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      />
                      <span className="text-xs text-gray-400">{t("settings.minutes")}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.slaWarning")}</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={10}
                        max={100}
                        value={slaConfig.warningThreshold}
                        onChange={(e) => setSlaConfig((prev) => ({ ...prev, warningThreshold: parseInt(e.target.value) || 70 }))}
                        className="w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      />
                      <span className="text-xs text-gray-400">%</span>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1">{t("settings.slaWarningDesc")}</p>
                  </div>
                </div>

                {/* Department overrides */}
                {departments.length > 0 && (
                  <div className="mt-4">
                    <button
                      onClick={() => setShowDeptSla(!showDeptSla)}
                      className="text-xs font-medium text-primary-600 hover:text-primary-700 transition flex items-center gap-1"
                    >
                      <svg className={clsx("w-3 h-3 transition-transform", showDeptSla && "rotate-90")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                      {t("settings.slaDepartmentOverride")} ({departments.length})
                    </button>
                    {showDeptSla && (
                      <div className="mt-3 space-y-2">
                        <p className="text-[10px] text-gray-400">{t("settings.slaDepartmentOverrideDesc")}</p>
                        {departments.map((dept: any) => {
                          const dSla = deptSlaMap[dept.id] || { enabled: false, slaMinutes: slaConfig.slaMinutes, warningThreshold: slaConfig.warningThreshold };
                          return (
                            <div key={dept.id} className="flex items-center gap-3 py-2 px-3 rounded-xl bg-gray-50">
                              <button
                                onClick={() => updateDeptSla(dept.id, "enabled", !dSla.enabled)}
                                className={clsx(
                                  "relative w-9 h-5 rounded-full transition-colors shrink-0",
                                  dSla.enabled ? "bg-primary-500" : "bg-gray-300"
                                )}
                              >
                                <span className={clsx(
                                  "absolute left-0 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                                  dSla.enabled ? "translate-x-4" : "translate-x-0.5"
                                )} />
                              </button>
                              <span className={clsx("text-sm w-32 shrink-0", dSla.enabled ? "text-gray-900 font-medium" : "text-gray-400")}>
                                {dept.name}
                              </span>
                              {dSla.enabled ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="number"
                                    min={1}
                                    max={1440}
                                    value={dSla.slaMinutes ?? slaConfig.slaMinutes}
                                    onChange={(e) => updateDeptSla(dept.id, "slaMinutes", parseInt(e.target.value) || 30)}
                                    className="w-20 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                                  />
                                  <span className="text-xs text-gray-400">{t("settings.minutes")}</span>
                                </div>
                              ) : (
                                <span className="text-xs text-gray-400 italic">
                                  {slaConfig.slaMinutes} {t("settings.minutes")} (default)
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Idle Conversation Automation */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-900 mb-1">{t("settings.idleAutomation")}</h2>
            <p className="text-xs text-gray-500 mb-5">{t("settings.idleAutomationDesc")}</p>

            <div className="space-y-6">
              {/* Auto-Reminder */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-800">{t("settings.reminderEnabled")}</h3>
                  <button
                    onClick={() => setIdleConfig((prev) => ({ ...prev, reminderEnabled: !prev.reminderEnabled }))}
                    className={clsx(
                      "relative w-10 h-5 rounded-full transition-colors",
                      idleConfig.reminderEnabled ? "bg-primary-500" : "bg-gray-300"
                    )}
                  >
                    <span className={clsx(
                      "absolute left-0 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                      idleConfig.reminderEnabled ? "translate-x-5" : "translate-x-0.5"
                    )} />
                  </button>
                </div>

                {idleConfig.reminderEnabled && (
                  <div className="ps-0 space-y-3">
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.reminderDelay")}</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={10080}
                          value={idleConfig.reminderDelayMinutes}
                          onChange={(e) => setIdleConfig((prev) => ({ ...prev, reminderDelayMinutes: parseInt(e.target.value) || 60 }))}
                          className="w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                        />
                        <span className="text-xs text-gray-400">{t("settings.minutes")}</span>
                      </div>
                      <p className="text-[10px] text-gray-400 mt-1">{t("settings.reminderDelayDesc")}</p>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.reminderMessage")}</label>
                      <textarea
                        value={idleConfig.reminderMessage}
                        onChange={(e) => setIdleConfig((prev) => ({ ...prev, reminderMessage: e.target.value }))}
                        placeholder={t("settings.reminderMessagePlaceholder")}
                        rows={2}
                        className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
                      />
                    </div>
                  </div>
                )}
              </div>

              <hr className="border-gray-100" />

              {/* Auto-Close */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-800">{t("settings.autoCloseEnabled")}</h3>
                  <button
                    onClick={() => setIdleConfig((prev) => ({ ...prev, autoCloseEnabled: !prev.autoCloseEnabled }))}
                    className={clsx(
                      "relative w-10 h-5 rounded-full transition-colors",
                      idleConfig.autoCloseEnabled ? "bg-primary-500" : "bg-gray-300"
                    )}
                  >
                    <span className={clsx(
                      "absolute left-0 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                      idleConfig.autoCloseEnabled ? "translate-x-5" : "translate-x-0.5"
                    )} />
                  </button>
                </div>

                {idleConfig.autoCloseEnabled && (
                  <div className="ps-0 space-y-3">
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.autoCloseDelay")}</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={10080}
                          value={idleConfig.autoCloseDelayMinutes}
                          onChange={(e) => setIdleConfig((prev) => ({ ...prev, autoCloseDelayMinutes: parseInt(e.target.value) || 1440 }))}
                          className="w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                        />
                        <span className="text-xs text-gray-400">{t("settings.minutes")}</span>
                      </div>
                      <p className="text-[10px] text-gray-400 mt-1">{t("settings.autoCloseDelayDesc")}</p>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.autoCloseMessage")}</label>
                      <textarea
                        value={idleConfig.autoCloseMessage}
                        onChange={(e) => setIdleConfig((prev) => ({ ...prev, autoCloseMessage: e.target.value }))}
                        placeholder={t("settings.autoCloseMessagePlaceholder")}
                        rows={2}
                        className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

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
