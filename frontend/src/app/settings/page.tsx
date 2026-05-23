"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { Locale, localeConfig } from "@/i18n";
import {
  getBusinessHours, updateBusinessHours,
  getAutoGreeting, updateAutoGreeting,
  getSlaSettings, updateSlaSettings,
  getIdleAutomation, updateIdleAutomation,
  getDepartments, getDepartmentSla, updateDepartmentSla,
  getTenantSettings, updateTenantSettings,
  changePassword as changePasswordApi,
} from "@/lib/api";
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
  const { t, locale, setLocale, tenantDefault, userOverride, setTenantDefault } = useI18n();
  const [localeSaving, setLocaleSaving] = useState(false);
  const [localeMessage, setLocaleMessage] = useState("");
  // We let users (including non-admin agents) pick their personal
  // language even when they can't see admin-only sections below.
  // The admin gate at the bottom of the page only hides admin
  // surfaces; the Language card is rendered above it.
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
  const [defaultCountryCode, setDefaultCountryCode] = useState<string>("IL");
  const [supportedCountries, setSupportedCountries] = useState<Array<{ code: string; callingCode: string }>>([]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const [data, greetingData, slaData, idleData, deptData, tenantSettings] = await Promise.all([
        getBusinessHours(token),
        getAutoGreeting(token).catch(() => ({ template: "" })),
        getSlaSettings(token).catch(() => DEFAULT_SLA),
        getIdleAutomation(token).catch(() => DEFAULT_IDLE),
        getDepartments(token).catch(() => []),
        getTenantSettings(token).catch(() => ({ data: { defaultCountryCode: "IL", supportedCountries: [] } })),
      ]);
      setConfig(data);
      setGreetingTemplate(greetingData.template || "");
      setSlaConfig(slaData);
      setIdleConfig(idleData);
      setDefaultCountryCode(tenantSettings.data?.defaultCountryCode ?? "IL");
      setSupportedCountries(tenantSettings.data?.supportedCountries ?? []);
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
        updateTenantSettings(token, { defaultCountryCode }),
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

  async function handleChangePassword() {
    if (!token) return;
    if (newPassword !== confirmPassword) {
      setPasswordError(t("settings.password.errMismatch"));
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError(t("settings.password.errTooShort"));
      return;
    }
    setChangingPassword(true);
    setPasswordError("");
    setPasswordMessage("");
    try {
      await changePasswordApi(token, currentPassword, newPassword);
      setPasswordMessage(t("settings.password.changed"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setPasswordError(err.message || t("settings.password.errFail"));
    } finally {
      setChangingPassword(false);
      setTimeout(() => { setPasswordMessage(""); setPasswordError(""); }, 5000);
    }
  }

  const handleAgentLocale = useCallback(
    async (value: string) => {
      setLocaleSaving(true);
      setLocaleMessage("");
      try {
        // "system" collapses to NULL → inherit the tenant default.
        const next: Locale | null = value === "system" ? null : (value as Locale);
        await setLocale(next);
        setLocaleMessage(t("settings.language.saved"));
      } catch {
        setLocaleMessage(t("settings.language.saveFailed"));
      } finally {
        setLocaleSaving(false);
        setTimeout(() => setLocaleMessage(""), 3000);
      }
    },
    [setLocale, t],
  );

  const handleTenantLocale = useCallback(
    async (value: string) => {
      setLocaleSaving(true);
      setLocaleMessage("");
      try {
        await setTenantDefault(value as Locale);
        setLocaleMessage(t("settings.language.savedTenant"));
      } catch {
        setLocaleMessage(t("settings.language.saveFailed"));
      } finally {
        setLocaleSaving(false);
        setTimeout(() => setLocaleMessage(""), 3000);
      }
    },
    [setTenantDefault, t],
  );

  // Language card — shown to EVERY user (including non-admin agents).
  // Tenant-default row is admin-only inside the card; agents see only
  // their personal override row.
  const languageCard = (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
      <h2 className="font-semibold text-gray-900">{t("settings.language.title")}</h2>
      <p className="text-xs text-gray-500 mt-1">{t("settings.language.subtitle")}</p>

      {localeMessage && (
        <div className="mt-3 bg-emerald-50 text-emerald-700 text-xs px-3 py-2 rounded-lg border border-emerald-200">
          {localeMessage}
        </div>
      )}

      <div className="mt-4 space-y-4">
        {/* Per-agent override (everyone) */}
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">
            {t("settings.language.myLanguage")}
          </label>
          <select
            value={userOverride ?? "system"}
            onChange={(e) => handleAgentLocale(e.target.value)}
            disabled={localeSaving}
            className="w-full sm:max-w-xs text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white disabled:opacity-50"
          >
            <option value="system">
              {t("settings.language.useTenantDefault")}
              {tenantDefault ? ` (${localeConfig[tenantDefault]?.label ?? tenantDefault})` : ""}
            </option>
            {Object.entries(localeConfig).map(([key, config]) => (
              <option key={key} value={key}>
                {config.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-gray-400 mt-1">
            {t("settings.language.myLanguageHint")
              .replace("{effective}", localeConfig[locale]?.label ?? locale)}
          </p>
        </div>

        {/* Tenant default (admin only) */}
        {user?.role === "ADMIN" && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              {t("settings.language.tenantDefault")}
            </label>
            <select
              value={tenantDefault ?? "en"}
              onChange={(e) => handleTenantLocale(e.target.value)}
              disabled={localeSaving}
              className="w-full sm:max-w-xs text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white disabled:opacity-50"
            >
              {Object.entries(localeConfig).map(([key, config]) => (
                <option key={key} value={key}>
                  {config.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-gray-400 mt-1">
              {t("settings.language.tenantDefaultHint")}
            </p>
          </div>
        )}
      </div>
    </div>
  );

  if (user?.role !== "ADMIN") {
    // Non-admins see ONLY the language card. Other admin surfaces
    // (SLA, business hours, etc.) remain hidden behind this gate.
    return (
      <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-8 overflow-y-auto h-full pb-20">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 ">{t("settings.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("settings.personalSubtitle")}</p>
        </div>
        {languageCard}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-8 overflow-y-auto h-full pb-20">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 ">{t("settings.title")}</h1>
        <p className="text-sm text-gray-500 mt-1">{t("settings.subtitle")}</p>
      </div>

      {languageCard}

      {/* AI Guardrails — quick links to the F8 policy + F4 tool gate admin surfaces. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <a
          href="/settings/policy"
          className="group bg-white border border-gray-200 hover:border-violet-300 hover:shadow-subtle rounded-2xl p-4 transition block"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 group-hover:text-violet-700">{t("settings.policy.title")}</div>
              <div className="text-xs text-gray-500">{t("settings.policy.cardHint")}</div>
            </div>
          </div>
        </a>
        <a
          href="/settings/tools"
          className="group bg-white border border-gray-200 hover:border-violet-300 hover:shadow-subtle rounded-2xl p-4 transition block"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 group-hover:text-violet-700">{t("settings.tools.title")}</div>
              <div className="text-xs text-gray-500">{t("settings.tools.cardHint")}</div>
            </div>
          </div>
        </a>
      </div>

      {/* Toast message */}
      {message && (
        <div className="bg-green-50 text-green-700 text-sm px-4 py-2.5 rounded-xl border border-green-200">
          {message}
        </div>
      )}

      {/* Default phone country — used to E.164-normalize bare phone
          numbers ("0501234567" → "+972501234567") when materializing
          broadcast recipients. */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
        <h2 className="font-semibold text-gray-900">{t("settings.phoneCountry")}</h2>
        <p className="text-xs text-gray-500 mt-1">{t("settings.phoneCountryHelp")}</p>
        <div className="mt-3 max-w-xs">
          <select
            value={defaultCountryCode}
            onChange={(e) => setDefaultCountryCode(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white"
          >
            {supportedCountries.length === 0 && (
              <option value={defaultCountryCode}>{defaultCountryCode}</option>
            )}
            {supportedCountries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} (+{c.callingCode})
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* SLA Settings */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
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
                        className="w-full sm:w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
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
                        className="w-full sm:w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
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
                            <div key={dept.id} className="flex flex-wrap items-center gap-2 md:gap-3 py-2 px-3 rounded-xl bg-gray-50">
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
                              <span className={clsx("text-sm w-full sm:w-32 shrink-0", dSla.enabled ? "text-gray-900 font-medium" : "text-gray-400")}>
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
                                    className="w-full sm:w-20 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                                  />
                                  <span className="text-xs text-gray-400">{t("settings.minutes")}</span>
                                </div>
                              ) : (
                                <span className="text-xs text-gray-400 italic">
                                  {slaConfig.slaMinutes} {t("settings.minutes")} ({t("settings.defaultLabel")})
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
          <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
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
                          className="w-full sm:w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
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
                          className="w-full sm:w-24 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
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
          <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
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
                    className="w-full sm:max-w-xs text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
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
                        <div key={day} className="flex flex-wrap items-center gap-2 md:gap-3 py-2 px-3 rounded-xl bg-gray-50">
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
                            <span className="text-xs text-gray-400 italic">{t("settings.closed")}</span>
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
          <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
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
          <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
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

          {/* Change Password */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
            <h2 className="font-semibold text-gray-900 mb-1">{t("settings.password.title")}</h2>
            <p className="text-xs text-gray-500 mb-5">{t("settings.password.subtitle")}</p>

            {passwordMessage && (
              <div className="bg-green-50 text-green-700 text-sm px-4 py-2.5 rounded-xl border border-green-200 mb-4">
                {passwordMessage}
              </div>
            )}
            {passwordError && (
              <div className="bg-red-50 text-red-700 text-sm px-4 py-2.5 rounded-xl border border-red-200 mb-4">
                {passwordError}
              </div>
            )}

            <div className="space-y-4 max-w-md">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.password.current")}</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
                  placeholder={t("settings.password.currentPlaceholder")}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.password.new")}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
                  placeholder={t("settings.password.newPlaceholder")}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">{t("settings.password.confirm")}</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-300"
                  placeholder={t("settings.password.confirmPlaceholder")}
                />
              </div>
              <button
                onClick={handleChangePassword}
                disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
                className="px-5 py-2.5 min-h-[44px] bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition font-medium text-sm disabled:opacity-40"
              >
                {changingPassword ? t("settings.password.changing") : t("settings.password.action")}
              </button>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2.5 min-h-[44px] bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition font-medium text-sm disabled:opacity-40"
            >
              {saving ? t("common.loading") : t("settings.save")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
