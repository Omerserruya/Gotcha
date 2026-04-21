"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";

const CONFIG_URL = "/api/ai-assist/voice-copilot/config";

interface SttConfig {
  provider: "stub" | "google";
  language: string;
  interimResults: boolean;
  speakerSeparation: boolean;
  hasApiKey?: boolean;
  apiKeyLastFour?: string;
}

export function SttConfigPanel() {
  const { token } = useAuth();
  const { t } = useI18n();

  const [provider, setProvider] = useState<"stub" | "google">("stub");
  const [apiKey, setApiKey] = useState("");
  const [language, setLanguage] = useState("he-IL");
  const [interimResults, setInterimResults] = useState(false);
  const [lastFour, setLastFour] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    fetch(CONFIG_URL, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const stt: SttConfig = data?.stt ?? {};
        setProvider(stt.provider ?? "stub");
        setLanguage(stt.language ?? "he-IL");
        setInterimResults(stt.interimResults ?? false);
        setLastFour(stt.apiKeyLastFour ?? null);
      })
      .catch(() => setError(t("settings.voiceCopilot.errors.loadFailed")))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        stt: { provider, language, interimResults, speakerSeparation: true },
      };
      if (apiKey) body.stt = { ...(body.stt as object), apiKey };

      const res = await fetch(CONFIG_URL, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLastFour(data?.stt?.apiKeyLastFour ?? lastFour);
      setApiKey("");
      setSavedAt(Date.now());
    } catch {
      setError(t("settings.voiceCopilot.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-gray-500 py-8 text-center">
        {t("app.loading")}
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      {error && (
        <div className="px-4 py-2 text-sm bg-red-50 border border-red-200 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      {/* Provider */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t("settings.voiceCopilot.stt.provider")}
        </label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as "stub" | "google")}
          className="w-full max-w-xs border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          <option value="stub">
            {t("settings.voiceCopilot.stt.providerStub")}
          </option>
          <option value="google" disabled>
            {t("settings.voiceCopilot.stt.providerGoogle")}
          </option>
        </select>
      </div>

      {/* API Key */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t("settings.voiceCopilot.stt.apiKey")}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            lastFour
              ? t("settings.voiceCopilot.stt.apiKeySaved", { last4: lastFour })
              : t("settings.voiceCopilot.stt.apiKeyPlaceholder")
          }
          className="w-full max-w-xs border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
      </div>

      {/* Language */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t("settings.voiceCopilot.stt.language")}
        </label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="w-full max-w-xs border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          <option value="he-IL">
            {t("settings.voiceCopilot.stt.languageHe")}
          </option>
          <option value="en-US">
            {t("settings.voiceCopilot.stt.languageEn")}
          </option>
        </select>
      </div>

      {/* Interim Results */}
      <div className="flex items-center gap-2">
        <input
          id="interimResults"
          type="checkbox"
          checked={interimResults}
          onChange={(e) => setInterimResults(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
        />
        <label htmlFor="interimResults" className="text-sm text-gray-700">
          {t("settings.voiceCopilot.stt.interimResults")}
        </label>
      </div>

      {/* Speaker Separation (always on, disabled) */}
      <div className="flex items-center gap-2">
        <input
          id="speakerSeparation"
          type="checkbox"
          checked
          disabled
          title={t("settings.voiceCopilot.stt.speakerSeparationTooltip")}
          className="h-4 w-4 rounded border-gray-300 text-violet-600 opacity-60 cursor-not-allowed"
        />
        <label
          htmlFor="speakerSeparation"
          className="text-sm text-gray-500 cursor-not-allowed"
          title={t("settings.voiceCopilot.stt.speakerSeparationTooltip")}
        >
          {t("settings.voiceCopilot.stt.speakerSeparation")}
        </label>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition disabled:opacity-50"
        >
          {saving
            ? t("settings.voiceCopilot.stt.saving")
            : t("settings.voiceCopilot.stt.save")}
        </button>
        {savedAt && !saving && (
          <span className="text-xs text-green-600">
            {t("settings.voiceCopilot.stt.saved")}
          </span>
        )}
      </div>
    </form>
  );
}
