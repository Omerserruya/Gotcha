"use client";

/**
 * Per-funnel editor with stage cards.
 *
 * Each stage card lets an admin author:
 *   - Basic info: id, label, baseStage (anchor), crmValue (vendor mapping)
 *   - Copilot: goal, required questions, required data fields,
 *     exit criteria (must-have fields, must-ask questions, positive/
 *     negative signals), and explicit nextStageId.
 *
 * The whole funnel is PATCHed atomically - the backend re-validates
 * shape and invalidates the in-process cache so BEL picks up changes
 * within ~1 request.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDynamicParam } from "@/lib/useRouteParam";
import { useAuth } from "@/context/AuthContext";
import { usePermissions } from "@/context/PermissionsContext";
import { useI18n } from "@/context/I18nContext";
import {
  getFunnel,
  updateFunnel,
  type FunnelRow,
  type FunnelStage,
  type StageCopilotConfig,
  type ConversationStage,
} from "@/lib/api-funnel";
import clsx from "clsx";

const BASE_STAGES: ConversationStage[] = [
  "initial",
  "exploration",
  "objection",
  "decision",
  "support",
];

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "field";
}

function humanize(s: string): string {
  const parts = s.replace(/[_\-]+/g, " ").trim().split(/\s+/);
  if (parts.length === 0) return s;
  return parts
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

export default function FunnelEditorPage() {
  const { token, user } = useAuth();
  const { atLeastRole } = usePermissions();
  const { t } = useI18n();
  const router = useRouter();
  const funnelDbId = useDynamicParam();

  const [funnel, setFunnel] = useState<FunnelRow | null>(null);
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !funnelDbId) return;
    let cancelled = false;
    setLoading(true);
    getFunnel(token, funnelDbId)
      .then((r) => {
        if (cancelled) return;
        setFunnel(r.data);
        setStages(r.data.stages);
        setExpanded(r.data.stages[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("funnels.editor.loadFailed"));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, funnelDbId]);

  async function handleSave() {
    if (!token || !funnelDbId) return;
    setSaving(true);
    setError(null);
    try {
      const cleaned = stages.map(sanitizeStage);
      await updateFunnel(token, funnelDbId, { stages: cleaned });
      setToast(t("funnels.editor.saved"));
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("funnels.editor.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function patchStage(stageId: string, patch: Partial<FunnelStage>) {
    setStages((arr) => arr.map((s) => (s.id === stageId ? { ...s, ...patch } : s)));
  }

  function patchCopilot(stageId: string, patch: Partial<StageCopilotConfig>) {
    setStages((arr) =>
      arr.map((s) =>
        s.id === stageId
          ? { ...s, copilot: { ...(s.copilot ?? {}), ...patch } }
          : s,
      ),
    );
  }

  function addStage() {
    const id = `stage_${genId()}`;
    setStages((arr) => [
      ...arr,
      {
        id,
        label: t("funnels.editor.newStage"),
        baseStage: "exploration",
        copilot: { requiredQuestions: [], requiredDataFields: [] },
      },
    ]);
    setExpanded(id);
  }

  function removeStage(stageId: string) {
    if (!confirm(t("funnels.editor.removeStageConfirm"))) return;
    setStages((arr) => arr.filter((s) => s.id !== stageId));
  }

  function moveStage(stageId: string, dir: -1 | 1) {
    setStages((arr) => {
      const idx = arr.findIndex((s) => s.id === stageId);
      if (idx < 0) return arr;
      const next = idx + dir;
      if (next < 0 || next >= arr.length) return arr;
      const out = arr.slice();
      const [item] = out.splice(idx, 1);
      out.splice(next, 0, item!);
      return out;
    });
  }

  const stageIdOptions = useMemo(
    () => stages.map((s) => ({ id: s.id, label: s.label })),
    [stages],
  );

  if (!atLeastRole("admin")) {
    return <div className="max-w-3xl mx-auto p-6 text-sm text-gray-500">{t("funnels.editor.adminOnly")}</div>;
  }

  if (loading) {
    return <div className="max-w-3xl mx-auto p-6 text-sm text-gray-400">{t("funnels.editor.loading")}</div>;
  }

  if (!funnel) {
    return <div className="max-w-3xl mx-auto p-6 text-sm text-rose-600">{t("funnels.editor.notFound")}</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6">
      <header className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/settings/funnels" className="text-xs text-indigo-600 hover:underline">
            {t("funnels.editor.backLink")}
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2 truncate">{funnel.funnelId}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {funnel.isActive
              ? t("funnels.editor.stagesActive", { n: String(stages.length) })
              : t("funnels.editor.stagesInactive", { n: String(stages.length) })}
            {funnel.departmentId
              ? t("funnels.editor.deptSuffix", { id: funnel.departmentId })
              : t("funnels.editor.tenantSuffix")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => router.push("/settings/funnels")}
            className="px-3 py-2 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            {t("funnels.editor.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={clsx(
              "px-4 py-2 text-sm font-semibold rounded-lg transition",
              saving ? "bg-gray-200 text-gray-400" : "bg-indigo-600 text-white hover:bg-indigo-700",
            )}
          >
            {saving ? t("funnels.editor.saving") : t("funnels.editor.save")}
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {toast && (
        <div className="mb-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {toast}
        </div>
      )}

      <ol className="space-y-3">
        {stages.map((stage, idx) => (
          <li key={stage.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            {/* Stage row header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] font-mono text-gray-400 w-6">{idx + 1}.</span>
                <button
                  type="button"
                  onClick={() => setExpanded((e) => (e === stage.id ? null : stage.id))}
                  className="text-sm font-semibold text-gray-900 hover:text-indigo-700 truncate"
                >
                  {stage.label || t("funnels.editor.untitled")}
                </button>
                <span className="text-[10px] font-mono text-gray-400">{stage.id}</span>
                {stage.copilot?.goal && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 ring-1 ring-violet-100">
                    {t("funnels.editor.hasGoal")}
                  </span>
                )}
                {stage.crmValue && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
                    crm:{stage.crmValue}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => moveStage(stage.id, -1)}
                  className="text-[11px] px-1.5 py-1 rounded text-gray-600 hover:bg-gray-100"
                  title={t("funnels.editor.moveUp")}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveStage(stage.id, 1)}
                  className="text-[11px] px-1.5 py-1 rounded text-gray-600 hover:bg-gray-100"
                  title={t("funnels.editor.moveDown")}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeStage(stage.id)}
                  className="text-[11px] px-2 py-1 rounded text-rose-600 hover:bg-rose-50"
                >
                  {t("funnels.editor.remove")}
                </button>
              </div>
            </div>

            {/* Stage body - only when expanded to keep the list scannable. */}
            {expanded === stage.id && (
              <div className="px-4 py-4 space-y-4">
                {/* Basic info */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label={t("funnels.editor.stageId")}>
                    <input
                      type="text"
                      value={stage.id}
                      onChange={(e) => patchStage(stage.id, { id: e.target.value.trim() })}
                      className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white font-mono"
                    />
                  </Field>
                  <Field label={t("funnels.editor.displayLabel")}>
                    <input
                      type="text"
                      value={stage.label}
                      onChange={(e) => patchStage(stage.id, { label: e.target.value })}
                      className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                    />
                  </Field>
                  <Field label={t("funnels.editor.baseStage")}>
                    <select
                      value={stage.baseStage}
                      onChange={(e) => patchStage(stage.id, { baseStage: e.target.value as ConversationStage })}
                      className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                    >
                      {BASE_STAGES.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field
                  label={t("funnels.editor.crmValue")}
                  hint={t("funnels.editor.crmHint")}
                >
                  <input
                    type="text"
                    value={stage.crmValue ?? ""}
                    onChange={(e) => patchStage(stage.id, { crmValue: e.target.value })}
                    placeholder={t("funnels.editor.crmPlaceholder")}
                    className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                  />
                </Field>

                {/* Copilot fields */}
                <div className="rounded-xl bg-gray-50 border border-gray-200 p-3 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">
                    {t("funnels.editor.copilotConfig")}
                  </div>

                  <Field
                    label={t("funnels.editor.stageGoal")}
                    hint={t("funnels.editor.stageGoalHint")}
                  >
                    <textarea
                      rows={2}
                      value={stage.copilot?.goal ?? ""}
                      onChange={(e) => patchCopilot(stage.id, { goal: e.target.value })}
                      placeholder={t("funnels.editor.stageGoalPlaceholder")}
                      className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white resize-none"
                    />
                  </Field>

                  <Field
                    label={t("funnels.editor.nextStage")}
                    hint={t("funnels.editor.nextStageHint")}
                  >
                    <select
                      value={stage.copilot?.nextStageId ?? ""}
                      onChange={(e) => patchCopilot(stage.id, { nextStageId: e.target.value })}
                      className="w-full sm:w-64 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                    >
                      <option value="">{t("funnels.editor.deriveFromTransitions")}</option>
                      {stageIdOptions
                        .filter((o) => o.id !== stage.id)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                    </select>
                  </Field>

                  <QuestionsEditor
                    questions={stage.copilot?.requiredQuestions ?? []}
                    onChange={(qs) => patchCopilot(stage.id, { requiredQuestions: qs })}
                  />

                  <DataFieldsEditor
                    fields={stage.copilot?.requiredDataFields ?? []}
                    onChange={(fs) => patchCopilot(stage.id, { requiredDataFields: fs })}
                  />

                  <ExitCriteriaEditor
                    criteria={stage.copilot?.exitCriteria ?? {}}
                    onChange={(c) => patchCopilot(stage.id, { exitCriteria: c })}
                  />
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-3">
        <button
          type="button"
          onClick={addStage}
          className="text-xs px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100 hover:bg-indigo-100"
        >
          {t("funnels.editor.addStage")}
        </button>
      </div>
    </div>
  );
}

// ─── Sub-editors ──────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[11px] font-medium text-gray-700 block mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-500 mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

function QuestionsEditor({
  questions,
  onChange,
}: {
  questions: NonNullable<StageCopilotConfig["requiredQuestions"]>;
  onChange: (next: NonNullable<StageCopilotConfig["requiredQuestions"]>) => void;
}) {
  const { t } = useI18n();
  function add() {
    onChange([...questions, { id: genId(), text: "", required: true }]);
  }
  function patch(i: number, p: Partial<{ text: string; required: boolean }>) {
    onChange(questions.map((q, idx) => (idx === i ? { ...q, ...p } : q)));
  }
  function remove(i: number) {
    onChange(questions.filter((_, idx) => idx !== i));
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[11px] font-medium text-gray-700">{t("funnels.editor.questions.title")}</label>
        <button type="button" onClick={add} className="text-[11px] text-indigo-700 hover:underline">
          {t("funnels.editor.questions.add")}
        </button>
      </div>
      {questions.length === 0 ? (
        <p className="text-[11px] text-gray-400 italic">{t("funnels.editor.questions.empty")}</p>
      ) : (
        <div className="space-y-1.5">
          {questions.map((q, i) => (
            <div key={q.id} className="flex items-center gap-2">
              <input
                type="text"
                value={q.text}
                onChange={(e) => patch(i, { text: e.target.value })}
                placeholder={t("funnels.editor.questions.textPlaceholder")}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
              />
              <label className="text-[11px] text-gray-700 inline-flex items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={!!q.required}
                  onChange={(e) => patch(i, { required: e.target.checked })}
                />
                {t("funnels.editor.questions.required")}
              </label>
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-[11px] text-rose-600 hover:underline"
              >
                {t("funnels.editor.questions.remove")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DataFieldsEditor({
  fields,
  onChange,
}: {
  fields: NonNullable<StageCopilotConfig["requiredDataFields"]>;
  onChange: (next: NonNullable<StageCopilotConfig["requiredDataFields"]>) => void;
}) {
  const { t } = useI18n();
  function add() {
    onChange([...fields, { field: "", label: "", required: true }]);
  }
  function patch(i: number, p: Partial<{ field: string; label: string; required: boolean }>) {
    onChange(fields.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
  }
  function remove(i: number) {
    onChange(fields.filter((_, idx) => idx !== i));
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[11px] font-medium text-gray-700">{t("funnels.editor.dataFields.title")}</label>
        <button type="button" onClick={add} className="text-[11px] text-indigo-700 hover:underline">
          {t("funnels.editor.dataFields.add")}
        </button>
      </div>
      <p className="text-[10px] text-gray-500 mb-1.5">
        {t("funnels.editor.dataFields.hint")}
      </p>
      {fields.length === 0 ? (
        <p className="text-[11px] text-gray-400 italic">{t("funnels.editor.dataFields.empty")}</p>
      ) : (
        <div className="space-y-1.5">
          {fields.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={f.field}
                onChange={(e) => patch(i, { field: e.target.value })}
                placeholder={t("funnels.editor.dataFields.fieldPlaceholder")}
                className="w-36 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white font-mono"
              />
              <input
                type="text"
                value={f.label}
                onChange={(e) => patch(i, { label: e.target.value })}
                placeholder={t("funnels.editor.dataFields.labelPlaceholder")}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
              />
              <label className="text-[11px] text-gray-700 inline-flex items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={!!f.required}
                  onChange={(e) => patch(i, { required: e.target.checked })}
                />
                {t("funnels.editor.dataFields.required")}
              </label>
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-[11px] text-rose-600 hover:underline"
              >
                {t("funnels.editor.dataFields.remove")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExitCriteriaEditor({
  criteria,
  onChange,
}: {
  criteria: NonNullable<StageCopilotConfig["exitCriteria"]>;
  onChange: (next: NonNullable<StageCopilotConfig["exitCriteria"]>) => void;
}) {
  const { t } = useI18n();
  function setList(key: keyof NonNullable<StageCopilotConfig["exitCriteria"]>, value: string) {
    const items = value
      .split(/[\n,]/g)
      .map((s) => s.trim())
      .filter(Boolean);
    onChange({ ...criteria, [key]: items });
  }
  return (
    <div>
      <label className="text-[11px] font-medium text-gray-700 block mb-1">{t("funnels.editor.exitCriteria.title")}</label>
      <p className="text-[10px] text-gray-500 mb-2">
        {t("funnels.editor.exitCriteria.hint")}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Mini
          label={t("funnels.editor.exitCriteria.mustHaveFields")}
          value={(criteria.mustHaveFields ?? []).join(", ")}
          placeholder={t("funnels.editor.exitCriteria.mustHaveFieldsPlaceholder")}
          onChange={(v) => setList("mustHaveFields", v)}
        />
        <Mini
          label={t("funnels.editor.exitCriteria.mustAskQuestions")}
          value={(criteria.mustAskQuestions ?? []).join("\n")}
          placeholder={t("funnels.editor.exitCriteria.mustAskQuestionsPlaceholder")}
          onChange={(v) => setList("mustAskQuestions", v)}
          multiline
        />
        <Mini
          label={t("funnels.editor.exitCriteria.positiveSignals")}
          value={(criteria.positiveSignals ?? []).join(", ")}
          placeholder={t("funnels.editor.exitCriteria.positiveSignalsPlaceholder")}
          onChange={(v) => setList("positiveSignals", v)}
        />
        <Mini
          label={t("funnels.editor.exitCriteria.negativeSignals")}
          value={(criteria.negativeSignals ?? []).join(", ")}
          placeholder={t("funnels.editor.exitCriteria.negativeSignalsPlaceholder")}
          onChange={(v) => setList("negativeSignals", v)}
        />
      </div>
    </div>
  );
}

function Mini({
  label,
  value,
  placeholder,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <div>
      <label className="text-[10px] font-medium text-gray-600 block mb-0.5">{label}</label>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white resize-none"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
        />
      )}
    </div>
  );
}

// ─── normalization ────────────────────────────────────────

function sanitizeStage(stage: FunnelStage): FunnelStage {
  const copilot = stage.copilot ?? {};
  const cleaned: FunnelStage = {
    id: stage.id.trim(),
    label: stage.label.trim(),
    baseStage: stage.baseStage,
    entry: stage.entry,
    exit: stage.exit,
  };
  const trimmedCrm = (stage.crmValue ?? "").trim();
  if (trimmedCrm) cleaned.crmValue = trimmedCrm;

  const goal = (copilot.goal ?? "").trim();
  const qs = (copilot.requiredQuestions ?? []).filter((q) => q.text.trim().length > 0);
  // Auto-derive missing field/label so a row with only one populated value
  // isn't silently discarded by the backend schema (which requires both).
  const fs = (copilot.requiredDataFields ?? [])
    .map((f) => {
      const field = (f.field ?? "").trim();
      const label = (f.label ?? "").trim();
      if (!field && !label) return null;
      return {
        field: field || slugify(label),
        label: label || humanize(field),
        required: !!f.required,
      };
    })
    .filter((f): f is { field: string; label: string; required: boolean } => f !== null);
  const next = (copilot.nextStageId ?? "").trim();
  const exitCriteria = copilot.exitCriteria;
  const trimmedExit = exitCriteria
    ? {
        mustHaveFields: (exitCriteria.mustHaveFields ?? []).filter(Boolean),
        mustAskQuestions: (exitCriteria.mustAskQuestions ?? []).filter(Boolean),
        positiveSignals: (exitCriteria.positiveSignals ?? []).filter(Boolean),
        negativeSignals: (exitCriteria.negativeSignals ?? []).filter(Boolean),
      }
    : undefined;

  if (goal || qs.length || fs.length || next || trimmedExit) {
    cleaned.copilot = {
      ...(goal ? { goal } : {}),
      requiredQuestions: qs,
      requiredDataFields: fs,
      ...(next ? { nextStageId: next } : {}),
      ...(trimmedExit ? { exitCriteria: trimmedExit } : {}),
    };
  }
  return cleaned;
}
