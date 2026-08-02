"use client";

// Adjust usage-credit spending limit - the dedicated flow for the auto-purchase
// policy. When plan credits run out, usage credits (automatic top-ups) keep the
// AI operating up to a MONTHLY MONEY CEILING. The ceiling is enforced by the
// billing service (AutoPurchasePolicy.maxMonthlySpend, checked before every
// automatic charge) - this page only edits the policy; it is not the
// enforcement. Only what the backend actually implements is offered here.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import {
  getAutoPurchase,
  setAutoPurchase,
  getPackages,
  type AutoPurchasePolicy,
  type CreditPackage,
} from "@/lib/api-billing";

function UsageLimitInner() {
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [policy, setPolicy] = useState<AutoPurchasePolicy | null>(null);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [thresholdPct, setThresholdPct] = useState(10);
  const [packageKey, setPackageKey] = useState("");
  const [maxMonthlySpend, setMaxMonthlySpend] = useState("1000");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [ap, pk] = await Promise.all([
        getAutoPurchase(token).catch(() => ({ policy: null })),
        getPackages(token).catch(() => ({ packages: [] as CreditPackage[] })),
      ]);
      setPolicy(ap.policy);
      setPackages(pk.packages || []);
      if (ap.policy) {
        setEnabled(ap.policy.enabled);
        setThresholdPct(ap.policy.thresholdPct);
        setPackageKey(ap.policy.packageKey ?? pk.packages?.[0]?.key ?? "");
        setMaxMonthlySpend(ap.policy.maxMonthlySpend ?? "1000");
      } else {
        setPackageKey(pk.packages?.[0]?.key ?? "");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setMsg(null);
    try {
      await setAutoPurchase(token, { enabled, thresholdPct, packageKey, maxMonthlySpend });
      router.push("/settings/usage");
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("usage.actionFailed") });
      setSaving(false);
    }
  };

  const currency = policy?.currency ?? "ILS";

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link href="/settings/usage" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
        <svg className="h-4 w-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("usage.limit.back")}
      </Link>

      <div className="mb-6 mt-3">
        <h1 className="text-2xl font-bold text-gray-900">{t("usage.limit.title")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("usage.limit.subtitle")}</p>
      </div>

      {msg && (
        <div className={`mb-6 rounded-xl px-4 py-2.5 text-sm border ${msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="h-64 animate-pulse rounded-2xl bg-gray-50" />
      ) : (
        <div className="space-y-6">
          {/* Enable */}
          <label className="flex items-start justify-between gap-4 rounded-2xl border border-gray-200 p-4">
            <div>
              <p className="text-sm font-medium text-gray-800">{t("usage.limit.enableTitle")}</p>
              <p className="mt-0.5 text-xs text-gray-500">{t("usage.limit.enableDesc")}</p>
            </div>
            <button
              type="button"
              onClick={() => setEnabled((v) => !v)}
              className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-primary-500" : "bg-gray-300"}`}
              aria-pressed={enabled}
            >
              <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform" style={{ transform: enabled ? "translateX(22px)" : "translateX(2px)" }} />
            </button>
          </label>

          <div className={enabled ? "space-y-5" : "pointer-events-none space-y-5 opacity-40"}>
            {/* Max monthly spend */}
            <div>
              <label className="block text-sm font-medium text-gray-700">{t("usage.limit.maxSpend")}</label>
              <p className="mb-1.5 text-xs text-gray-400">{t("usage.limit.maxSpendHint")}</p>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">{currency}</span>
                <input
                  type="number" min={0} value={maxMonthlySpend}
                  onChange={(e) => setMaxMonthlySpend(e.target.value)}
                  className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" dir="ltr"
                />
              </div>
            </div>

            {/* Warning / trigger threshold */}
            <div>
              <label className="block text-sm font-medium text-gray-700">{t("usage.limit.threshold")}</label>
              <p className="mb-1.5 text-xs text-gray-400">{t("usage.limit.thresholdHint")}</p>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={1} max={50} value={thresholdPct}
                  onChange={(e) => setThresholdPct(Number(e.target.value))}
                  className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm" dir="ltr"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>

            {/* Package to buy on trigger */}
            <div>
              <label className="block text-sm font-medium text-gray-700">{t("usage.limit.package")}</label>
              <p className="mb-1.5 text-xs text-gray-400">{t("usage.limit.packageHint")}</p>
              <select
                value={packageKey}
                onChange={(e) => setPackageKey(e.target.value)}
                className="w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {packages.map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Behavior at the limit - describe only what the backend does. */}
            <div className="rounded-xl bg-gray-50 px-4 py-3 text-xs text-gray-500">
              {t("usage.limit.atLimitNote")}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Link href="/settings/usage" className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
              {t("usage.limit.cancel")}
            </Link>
            <button
              disabled={saving}
              onClick={save}
              className="rounded-lg bg-primary-500 px-5 py-2 text-sm font-semibold text-white hover:bg-primary-600 disabled:opacity-50"
            >
              {t("usage.limit.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UsageLimitPage() {
  return (
    <RequirePermission perm="settings:billing:manage" redirectTo="/settings/usage">
      <UsageLimitInner />
    </RequirePermission>
  );
}
