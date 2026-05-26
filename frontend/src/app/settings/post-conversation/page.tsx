"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getPostConversationConfig,
  updatePostConversationConfig,
  type PostConversationConfig,
  type SummaryFieldDef,
  type TaskRule,
  type CrmRule,
} from "@/lib/gotcha-api";

/**
 * Settings page for the per-tenant Post-Conversation schema.
 *
 * Drives three sections:
 *   1. Summary fields  — extra CRM slots the LLM should try to populate at
 *      end of call/chat. Fed into the summarizer prompt as allowed keys.
 *   2. Task rules      — "if AI sees X, create task Y" (intent + keyword
 *      triggers). Applied by the rule engine after summarization.
 *   3. CRM rules       — "if AI sees X, patch CRM field Y" (e.g. set status
 *      to qualified on ready_to_buy intent).
 *
 * Spec: sparse-patch semantics. Rules ADD to the AI-proposed crm_patch and
 * task list — they never wipe prior CRM data. Keys not in `summaryFields`
 * and not in the built-in set will be dropped by the summarizer.
 */

const EMPTY: PostConversationConfig = { summaryFields: [], taskRules: [], crmRules: [] };

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return Math.random().toString(36).slice(2, 10);
}

export default function PostConversationSettingsPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [config, setConfig] = useState<PostConversationConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await getPostConversationConfig(token);
        setConfig(res.config ?? EMPTY);
      } catch (e: any) {
        setError(e?.message ?? t("postConvSettings.loadFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [token, t]);

  function mutate(next: PostConversationConfig) {
    setConfig(next);
    setDirty(true);
  }

  async function save() {
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      const res = await updatePostConversationConfig(token, config);
      setConfig(res.config ?? EMPTY);
      setDirty(false);
      setToast(t("postConvSettings.saved"));
      setTimeout(() => setToast(null), 2000);
    } catch (e: any) {
      setError(e?.message ?? t("postConvSettings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!token) return null;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4 max-w-4xl">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{t("postConvSettings.title")}</h1>
          <p className="text-xs text-gray-500 mt-1">
            {t("postConvSettings.subtitle")}
          </p>
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className={clsx(
            "px-4 py-2 rounded-lg text-sm font-medium transition shadow-sm",
            dirty && !saving
              ? "bg-violet-600 text-white hover:bg-violet-700"
              : "bg-gray-100 text-gray-400 cursor-not-allowed",
          )}
        >
          {saving ? t("postConvSettings.saving") : dirty ? t("postConvSettings.save") : t("postConvSettings.saved")}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg mb-4 max-w-4xl">
          {error}
        </div>
      )}
      {toast && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-2 rounded-lg mb-4 max-w-4xl">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl shadow-subtle p-6 text-sm text-gray-500 max-w-4xl">
          {t("postConvSettings.loading")}
        </div>
      ) : (
        <div className="space-y-6 max-w-4xl">
          <SummaryFieldsSection
            fields={config.summaryFields}
            onChange={(summaryFields) => mutate({ ...config, summaryFields })}
          />
          <TaskRulesSection
            rules={config.taskRules}
            onChange={(taskRules) => mutate({ ...config, taskRules })}
          />
          <CrmRulesSection
            rules={config.crmRules}
            onChange={(crmRules) => mutate({ ...config, crmRules })}
          />
        </div>
      )}
    </div>
  );
}

// ─── Summary fields ──────────────────────────────────────────

function SummaryFieldsSection({
  fields,
  onChange,
}: {
  fields: SummaryFieldDef[];
  onChange: (next: SummaryFieldDef[]) => void;
}) {
  const { t } = useI18n();
  function update(idx: number, patch: Partial<SummaryFieldDef>) {
    const next = fields.slice();
    next[idx] = { ...next[idx]!, ...patch };
    onChange(next);
  }
  function remove(idx: number) {
    onChange(fields.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...fields, { key: "", label: "" }]);
  }
  return (
    <section className="bg-white rounded-xl shadow-subtle p-5">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-gray-800">{t("postConvSettings.summary.title")}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {t("postConvSettings.summary.subtitle")}
        </p>
      </header>
      <div className="space-y-2">
        {fields.length === 0 && (
          <p className="text-xs text-gray-400 italic">{t("postConvSettings.summary.empty")}</p>
        )}
        {fields.map((f, idx) => (
          <div key={idx} className="grid grid-cols-12 gap-2 items-center">
            <input
              className="col-span-3 px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono"
              placeholder={t("postConvSettings.summary.keyPlaceholder")}
              value={f.key}
              onChange={(e) => update(idx, { key: e.target.value })}
            />
            <input
              className="col-span-3 px-3 py-2 border border-gray-200 rounded-lg text-sm"
              placeholder={t("postConvSettings.summary.labelPlaceholder")}
              value={f.label}
              onChange={(e) => update(idx, { label: e.target.value })}
            />
            <input
              className="col-span-5 px-3 py-2 border border-gray-200 rounded-lg text-sm"
              placeholder={t("postConvSettings.summary.descriptionPlaceholder")}
              value={f.description ?? ""}
              onChange={(e) => update(idx, { description: e.target.value })}
            />
            <button
              onClick={() => remove(idx)}
              className="col-span-1 text-gray-400 hover:text-red-600 text-sm"
              aria-label={t("postConvSettings.summary.remove")}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={add}
        className="mt-3 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg"
      >
        {t("postConvSettings.summary.add")}
      </button>
    </section>
  );
}

// ─── Task rules ──────────────────────────────────────────────

function TaskRulesSection({
  rules,
  onChange,
}: {
  rules: TaskRule[];
  onChange: (next: TaskRule[]) => void;
}) {
  const { t } = useI18n();
  function update(idx: number, patch: Partial<TaskRule>) {
    const next = rules.slice();
    next[idx] = { ...next[idx]!, ...patch };
    onChange(next);
  }
  function remove(idx: number) {
    onChange(rules.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([
      ...rules,
      { id: genId(), when: { intent: "" }, task: { subject: "", priority: "normal" } },
    ]);
  }
  return (
    <section className="bg-white rounded-xl shadow-subtle p-5">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-gray-800">{t("postConvSettings.taskRules.title")}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {t("postConvSettings.taskRules.subtitle")}
        </p>
      </header>
      <div className="space-y-3">
        {rules.length === 0 && (
          <p className="text-xs text-gray-400 italic">{t("postConvSettings.taskRules.empty")}</p>
        )}
        {rules.map((r, idx) => (
          <div key={r.id} className="border border-gray-200 rounded-lg p-3 space-y-2">
            <div className="grid grid-cols-12 gap-2 items-center">
              <span className="col-span-2 text-xs text-gray-500">{t("postConvSettings.taskRules.whenIntent")}</span>
              <input
                className="col-span-3 px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-mono"
                placeholder={t("postConvSettings.taskRules.intentPlaceholder")}
                value={r.when.intent ?? ""}
                onChange={(e) =>
                  update(idx, { when: { ...r.when, intent: e.target.value || undefined } })
                }
              />
              <span className="col-span-2 text-xs text-gray-500 text-right">{t("postConvSettings.taskRules.orKeywords")}</span>
              <input
                className="col-span-4 px-3 py-1.5 border border-gray-200 rounded-lg text-sm"
                placeholder={t("postConvSettings.taskRules.keywordsPlaceholder")}
                value={(r.when.keywords ?? []).join(", ")}
                onChange={(e) =>
                  update(idx, {
                    when: {
                      ...r.when,
                      keywords: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
              <button
                onClick={() => remove(idx)}
                className="col-span-1 text-gray-400 hover:text-red-600 text-sm"
                aria-label={t("postConvSettings.summary.remove")}
              >
                ×
              </button>
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <span className="col-span-2 text-xs text-gray-500">{t("postConvSettings.taskRules.createTask")}</span>
              <input
                className="col-span-6 px-3 py-1.5 border border-gray-200 rounded-lg text-sm"
                placeholder={t("postConvSettings.taskRules.subjectPlaceholder")}
                value={r.task.subject}
                onChange={(e) =>
                  update(idx, { task: { ...r.task, subject: e.target.value } })
                }
              />
              <select
                className="col-span-2 px-3 py-1.5 border border-gray-200 rounded-lg text-sm"
                value={r.task.priority ?? "normal"}
                onChange={(e) =>
                  update(idx, {
                    task: { ...r.task, priority: e.target.value as TaskRule["task"]["priority"] },
                  })
                }
              >
                <option value="low">{t("postConvSettings.taskRules.priorityLow")}</option>
                <option value="normal">{t("postConvSettings.taskRules.priorityNormal")}</option>
                <option value="high">{t("postConvSettings.taskRules.priorityHigh")}</option>
                <option value="urgent">{t("postConvSettings.taskRules.priorityUrgent")}</option>
              </select>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={add}
        className="mt-3 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg"
      >
        {t("postConvSettings.taskRules.add")}
      </button>
    </section>
  );
}

// ─── CRM rules ──────────────────────────────────────────────

function CrmRulesSection({
  rules,
  onChange,
}: {
  rules: CrmRule[];
  onChange: (next: CrmRule[]) => void;
}) {
  const { t } = useI18n();
  function update(idx: number, patch: Partial<CrmRule>) {
    const next = rules.slice();
    next[idx] = { ...next[idx]!, ...patch };
    onChange(next);
  }
  function remove(idx: number) {
    onChange(rules.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...rules, { id: genId(), when: { intent: "" }, patch: { status: "" } }]);
  }
  return (
    <section className="bg-white rounded-xl shadow-subtle p-5">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-gray-800">{t("postConvSettings.crmRules.title")}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {t("postConvSettings.crmRules.subtitle")}
        </p>
      </header>
      <div className="space-y-3">
        {rules.length === 0 && (
          <p className="text-xs text-gray-400 italic">{t("postConvSettings.crmRules.empty")}</p>
        )}
        {rules.map((r, idx) => (
          <div key={r.id} className="border border-gray-200 rounded-lg p-3 space-y-2">
            <div className="grid grid-cols-12 gap-2 items-center">
              <span className="col-span-2 text-xs text-gray-500">{t("postConvSettings.crmRules.whenIntent")}</span>
              <input
                className="col-span-4 px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-mono"
                placeholder={t("postConvSettings.crmRules.intentPlaceholder")}
                value={r.when.intent ?? ""}
                onChange={(e) =>
                  update(idx, { when: { ...r.when, intent: e.target.value || undefined } })
                }
              />
              <span className="col-span-2 text-xs text-gray-500 text-right">{t("postConvSettings.crmRules.sentiment")}</span>
              <select
                className="col-span-3 px-3 py-1.5 border border-gray-200 rounded-lg text-sm"
                value={r.when.sentiment ?? ""}
                onChange={(e) =>
                  update(idx, {
                    when: {
                      ...r.when,
                      sentiment: (e.target.value || undefined) as
                        | "positive"
                        | "neutral"
                        | "negative"
                        | "mixed"
                        | undefined,
                    },
                  })
                }
              >
                <option value="">{t("postConvSettings.crmRules.sentimentAny")}</option>
                <option value="positive">{t("postConvSettings.crmRules.sentimentPositive")}</option>
                <option value="neutral">{t("postConvSettings.crmRules.sentimentNeutral")}</option>
                <option value="negative">{t("postConvSettings.crmRules.sentimentNegative")}</option>
                <option value="mixed">{t("postConvSettings.crmRules.sentimentMixed")}</option>
              </select>
              <button
                onClick={() => remove(idx)}
                className="col-span-1 text-gray-400 hover:text-red-600 text-sm"
                aria-label={t("postConvSettings.summary.remove")}
              >
                ×
              </button>
            </div>
            <div className="grid grid-cols-12 gap-2 items-start">
              <span className="col-span-2 text-xs text-gray-500 pt-2">{t("postConvSettings.crmRules.patchJson")}</span>
              <textarea
                className="col-span-10 px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-mono"
                rows={2}
                value={JSON.stringify(r.patch, null, 0)}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value || "{}");
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                      update(idx, { patch: parsed });
                    }
                  } catch {
                    // ignore parse errors — user is mid-typing
                  }
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={add}
        className="mt-3 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg"
      >
        {t("postConvSettings.crmRules.add")}
      </button>
    </section>
  );
}
