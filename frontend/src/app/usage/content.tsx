"use client";

// Usage - the credits center. Customer-facing usage is expressed in GOTCHA
// credits (the wallet the plan grants), never raw model tokens; tokens stay
// an internal accounting detail. This page is also the canonical home for
// credit purchases and the auto-purchase spending cap (ownership map:
// "Credits and auto-purchase → Settings → Usage"), while Billing keeps the
// subscription, payment methods and invoices.

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getUsageStats, getUsageDaily, getUsageLogs } from "@/lib/api";
import {
  getBalance,
  getSubscription,
  getPackages,
  buyCredits,
  getAutoPurchase,
  setAutoPurchase,
  type Balance,
  type Subscription,
  type CreditPackage,
  type AutoPurchasePolicy,
} from "@/lib/api-billing";
import { track } from "@/lib/analytics";
import clsx from "clsx";

type Period = 7 | 30 | 90 | 365;

const TYPE_COLORS: Record<string, string> = {
  ai_tokens: "bg-violet-500",
  message_sent: "bg-blue-500",
  tool_call: "bg-emerald-500",
  automation_run: "bg-amber-500",
};

const TYPE_BG: Record<string, string> = {
  ai_tokens: "bg-violet-50 text-violet-700 border-violet-200",
  message_sent: "bg-blue-50 text-blue-700 border-blue-200",
  tool_call: "bg-emerald-50 text-emerald-700 border-emerald-200",
  automation_run: "bg-amber-50 text-amber-700 border-amber-200",
};

const fmt = (n: number) => Math.round(n).toLocaleString();

export function UsageContent() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>(30);
  const [stats, setStats] = useState<Record<string, { total: number; count: number }>>({});
  const [daily, setDaily] = useState<Array<{ date: string; type: string; total: number }>>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [policy, setPolicy] = useState<AutoPurchasePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmPackage, setConfirmPackage] = useState<CreditPackage | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [statsRes, dailyRes, logsRes, balRes, subRes, pkRes, apRes] = await Promise.all([
        getUsageStats(token, period),
        getUsageDaily(token, period),
        getUsageLogs(token, { limit: 20 }),
        getBalance(token).catch(() => null),
        getSubscription(token).catch(() => null),
        getPackages(token).catch(() => ({ packages: [] as CreditPackage[] })),
        getAutoPurchase(token).catch(() => ({ policy: null })),
      ]);
      setStats(statsRes.data?.stats || {});
      setDaily(dailyRes.data || []);
      setLogs(logsRes.data || []);
      setBalance(balRes);
      setSub(subRes?.subscription ?? null);
      setPackages(pkRes.packages || []);
      setPolicy(apRes.policy);
    } catch (err) {
      console.error("Usage fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const runBilling = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    if (!token) return;
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: okText });
      await fetchData();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("usage.actionFailed") });
    } finally {
      setBusy(null);
    }
  };

  const statCards = [
    { key: "ai_tokens", icon: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" },
    { key: "message_sent", icon: "M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" },
    { key: "tool_call", icon: "M11.42 15.17l-5.66 5.66a2.25 2.25 0 01-3.182-3.182l5.66-5.66m3.182 3.182l5.66-5.66a2.25 2.25 0 00-3.182-3.182l-5.66 5.66m3.182 3.182L12 21m-3.182-3.182L3 12" },
    { key: "automation_run", icon: "M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" },
  ];

  // Compute max for bar chart
  const dailyByDate = daily.reduce<Record<string, Record<string, number>>>((acc, d) => {
    if (!acc[d.date]) acc[d.date] = {};
    acc[d.date][d.type] = (acc[d.date][d.type] || 0) + d.total;
    return acc;
  }, {});
  const dates = Object.keys(dailyByDate).sort();
  const maxDaily = Math.max(1, ...dates.map((d) => Object.values(dailyByDate[d]).reduce((a, b) => a + b, 0)));

  // ── Credits math (from the real wallet, never guessed client-side) ──
  const allowance = balance?.includedAllowance ?? 0;
  const usedIncluded = Math.max(0, allowance - (balance?.includedRemaining ?? 0));
  const pctUsed = allowance > 0 ? Math.min(100, Math.round((usedIncluded / allowance) * 100)) : 0;
  const periodStart = sub?.currentPeriodStart ? new Date(sub.currentPeriodStart) : null;
  const periodEnd = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const daysElapsed = periodStart ? Math.max(0, (Date.now() - periodStart.getTime()) / 86_400_000) : 0;
  const dailyRate = daysElapsed >= 3 ? usedIncluded / daysElapsed : 0;
  const totalRemaining = (balance?.includedRemaining ?? 0) + (balance?.purchasedRemaining ?? 0);
  // Only show an exhaustion date when the estimate is meaningful: real spend
  // history, real budget, and it runs out before the period renews.
  const exhaustionDate =
    dailyRate > 0 && totalRemaining > 0 ? new Date(Date.now() + (totalRemaining / dailyRate) * 86_400_000) : null;
  const showExhaustion = !!exhaustionDate && (!periodEnd || exhaustionDate < periodEnd);

  return (
      <div className="p-3 md:p-6 overflow-y-auto h-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("usage.title")}</h1>
            <p className="text-sm text-gray-400 mt-0.5">{t("usage.subtitle")}</p>
          </div>
          <select
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value) as Period)}
            className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none"
          >
            <option value={7}>{t("usage.last7days")}</option>
            <option value={30}>{t("usage.last30days")}</option>
            <option value={90}>{t("usage.last90days")}</option>
            <option value={365}>{t("usage.allTime")}</option>
          </select>
        </div>

        {loading ? (
          // Stable skeleton: never a flash of "0 credits used" while loading.
          <div className="max-w-5xl space-y-6">
            <div className="h-40 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-32 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
              ))}
            </div>
            <div className="h-64 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
          </div>
        ) : (
          <div className="max-w-5xl space-y-6">
            {msg && (
              <div className={clsx("rounded-xl px-4 py-2.5 text-sm border", msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200")}>
                {msg.text}
              </div>
            )}

            {/* ── Monthly credits (the wallet) ── */}
            {balance && allowance > 0 && (
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-gray-900">{t("usage.credits.title")}</h3>
                  {periodStart && periodEnd && (
                    <span className="text-xs text-gray-400">
                      {t("usage.credits.period")}: <span dir="ltr">{periodStart.toLocaleDateString()} - {periodEnd.toLocaleDateString()}</span>
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-gray-900 tabular-nums" dir="ltr">
                    {fmt(usedIncluded)} / {fmt(allowance)}
                  </span>
                  <span className="text-sm text-gray-500">{t("usage.credits.monthly")}</span>
                  <span className={clsx("ms-auto rounded-full px-2.5 py-0.5 text-xs font-semibold", pctUsed >= 90 ? "bg-red-50 text-red-600" : pctUsed >= 80 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>
                    {pctUsed}%
                  </span>
                </div>
                <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={clsx("h-full rounded-full transition-all", pctUsed >= 90 ? "bg-red-500" : pctUsed >= 80 ? "bg-amber-500" : "bg-primary-500")}
                    style={{ width: `${pctUsed}%` }}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500">
                  <span>{t("usage.credits.remaining")}: <span className="font-semibold text-gray-800">{fmt(balance.includedRemaining)}</span></span>
                  {balance.purchasedRemaining > 0 && (
                    <span>{t("usage.credits.purchased")}: <span className="font-semibold text-emerald-700">{fmt(balance.purchasedRemaining)}</span></span>
                  )}
                  {dailyRate > 0 && (
                    <span>{t("usage.credits.pace").replace("{n}", fmt(dailyRate))}</span>
                  )}
                  {showExhaustion && exhaustionDate && (
                    <span className="text-amber-700">
                      {t("usage.credits.runsOut").replace("{date}", exhaustionDate.toLocaleDateString())}
                    </span>
                  )}
                </div>
                {totalRemaining <= 0 && (
                  <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
                    {policy?.enabled ? t("usage.credits.exhaustedAuto") : t("usage.credits.exhausted")}
                  </p>
                )}
              </div>
            )}

            {/* Stat Cards - activity by category (counts, never model tokens) */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {statCards.map(({ key, icon }) => (
                <div key={key} className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={clsx("w-9 h-9 rounded-xl flex items-center justify-center", TYPE_BG[key])}>
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                      </svg>
                    </div>
                  </div>
                  <p className="text-2xl font-bold text-gray-900">
                    {(key === "ai_tokens" ? stats[key]?.count || 0 : stats[key]?.total || 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{t(`usage.${key}`)}</p>
                  {key !== "ai_tokens" && (
                    <p className="text-[10px] text-gray-300 mt-0.5">{t("usage.eventsCount").replace("{n}", String(stats[key]?.count || 0))}</p>
                  )}
                </div>
              ))}
            </div>

            {/* Daily Chart */}
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">{t("usage.usageOverTime")}</h3>
              {dates.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">{t("usage.noUsage")}</p>
              ) : (
                <div className="space-y-1.5">
                  {dates.slice(-14).map((date) => {
                    const dayTotal = Object.values(dailyByDate[date]).reduce((a, b) => a + b, 0);
                    return (
                      <div key={date} className="flex items-center gap-3">
                        <span className="text-xs text-gray-400 w-20 shrink-0">{new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                        <div className="flex-1 h-6 bg-gray-50 rounded-lg overflow-hidden flex">
                          {Object.entries(dailyByDate[date]).map(([type, val]) => (
                            <div
                              key={type}
                              className={clsx("h-full transition-all", TYPE_COLORS[type] || "bg-gray-300")}
                              style={{ width: `${(val / maxDaily) * 100}%` }}
                              title={`${t(`usage.${type}`)}: ${val.toLocaleString()}`}
                            />
                          ))}
                        </div>
                        <span className="text-xs text-gray-500 w-16 text-end">{dayTotal.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Legend */}
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-gray-100">
                {Object.entries(TYPE_COLORS).map(([type, color]) => (
                  <div key={type} className="flex items-center gap-1.5">
                    <div className={clsx("w-2.5 h-2.5 rounded-full", color)} />
                    <span className="text-xs text-gray-500">{t(`usage.${type}`)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Buy additional credits ── */}
            {packages.length > 0 && (
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <h3 className="font-semibold text-gray-900 mb-1">{t("usage.buy.title")}</h3>
                <p className="text-xs text-gray-400 mb-4">{t("usage.buy.subtitle")}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {packages.map((pk) => (
                    <div key={pk.id} className="rounded-xl border border-gray-200 p-4">
                      <div className="font-semibold text-gray-900">{t("usage.buy.credits").replace("{n}", fmt(pk.units))}</div>
                      <div className="text-lg font-bold text-gray-900" dir="ltr">₪{pk.price}</div>
                      <button
                        disabled={busy !== null}
                        onClick={() => setConfirmPackage(pk)}
                        className="mt-2 w-full rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {t("usage.buy.cta")}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Price review before any charge - a purchase is never one accidental click. */}
            {confirmPackage && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
                <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
                  <h4 className="text-base font-semibold text-gray-900">{t("usage.buy.confirmTitle")}</h4>
                  <p className="mt-2 text-sm text-gray-600">
                    {t("usage.buy.confirmBody")
                      .replace("{n}", fmt(confirmPackage.units))
                      .replace("{price}", `₪${confirmPackage.price}`)}
                  </p>
                  <div className="mt-5 flex justify-end gap-2">
                    <button onClick={() => setConfirmPackage(null)} className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
                      {t("usage.buy.cancel")}
                    </button>
                    <button
                      onClick={() => {
                        const pk = confirmPackage;
                        setConfirmPackage(null);
                        track("credits_purchase_confirmed", { package: pk.key });
                        void runBilling(`buy-${pk.key}`, async () => {
                          const r = await buyCredits(token!, pk.key);
                          if (!r.success) throw new Error(r.failureCode || t("usage.buy.failed"));
                        }, t("usage.buy.done").replace("{n}", fmt(pk.units)));
                      }}
                      className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
                    >
                      {t("usage.buy.confirmCta")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Auto-purchase + monthly spending cap (backend-enforced) ── */}
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-1">{t("usage.auto.title")}</h3>
              <p className="text-xs text-gray-400 mb-4">{t("usage.auto.subtitle")}</p>
              <AutoPurchaseForm
                t={t}
                policy={policy}
                packages={packages}
                busy={busy !== null}
                onSave={(p) => runBilling("autopurchase", () => setAutoPurchase(token!, p), t("usage.auto.saved"))}
              />
            </div>

            {/* Recent Activity */}
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">{t("usage.recentActivity")}</h3>
              {logs.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">{t("usage.noUsage")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-400 text-xs border-b border-gray-100">
                        <th className="text-start pb-2 font-medium">{t("usage.type")}</th>
                        <th className="text-end pb-2 font-medium">{t("usage.quantity")}</th>
                        <th className="text-end pb-2 font-medium">{t("usage.date")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log: any) => (
                        <tr key={log.id} className="border-b border-gray-50">
                          <td className="py-2.5">
                            <span className={clsx("text-xs px-2 py-0.5 rounded-full border font-medium", TYPE_BG[log.type] || "bg-gray-50 text-gray-500 border-gray-200")}>
                              {t(`usage.${log.type}`)}
                            </span>
                          </td>
                          <td className="text-end text-gray-700 font-medium">{log.quantity.toLocaleString()}</td>
                          <td className="text-end text-gray-400 text-xs">{new Date(log.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
  );
}

// Auto-purchase controls. The ceiling is enforced server-side
// (AutoPurchasePolicy.maxMonthlySpend, checked by the billing service before
// every automatic charge) - this form only edits the policy; it is not the
// enforcement.
function AutoPurchaseForm({
  t, policy, packages, busy, onSave,
}: {
  t: (k: string) => string;
  policy: AutoPurchasePolicy | null;
  packages: CreditPackage[];
  busy: boolean;
  onSave: (p: Partial<AutoPurchasePolicy>) => void;
}) {
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [thresholdPct, setThresholdPct] = useState(policy?.thresholdPct ?? 10);
  const [packageKey, setPackageKey] = useState(policy?.packageKey ?? (packages[0]?.key ?? ""));
  const [maxMonthlySpend, setMaxMonthlySpend] = useState(policy?.maxMonthlySpend ?? "1000");

  useEffect(() => {
    if (policy) {
      setEnabled(policy.enabled);
      setThresholdPct(policy.thresholdPct);
      setPackageKey(policy.packageKey ?? packages[0]?.key ?? "");
      setMaxMonthlySpend(policy.maxMonthlySpend ?? "1000");
    }
  }, [policy, packages]);

  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>{t("usage.auto.enable")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs text-gray-500">{t("usage.auto.threshold")}</span>
          <input type="number" min={1} max={50} value={thresholdPct} onChange={(e) => setThresholdPct(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1" dir="ltr" />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">{t("usage.auto.package")}</span>
          <select value={packageKey} onChange={(e) => setPackageKey(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1">
            {packages.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">{t("usage.auto.maxSpend")}</span>
          <input type="number" min={0} value={maxMonthlySpend} onChange={(e) => setMaxMonthlySpend(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1" dir="ltr" />
        </label>
      </div>
      <p className="text-[11px] text-gray-400">{t("usage.auto.capNote")}</p>
      <button disabled={busy} onClick={() => onSave({ enabled, thresholdPct, packageKey, maxMonthlySpend })}
        className="rounded-lg bg-primary-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50">
        {t("usage.auto.save")}
      </button>
    </div>
  );
}
