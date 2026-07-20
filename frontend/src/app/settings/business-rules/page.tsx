"use client";

/**
 * Business Rules - tenant-authored policies for sensitive AI actions.
 *
 * What the owner configures here is ENFORCED deterministically in the backend
 * policy engine (before the AI offers an action, before an approval request
 * is created, and again right before execution). The AI can explain these
 * rules; it can never bypass them, and neither can a prompt.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  listBusinessPolicies,
  saveBusinessPolicy,
  previewBusinessPolicy,
  type BusinessPolicyRow,
} from "@/lib/gotcha-api";

const ACTION_KINDS = ["COMPENSATION", "COUPON", "REFUND", "CANCEL_ORDER"] as const;
const REASONS = ["late_delivery", "damaged_or_wrong_item", "confirmed_business_error"] as const;

interface Draft {
  enabled: boolean;
  approvedReasons: string[];
  maxAmount: string;
  maxPercentOfOrder: string;
  managerApprovalAboveAmount: string;
  preventDuplicatePerIncident: boolean;
}

function toDraft(row: BusinessPolicyRow | undefined): Draft {
  const c = (row?.config ?? {}) as Record<string, any>;
  return {
    enabled: row ? row.enabled : true,
    approvedReasons: Array.isArray(c.approvedReasons) ? c.approvedReasons : [],
    maxAmount: c.maxAmount != null ? String(c.maxAmount) : "",
    maxPercentOfOrder: c.maxPercentOfOrder != null ? String(Math.round(c.maxPercentOfOrder * 100)) : "",
    managerApprovalAboveAmount: c.managerApprovalAboveAmount != null ? String(c.managerApprovalAboveAmount) : "",
    preventDuplicatePerIncident: !!c.preventDuplicatePerIncident,
  };
}

export default function BusinessRulesPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<{ amount: string; reason: string; result: string | null }>({
    amount: "30",
    reason: "late_delivery",
    result: null,
  });

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await listBusinessPolicies(token);
      const next: Record<string, Draft> = {};
      const vers: Record<string, number> = {};
      for (const kind of ACTION_KINDS) {
        const row = res.data.policies.find((p) => p.actionKind === kind);
        next[kind] = toDraft(row);
        if (row) vers[kind] = row.version;
      }
      setDrafts(next);
      setVersions(vers);
    } catch {
      // page renders empty drafts; save still works
      const next: Record<string, Draft> = {};
      for (const kind of ACTION_KINDS) next[kind] = toDraft(undefined);
      setDrafts(next);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const save = async (kind: string) => {
    if (!token) return;
    const d = drafts[kind];
    if (!d) return;
    setSaving(kind);
    try {
      const config: Record<string, unknown> = {
        approvedReasons: d.approvedReasons,
        preventDuplicatePerIncident: d.preventDuplicatePerIncident,
      };
      if (d.maxAmount.trim() !== "") config.maxAmount = Number(d.maxAmount);
      if (d.maxPercentOfOrder.trim() !== "") config.maxPercentOfOrder = Number(d.maxPercentOfOrder) / 100;
      if (d.managerApprovalAboveAmount.trim() !== "") config.managerApprovalAboveAmount = Number(d.managerApprovalAboveAmount);
      const res = await saveBusinessPolicy(token, kind, { enabled: d.enabled, config });
      setVersions((v) => ({ ...v, [kind]: res.data.version }));
      setSavedAt((s) => ({ ...s, [kind]: Date.now() }));
    } finally {
      setSaving(null);
    }
  };

  const runPreview = async () => {
    if (!token) return;
    try {
      const res = await previewBusinessPolicy(token, "COMPENSATION", {
        reasonCode: preview.reason,
        requestedAmount: Number(preview.amount),
        orderAmount: 100,
      });
      const d = res.data;
      setPreview((p) => ({
        ...p,
        result: `${t(`businessRules.decision.${d.decision}`) || d.decision}${d.maxAmount != null ? ` (${t("businessRules.maxLabel")}: ${d.maxAmount})` : ""}`,
      }));
    } catch {
      setPreview((p) => ({ ...p, result: t("businessRules.previewFailed") }));
    }
  };

  const upd = (kind: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold">{t("businessRules.title")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t("businessRules.subtitle")}</p>
      </div>

      {ACTION_KINDS.map((kind) => {
        const d = drafts[kind];
        if (!d) return null;
        return (
          <div key={kind} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold">{t(`businessRules.kind.${kind}`)}</h2>
                {versions[kind] && (
                  <span className="text-[11px] text-slate-400">
                    {t("businessRules.version")} {versions[kind]}
                  </span>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.enabled}
                  onChange={(e) => upd(kind, { enabled: e.target.checked })}
                />
                {t("businessRules.enabled")}
              </label>
            </div>

            <div>
              <div className="text-sm font-medium mb-1">{t("businessRules.approvedReasons")}</div>
              <div className="flex flex-wrap gap-3">
                {REASONS.map((r) => (
                  <label key={r} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={d.approvedReasons.includes(r)}
                      onChange={(e) =>
                        upd(kind, {
                          approvedReasons: e.target.checked
                            ? [...d.approvedReasons, r]
                            : d.approvedReasons.filter((x) => x !== r),
                        })
                      }
                    />
                    {t(`businessRules.reason.${r}`)}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">{t("businessRules.reasonsHint")}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="text-sm space-y-1 block">
                <span className="font-medium">{t("businessRules.maxAmount")}</span>
                <input
                  type="number" min={0}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5"
                  value={d.maxAmount}
                  onChange={(e) => upd(kind, { maxAmount: e.target.value })}
                />
              </label>
              <label className="text-sm space-y-1 block">
                <span className="font-medium">{t("businessRules.maxPercent")}</span>
                <input
                  type="number" min={0} max={100}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5"
                  value={d.maxPercentOfOrder}
                  onChange={(e) => upd(kind, { maxPercentOfOrder: e.target.value })}
                />
              </label>
              <label className="text-sm space-y-1 block">
                <span className="font-medium">{t("businessRules.managerAbove")}</span>
                <input
                  type="number" min={0}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5"
                  value={d.managerApprovalAboveAmount}
                  onChange={(e) => upd(kind, { managerApprovalAboveAmount: e.target.value })}
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={d.preventDuplicatePerIncident}
                onChange={(e) => upd(kind, { preventDuplicatePerIncident: e.target.checked })}
              />
              {t("businessRules.preventDuplicate")}
            </label>

            <div className="flex items-center gap-3">
              <button
                onClick={() => save(kind)}
                disabled={saving === kind}
                className="rounded-md bg-indigo-600 text-white text-sm px-4 py-1.5 hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving === kind ? t("businessRules.saving") : t("businessRules.save")}
              </button>
              {savedAt[kind] && <span className="text-xs text-green-600">{t("businessRules.saved")}</span>}
            </div>
          </div>
        );
      })}

      <div className="rounded-xl border border-dashed border-slate-300 p-5 space-y-3">
        <h2 className="font-semibold text-sm">{t("businessRules.previewTitle")}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm space-y-1 block">
            <span>{t("businessRules.previewAmount")}</span>
            <input
              type="number"
              className="w-28 rounded-md border border-slate-300 px-2 py-1.5"
              value={preview.amount}
              onChange={(e) => setPreview((p) => ({ ...p, amount: e.target.value }))}
            />
          </label>
          <label className="text-sm space-y-1 block">
            <span>{t("businessRules.previewReason")}</span>
            <select
              className="rounded-md border border-slate-300 px-2 py-1.5"
              value={preview.reason}
              onChange={(e) => setPreview((p) => ({ ...p, reason: e.target.value }))}
            >
              {[...REASONS, "just_because"].map((r) => (
                <option key={r} value={r}>{t(`businessRules.reason.${r}`) || r}</option>
              ))}
            </select>
          </label>
          <button
            onClick={runPreview}
            className="rounded-md border border-slate-300 text-sm px-3 py-1.5 hover:bg-slate-50"
          >
            {t("businessRules.previewRun")}
          </button>
        </div>
        {preview.result && <div className="text-sm text-slate-700">{preview.result}</div>}
      </div>
    </div>
  );
}
