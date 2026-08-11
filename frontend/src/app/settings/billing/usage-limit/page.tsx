"use client";

// What happens when plan credits run out.
//
// Three answers, and the difference that matters to a customer is WHEN the card
// is charged:
//
//   Stop            nothing more is spent. The AI stops at zero.
//   Auto-recharge   buy another package at the threshold. Charged AT PURCHASE.
//   Pay-as-you-go   keep working past zero. Charged WHEN THE CYCLE CLOSES.
//
// The last one is the only mode where a customer can owe money nobody has
// charged yet, which is why its cap is stated in the same breath as the mode
// rather than tucked into an advanced section. Both spending modes share
// maxMonthlySpend, and the billing service enforces it on every accrual and
// before every automatic charge - this page edits the policy, it is not the
// enforcement.

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

type Mode = "STOP" | "AUTO" | "PAYG";

/** The stored policy shape, read back as one of three modes. */
function modeOf(p: AutoPurchasePolicy | null): Mode {
  if (!p) return "STOP";
  if (p.limitBehavior === "PAYG") return "PAYG";
  return p.enabled ? "AUTO" : "STOP";
}

function UsageLimitInner() {
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [policy, setPolicy] = useState<AutoPurchasePolicy | null>(null);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [currency, setCurrency] = useState("");
  const [rate, setRate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [mode, setMode] = useState<Mode>("STOP");
  const [thresholdPct, setThresholdPct] = useState(10);
  const [packageKey, setPackageKey] = useState("");
  const [maxMonthlySpend, setMaxMonthlySpend] = useState("1000");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [ap, pk] = await Promise.all([
        getAutoPurchase(token).catch(() => ({ policy: null, currency: "", paygRate: null })),
        getPackages(token).catch(() => ({ packages: [] as CreditPackage[] })),
      ]);
      setPolicy(ap.policy);
      setPackages(pk.packages || []);
      // From the server, never a local default. The same field once defaulted to
      // ILS in the schema, USD in the API and ILS again here, so a cap typed as
      // "100" could mean either.
      setCurrency(ap.currency || ap.policy?.currency || "");
      setRate(ap.paygRate ?? null);
      setMode(modeOf(ap.policy));
      if (ap.policy) {
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

  // Both spending modes need a cap. Stop does not: it never spends.
  const spends = mode === "AUTO" || mode === "PAYG";
  const uncapped = spends && (maxMonthlySpend === "" || Number(maxMonthlySpend) <= 0);
  // The EFFECTIVE rate from the server (the org override, else the plan
  // price), not the policy column - that one is empty for almost everyone.
  const paygRate = rate;

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setMsg(null);
    try {
      await setAutoPurchase(token, {
        // Only auto-recharge buys anything on its own. PAYG serves past zero and
        // bills later, which is a different mechanism, not a top-up variant.
        enabled: mode === "AUTO",
        limitBehavior: mode === "PAYG" ? "PAYG" : "STOP_AI",
        thresholdPct,
        packageKey: mode === "AUTO" ? packageKey : null,
        maxMonthlySpend: spends ? maxMonthlySpend : null,
      });
      router.push("/settings/usage");
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("usage.actionFailed") });
      setSaving(false);
    }
  };

  const options: Array<{ id: Mode; title: string; desc: string; when: string }> = [
    {
      id: "STOP",
      title: t("usage.limit.mode.stop.title"),
      desc: t("usage.limit.mode.stop.desc"),
      when: t("usage.limit.mode.stop.when"),
    },
    {
      id: "AUTO",
      title: t("usage.limit.mode.auto.title"),
      desc: t("usage.limit.mode.auto.desc"),
      when: t("usage.limit.mode.auto.when"),
    },
    {
      id: "PAYG",
      title: t("usage.limit.mode.payg.title"),
      desc: t("usage.limit.mode.payg.desc"),
      when: t("usage.limit.mode.payg.when"),
    },
  ];

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
          {/* The three answers, with when the card is charged stated on each. */}
          <div className="space-y-3">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setMode(o.id)}
                aria-pressed={mode === o.id}
                className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-start transition-colors ${
                  mode === o.id ? "border-primary-500 bg-primary-50/40" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                    mode === o.id ? "border-primary-500" : "border-gray-300"
                  }`}
                >
                  {mode === o.id && <span className="h-2.5 w-2.5 rounded-full bg-primary-500" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-800">{o.title}</span>
                  <span className="mt-0.5 block text-xs text-gray-500">{o.desc}</span>
                  <span className="mt-1.5 block text-xs font-medium text-gray-400">{o.when}</span>
                </span>
              </button>
            ))}
          </div>

          {mode === "AUTO" && (
            <div className="space-y-5 rounded-2xl border border-gray-200 p-4">
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
            </div>
          )}

          {mode === "PAYG" && (
            <div className="space-y-3 rounded-2xl border border-gray-200 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">{t("usage.limit.payg.rate")}</span>
                <span className="text-sm font-semibold text-gray-900" dir="ltr">
                  {paygRate ? `${paygRate} ${currency}` : t("usage.limit.payg.rateUnset")}
                </span>
              </div>
              {!paygRate && (
                // Without a rate nothing can be priced, and the service refuses
                // to serve on PAYG rather than serve for free. Say so here.
                <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700">
                  {t("usage.limit.payg.rateMissing")}
                </p>
              )}
            </div>
          )}

          {spends && (
            <div className="rounded-2xl border border-gray-200 p-4">
              <label className="block text-sm font-medium text-gray-700">{t("usage.limit.maxSpend")}</label>
              <p className="mb-1.5 text-xs text-gray-400">
                {mode === "PAYG" ? t("usage.limit.maxSpendHintPayg") : t("usage.limit.maxSpendHint")}
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">{currency}</span>
                <input
                  type="number" min={0} value={maxMonthlySpend}
                  onChange={(e) => setMaxMonthlySpend(e.target.value)}
                  className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" dir="ltr"
                />
              </div>
              {uncapped && (
                // Unlimited has to be a decision somebody made on purpose, not
                // something they get by clearing a field.
                <p className="mt-2 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700">
                  {t("usage.limit.uncappedWarning")}
                </p>
              )}
              <p className="mt-2 text-xs text-gray-400">{t("usage.limit.windowNote")}</p>
            </div>
          )}

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
