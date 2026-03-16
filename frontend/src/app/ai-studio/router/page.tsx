"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useI18n } from "@/context/I18nContext";
import clsx from "clsx";

// ─── Types ────────────────────────────────────────────────────
type ConditionType = "intent" | "keyword" | "attribute" | "channel" | "time" | "sentiment";
type ConditionOperator = "equals" | "contains" | "is_not";
type RouteType = "agent" | "flow" | "human";
type LogicType = "AND" | "OR";

interface Condition {
  id: string;
  type: ConditionType;
  operator: ConditionOperator;
  value: string;
}

interface RouterRule {
  id: string;
  priority: number;
  name: string;
  conditions: Condition[];
  logic: LogicType;
  routeType: RouteType;
  routeTarget: string;
  enabled: boolean;
  isDefault?: boolean;
}

// ─── Mock data ────────────────────────────────────────────────
const INITIAL_RULES: RouterRule[] = [
  {
    id: "r1",
    priority: 1,
    name: "VIP Customers",
    conditions: [{ id: "c1", type: "attribute", operator: "equals", value: "VIP" }],
    logic: "AND",
    routeType: "human",
    routeTarget: "Support Team",
    enabled: true,
  },
  {
    id: "r2",
    priority: 2,
    name: "Cancel / Return Intent",
    conditions: [{ id: "c2", type: "intent", operator: "contains", value: "cancel, return" }],
    logic: "AND",
    routeType: "flow",
    routeTarget: "Returns Flow",
    enabled: true,
  },
  {
    id: "r3",
    priority: 3,
    name: "Track Order Intent",
    conditions: [{ id: "c3", type: "intent", operator: "equals", value: "track order" }],
    logic: "AND",
    routeType: "agent",
    routeTarget: "Maya (Support)",
    enabled: true,
  },
  {
    id: "r4",
    priority: 4,
    name: "Pricing / Sales Inquiry",
    conditions: [{ id: "c4", type: "intent", operator: "contains", value: "pricing, buy" }],
    logic: "AND",
    routeType: "agent",
    routeTarget: "Sales Bot",
    enabled: true,
  },
  {
    id: "r5",
    priority: 5,
    name: "After Business Hours",
    conditions: [{ id: "c5", type: "time", operator: "equals", value: "After hours" }],
    logic: "AND",
    routeType: "flow",
    routeTarget: "After-Hours Flow",
    enabled: false,
  },
];

const DEFAULT_RULE: RouterRule = {
  id: "default",
  priority: 99,
  name: "Everything Else",
  conditions: [],
  logic: "AND",
  routeType: "agent",
  routeTarget: "General Agent",
  enabled: true,
  isDefault: true,
};

const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
  intent: "AI Intent",
  keyword: "Keywords",
  attribute: "Customer Attribute",
  channel: "Channel",
  time: "Time",
  sentiment: "Sentiment",
};

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "equals",
  contains: "contains",
  is_not: "is not",
};

const ROUTE_TYPE_LABELS: Record<RouteType, string> = {
  agent: "AI Agent",
  flow: "Flow",
  human: "Human Agent",
};

const AGENT_OPTIONS = ["Maya (Support)", "Sales Bot", "Returns Handler", "General Agent"];
const FLOW_OPTIONS = ["Returns Flow", "After-Hours Flow", "Welcome Flow", "Lead Qualification"];
const DEPARTMENT_OPTIONS = ["Support Team", "Sales Team", "Operations", "VIP Support"];

function conditionSummary(rule: RouterRule): string {
  if (rule.isDefault) return "Default fallback — catches all unmatched conversations";
  return rule.conditions
    .map((c) => `${CONDITION_TYPE_LABELS[c.type]} ${OPERATOR_LABELS[c.operator]} "${c.value}"`)
    .join(` ${rule.logic} `);
}

function routeSummary(rule: RouterRule): string {
  const prefix = ROUTE_TYPE_LABELS[rule.routeType];
  return rule.routeTarget ? `${prefix}: ${rule.routeTarget}` : prefix;
}

// ─── Toggle ───────────────────────────────────────────────────
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={clsx(
        "relative shrink-0 rounded-full transition-colors",
        checked ? "bg-violet-500" : "bg-gray-200"
      )}
      style={{ width: 40, height: 22 }}
    >
      <span
        className={clsx(
          "absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform",
          checked && "translate-x-[18px]"
        )}
      />
    </button>
  );
}

// ─── SectionCard ─────────────────────────────────────────────
function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <div className="mb-4">
        <h3 className="font-semibold text-gray-900 text-base">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// ─── Condition Row ────────────────────────────────────────────
function ConditionRow({
  condition,
  onChange,
  onRemove,
  canRemove,
}: {
  condition: Condition;
  onChange: (updated: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const inputClass =
    "px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Type */}
      <select
        value={condition.type}
        onChange={(e) => onChange({ ...condition, type: e.target.value as ConditionType })}
        className={clsx(inputClass, "flex-1 min-w-[130px]")}
      >
        {(Object.keys(CONDITION_TYPE_LABELS) as ConditionType[]).map((t) => (
          <option key={t} value={t}>{CONDITION_TYPE_LABELS[t]}</option>
        ))}
      </select>

      {/* Operator */}
      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as ConditionOperator })}
        className={clsx(inputClass, "w-28")}
      >
        {(Object.keys(OPERATOR_LABELS) as ConditionOperator[]).map((o) => (
          <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>
        ))}
      </select>

      {/* Value */}
      <input
        type="text"
        value={condition.value}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
        placeholder="Value..."
        className={clsx(inputClass, "flex-1 min-w-[120px]")}
      />

      {/* Remove */}
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-1.5 rounded-lg text-gray-300 hover:text-red-400 transition shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── Rule Editor ─────────────────────────────────────────────
function RuleEditor({
  rule,
  onSave,
  onCancel,
  onDelete,
}: {
  rule: RouterRule;
  onSave: (updated: RouterRule) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState<RouterRule>({ ...rule, conditions: rule.conditions.map((c) => ({ ...c })) });

  function patchDraft(partial: Partial<RouterRule>) {
    setDraft((prev) => ({ ...prev, ...partial }));
  }

  function addCondition() {
    const newCond: Condition = {
      id: `c_${Date.now()}`,
      type: "intent",
      operator: "equals",
      value: "",
    };
    patchDraft({ conditions: [...draft.conditions, newCond] });
  }

  function updateCondition(id: string, updated: Condition) {
    patchDraft({ conditions: draft.conditions.map((c) => (c.id === id ? updated : c)) });
  }

  function removeCondition(id: string) {
    patchDraft({ conditions: draft.conditions.filter((c) => c.id !== id) });
  }

  const inputClass =
    "w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition";

  const targetOptions =
    draft.routeType === "agent"
      ? AGENT_OPTIONS
      : draft.routeType === "flow"
      ? FLOW_OPTIONS
      : DEPARTMENT_OPTIONS;

  return (
    <div className="border-t border-violet-100 bg-violet-50/30 p-5 space-y-5">
      {/* Name */}
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
          Rule Name
        </label>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => patchDraft({ name: e.target.value })}
          placeholder="Name this rule..."
          className={inputClass}
        />
      </div>

      {/* Conditions */}
      {!draft.isDefault && (
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            When (Conditions)
          </label>
          <div className="space-y-2.5">
            {draft.conditions.map((cond) => (
              <ConditionRow
                key={cond.id}
                condition={cond}
                onChange={(updated) => updateCondition(cond.id, updated)}
                onRemove={() => removeCondition(cond.id)}
                canRemove={draft.conditions.length > 1}
              />
            ))}
          </div>

          {/* Add condition */}
          <button
            type="button"
            onClick={addCondition}
            className="mt-2.5 flex items-center gap-1.5 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add Condition
          </button>

          {/* Logic toggle (only relevant with 2+ conditions) */}
          {draft.conditions.length > 1 && (
            <div className="mt-3 flex items-center gap-3">
              <span className="text-sm text-gray-500">Match:</span>
              <div className="flex gap-1 bg-gray-100 rounded-xl p-0.5">
                {(["AND", "OR"] as LogicType[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => patchDraft({ logic: l })}
                    className={clsx(
                      "px-3 py-1 rounded-lg text-xs font-semibold transition",
                      draft.logic === l
                        ? "bg-white text-violet-700 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    )}
                  >
                    {l === "AND" ? "All conditions (AND)" : "Any condition (OR)"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Route To */}
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Route To
        </label>
        <div className="space-y-2">
          {(["agent", "flow", "human"] as RouteType[]).map((rt) => (
            <label
              key={rt}
              className={clsx(
                "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition",
                draft.routeType === rt
                  ? "border-violet-300 bg-violet-50"
                  : "border-gray-100 bg-white hover:border-gray-200"
              )}
            >
              <input
                type="radio"
                name={`routeType_${draft.id}`}
                checked={draft.routeType === rt}
                onChange={() => patchDraft({ routeType: rt, routeTarget: "" })}
                className="w-4 h-4 text-violet-600 border-gray-300 focus:ring-violet-500"
              />
              <span className={clsx("text-sm font-medium", draft.routeType === rt ? "text-violet-800" : "text-gray-700")}>
                {ROUTE_TYPE_LABELS[rt]}
              </span>
              {draft.routeType === rt && (
                <select
                  value={draft.routeTarget}
                  onChange={(e) => patchDraft({ routeTarget: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  className="ml-auto px-3 py-1.5 bg-white border border-violet-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none transition text-gray-700"
                >
                  <option value="">Select...</option>
                  {targetOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              )}
            </label>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => onSave(draft)}
          className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          Save Rule
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm transition"
        >
          Cancel
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto flex items-center gap-1.5 px-3 py-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-xl text-sm transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            Delete Rule
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Rule Row ─────────────────────────────────────────────────
function RuleRow({
  rule,
  index,
  isEditing,
  onToggleEdit,
  onToggleEnabled,
  onSave,
  onDelete,
  onCancelEdit,
  totalNonDefault,
}: {
  rule: RouterRule;
  index: number;
  isEditing: boolean;
  onToggleEdit: () => void;
  onToggleEnabled: () => void;
  onSave: (updated: RouterRule) => void;
  onDelete?: () => void;
  onCancelEdit: () => void;
  totalNonDefault: number;
}) {
  const isDefault = rule.isDefault;

  return (
    <div
      className={clsx(
        "border-b border-gray-50 last:border-b-0 transition",
        isEditing ? "bg-white" : isDefault ? "bg-gray-50/40" : "hover:bg-gray-50/50"
      )}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 px-5 py-4">
        {/* Drag handle (visual only) */}
        {!isDefault && (
          <div className="text-gray-200 cursor-grab active:cursor-grabbing shrink-0">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
            </svg>
          </div>
        )}
        {isDefault && <div className="w-4 shrink-0" />}

        {/* Priority badge */}
        <span
          className={clsx(
            "w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0",
            isDefault ? "bg-gray-100 text-gray-400" : "bg-violet-100 text-violet-700"
          )}
        >
          {isDefault ? "∞" : index + 1}
        </span>

        {/* Rule info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">{rule.name}</p>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{conditionSummary(rule)}</p>
        </div>

        {/* Route destination */}
        <div className="hidden sm:flex items-center gap-2 shrink-0 max-w-[200px]">
          <span className="text-gray-300">→</span>
          <span
            className={clsx(
              "text-xs font-medium px-2.5 py-1 rounded-full",
              rule.routeType === "human"
                ? "bg-blue-50 text-blue-700"
                : rule.routeType === "flow"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-violet-50 text-violet-700"
            )}
          >
            {routeSummary(rule)}
          </span>
        </div>

        {/* Toggle (skip for default) */}
        {!isDefault ? (
          <Toggle checked={rule.enabled} onChange={onToggleEnabled} />
        ) : (
          <div className="w-10 shrink-0" />
        )}

        {/* Edit button */}
        <button
          onClick={onToggleEdit}
          className={clsx(
            "p-1.5 rounded-lg transition shrink-0",
            isEditing
              ? "text-violet-600 bg-violet-50"
              : "text-gray-300 hover:text-violet-600 hover:bg-violet-50"
          )}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
          </svg>
        </button>
      </div>

      {/* Inline editor */}
      {isEditing && (
        <RuleEditor
          rule={rule}
          onSave={onSave}
          onCancel={onCancelEdit}
          onDelete={!isDefault && onDelete ? onDelete : undefined}
        />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function RouterPage() {
  const router = useRouter();
  const { t } = useI18n();

  const [rules, setRules] = useState<RouterRule[]>(INITIAL_RULES);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [saved, setSaved] = useState(false);

  const newRuleTemplate: RouterRule = {
    id: `r_${Date.now()}`,
    priority: rules.length + 1,
    name: "",
    conditions: [{ id: `c_${Date.now()}`, type: "intent", operator: "equals", value: "" }],
    logic: "AND",
    routeType: "agent",
    routeTarget: "",
    enabled: true,
  };

  function toggleEnabled(id: string) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  }

  function saveRule(updated: RouterRule) {
    setRules((prev) => {
      const exists = prev.find((r) => r.id === updated.id);
      if (exists) {
        return prev.map((r) => (r.id === updated.id ? updated : r));
      }
      return [...prev, { ...updated, priority: prev.length + 1 }];
    });
    setEditingId(null);
    setAddingNew(false);
    flashSaved();
  }

  function deleteRule(id: string) {
    setRules((prev) => prev.filter((r) => r.id !== id).map((r, i) => ({ ...r, priority: i + 1 })));
    setEditingId(null);
  }

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const allDisplayRules = [...rules, DEFAULT_RULE];

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Back button */}
        <button
          onClick={() => router.push("/ai-studio")}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm mb-5 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {t("aiStudio.router.backToStudio")}
        </button>

        <div className="max-w-3xl space-y-5">
          {/* Page header */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-violet-100 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">{t("aiStudio.router.pageTitle")}</h1>
                <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.router.pageSubtitle")}</p>
              </div>
            </div>

            {saved && (
              <div className="flex items-center gap-2 px-3 py-2 bg-green-50 text-green-700 rounded-xl text-sm font-medium shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Saved
              </div>
            )}
          </div>

          {/* Info banner */}
          <div className="flex items-start gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-4 py-3">
            <svg className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <p className="text-sm text-violet-700">{t("aiStudio.router.infoBanner")}</p>
          </div>

          {/* Rules list */}
          <SectionCard
            title={t("aiStudio.router.rulesTitle")}
            subtitle={t("aiStudio.router.rulesSubtitle")}
          >
            {/* Table header */}
            <div className="grid grid-cols-[20px_28px_1fr_auto_40px_32px] gap-3 items-center px-0 pb-3 border-b border-gray-100">
              <span />
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">#</span>
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{t("aiStudio.router.ruleCol")}</span>
              <span className="hidden sm:block text-xs font-semibold text-gray-400 uppercase tracking-wide">{t("aiStudio.router.routeToCol")}</span>
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide text-center">{t("aiStudio.router.onCol")}</span>
              <span />
            </div>

            {/* Rule rows */}
            <div className="-mx-5">
              {allDisplayRules.map((rule, idx) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  index={idx}
                  isEditing={editingId === rule.id}
                  onToggleEdit={() => {
                    setAddingNew(false);
                    setEditingId(editingId === rule.id ? null : rule.id);
                  }}
                  onToggleEnabled={() => toggleEnabled(rule.id)}
                  onSave={saveRule}
                  onDelete={() => deleteRule(rule.id)}
                  onCancelEdit={() => setEditingId(null)}
                  totalNonDefault={rules.length}
                />
              ))}
            </div>

            {/* Add new rule inline */}
            {addingNew && (
              <div className="-mx-5 border-t border-gray-100 bg-white">
                <div className="px-5 pt-4 pb-1">
                  <p className="text-sm font-semibold text-gray-800">New Rule</p>
                </div>
                <RuleEditor
                  rule={newRuleTemplate}
                  onSave={saveRule}
                  onCancel={() => setAddingNew(false)}
                />
              </div>
            )}

            {/* Add Rule button */}
            {!addingNew && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setAddingNew(true);
                }}
                className="mt-4 flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                {t("aiStudio.router.addRule")}
              </button>
            )}
          </SectionCard>

          {/* How routing works explainer */}
          <SectionCard title={t("aiStudio.router.howItWorksTitle")}>
            <div className="space-y-3">
              {[
                { icon: "1", color: "bg-violet-100 text-violet-700", text: t("aiStudio.router.how1") },
                { icon: "2", color: "bg-blue-100 text-blue-700", text: t("aiStudio.router.how2") },
                { icon: "3", color: "bg-emerald-100 text-emerald-700", text: t("aiStudio.router.how3") },
              ].map((step) => (
                <div key={step.icon} className="flex items-start gap-3">
                  <span className={clsx("w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 mt-0.5", step.color)}>
                    {step.icon}
                  </span>
                  <p className="text-sm text-gray-600">{step.text}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          <div className="pb-8" />
        </div>
      </div>
    </AppLayout>
  );
}
