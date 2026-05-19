"use client";

/**
 * Per-channel Live Call Copilot configuration.
 *
 * Drives the LLM behind /voice/[sessionId]:
 *   - language    → output language for cues/suggestions
 *   - persona     → tone/style applied to suggested actions
 *   - goals       → call objective the copilot biases toward
 *   - questions   → things the rep MUST ask (surface as missingFields)
 *   - dataFields  → things the call MUST collect (drives cues + summary)
 *
 * Persisted on `voice_channels.copilot_config` (JSONB) — see
 * `services/conversation/src/routes/voice-channels.ts` PUT
 * `/api/voice-channels/:id/copilot-config`.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getVoiceChannelCopilotConfig,
  updateVoiceChannelCopilotConfig,
  type CopilotConfig,
  type CopilotQuestion,
  type CopilotDataField,
} from "@/lib/api";
import clsx from "clsx";

const LANGUAGES: { code: string; label: string }[] = [
  { code: "", label: "—" },
  { code: "he", label: "עברית (Hebrew)" },
  { code: "en", label: "English" },
  { code: "ar", label: "العربية (Arabic)" },
  { code: "ru", label: "Русский (Russian)" },
  { code: "es", label: "Español (Spanish)" },
];

const EMPTY: CopilotConfig = { questions: [], dataFields: [] };

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function VoiceChannelCopilotConfigPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const channelId = params?.id;

  const [config, setConfig] = useState<CopilotConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !channelId) return;
    let cancelled = false;
    setLoading(true);
    getVoiceChannelCopilotConfig(token, channelId)
      .then((res) => {
        if (cancelled) return;
        const c = res.data || {};
        setConfig({
          language: c.language ?? "",
          persona: c.persona ?? "",
          goals: c.goals ?? "",
          questions: c.questions ?? [],
          dataFields: c.dataFields ?? [],
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed_to_load");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, channelId]);

  async function handleSave() {
    if (!token || !channelId) return;
    setSaving(true);
    setError(null);
    try {
      // Normalize empty strings to undefined so the server stores `{}` shape.
      const payload: CopilotConfig = {
        language: config.language?.trim() || undefined,
        persona: config.persona?.trim() || undefined,
        goals: config.goals?.trim() || undefined,
        questions: config.questions.filter((q) => q.text.trim()),
        dataFields: config.dataFields.filter((f) => f.field.trim() && f.label.trim()),
      };
      await updateVoiceChannelCopilotConfig(token, channelId, payload);
      setToast(t("settings.voiceCopilotConfig.saved"));
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed_to_save");
    } finally {
      setSaving(false);
    }
  }

  function addQuestion() {
    setConfig((c) => ({ ...c, questions: [...c.questions, { id: genId(), text: "", required: false }] }));
  }
  function updateQuestion(i: number, patch: Partial<CopilotQuestion>) {
    setConfig((c) => ({ ...c, questions: c.questions.map((q, idx) => (idx === i ? { ...q, ...patch } : q)) }));
  }
  function removeQuestion(i: number) {
    setConfig((c) => ({ ...c, questions: c.questions.filter((_, idx) => idx !== i) }));
  }

  function addField() {
    setConfig((c) => ({ ...c, dataFields: [...c.dataFields, { field: "", label: "", required: false }] }));
  }
  function updateField(i: number, patch: Partial<CopilotDataField>) {
    setConfig((c) => ({ ...c, dataFields: c.dataFields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) }));
  }
  function removeField(i: number) {
    setConfig((c) => ({ ...c, dataFields: c.dataFields.filter((_, idx) => idx !== i) }));
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-8 px-4 text-sm text-gray-500">
        {t("settings.voiceCopilotConfig.loading")}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-6 px-4">
      <div className="mb-5">
        <Link href={`/settings/voice-channels/${channelId}`} className="text-xs text-primary-600 hover:underline">
          ← {t("settings.voiceCopilotConfig.backToChannel")}
        </Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">
          {t("settings.voiceCopilotConfig.title")}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {t("settings.voiceCopilotConfig.subtitle")}
        </p>
      </div>

      {error && (
        <div className="mb-4 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {toast && (
        <div className="mb-4 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {toast}
        </div>
      )}

      {/* Language */}
      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">
          {t("settings.voiceCopilotConfig.languageLabel")}
        </h2>
        <p className="text-xs text-gray-500 mb-3">{t("settings.voiceCopilotConfig.languageHint")}</p>
        <select
          value={config.language ?? ""}
          onChange={(e) => setConfig((c) => ({ ...c, language: e.target.value }))}
          className="w-full md:w-64 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </section>

      {/* Persona */}
      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">
          {t("settings.voiceCopilotConfig.personaLabel")}
        </h2>
        <p className="text-xs text-gray-500 mb-3">{t("settings.voiceCopilotConfig.personaHint")}</p>
        <input
          type="text"
          value={config.persona ?? ""}
          onChange={(e) => setConfig((c) => ({ ...c, persona: e.target.value }))}
          placeholder={t("settings.voiceCopilotConfig.personaPlaceholder")}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
        />
      </section>

      {/* Goals */}
      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">
          {t("settings.voiceCopilotConfig.goalsLabel")}
        </h2>
        <p className="text-xs text-gray-500 mb-3">{t("settings.voiceCopilotConfig.goalsHint")}</p>
        <textarea
          rows={3}
          value={config.goals ?? ""}
          onChange={(e) => setConfig((c) => ({ ...c, goals: e.target.value }))}
          placeholder={t("settings.voiceCopilotConfig.goalsPlaceholder")}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300 resize-none"
        />
      </section>

      {/* Questions */}
      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">
            {t("settings.voiceCopilotConfig.questionsLabel")}
          </h2>
          <button
            type="button"
            onClick={addQuestion}
            className="text-xs px-2 py-1 rounded-md bg-primary-50 text-primary-700 ring-1 ring-primary-200 hover:bg-primary-100"
          >
            + {t("settings.voiceCopilotConfig.addQuestion")}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">{t("settings.voiceCopilotConfig.questionsHint")}</p>
        {config.questions.length === 0 && (
          <p className="text-xs text-gray-400 italic">{t("settings.voiceCopilotConfig.emptyQuestions")}</p>
        )}
        <div className="space-y-2">
          {config.questions.map((q, i) => (
            <div key={q.id} className="flex items-center gap-2">
              <input
                type="text"
                value={q.text}
                onChange={(e) => updateQuestion(i, { text: e.target.value })}
                placeholder={t("settings.voiceCopilotConfig.questionPlaceholder")}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
              />
              <label className="text-xs text-gray-600 inline-flex items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={q.required}
                  onChange={(e) => updateQuestion(i, { required: e.target.checked })}
                />
                {t("settings.voiceCopilotConfig.required")}
              </label>
              <button
                type="button"
                onClick={() => removeQuestion(i)}
                className="text-xs text-red-600 hover:underline px-2"
              >
                {t("settings.voiceCopilotConfig.remove")}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Data fields */}
      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">
            {t("settings.voiceCopilotConfig.dataFieldsLabel")}
          </h2>
          <button
            type="button"
            onClick={addField}
            className="text-xs px-2 py-1 rounded-md bg-primary-50 text-primary-700 ring-1 ring-primary-200 hover:bg-primary-100"
          >
            + {t("settings.voiceCopilotConfig.addField")}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">{t("settings.voiceCopilotConfig.dataFieldsHint")}</p>
        {config.dataFields.length === 0 && (
          <p className="text-xs text-gray-400 italic">{t("settings.voiceCopilotConfig.emptyFields")}</p>
        )}
        <div className="space-y-2">
          {config.dataFields.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={f.field}
                onChange={(e) => updateField(i, { field: e.target.value })}
                placeholder={t("settings.voiceCopilotConfig.fieldKeyPlaceholder")}
                className="w-40 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
              />
              <input
                type="text"
                value={f.label}
                onChange={(e) => updateField(i, { label: e.target.value })}
                placeholder={t("settings.voiceCopilotConfig.fieldLabelPlaceholder")}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
              />
              <label className="text-xs text-gray-600 inline-flex items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => updateField(i, { required: e.target.checked })}
                />
                {t("settings.voiceCopilotConfig.required")}
              </label>
              <button
                type="button"
                onClick={() => removeField(i)}
                className="text-xs text-red-600 hover:underline px-2"
              >
                {t("settings.voiceCopilotConfig.remove")}
              </button>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => router.push(`/settings/voice-channels/${channelId}`)}
          className="px-4 py-2 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
        >
          {t("settings.voiceCopilotConfig.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={clsx(
            "px-4 py-2 text-sm font-semibold rounded-lg transition",
            saving ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-primary-600 text-white hover:bg-primary-700",
          )}
        >
          {saving ? t("settings.voiceCopilotConfig.saving") : t("settings.voiceCopilotConfig.save")}
        </button>
      </div>
    </div>
  );
}
