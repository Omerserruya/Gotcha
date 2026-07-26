"use client";

// Usage - the credits center. Customer-facing usage is expressed in GOTCHA
// CREDITS (the wallet the plan grants), never raw model tokens; tokens stay an
// internal accounting detail and live in Analytics, not here. Every number on
// this page comes from ONE canonical contract (GET /api/billing/credit-summary)
// so plan-credit consumption and auto-purchase money-spend can never be
// conflated or recomputed from unrelated analytics events.
//
// Two deliberately separate concepts:
//   1. Plan credit consumption  (credits used / included)   → the top meter
//   2. Auto-purchase money spend ($ spent / monthly limit)  → the usage-credits meter
// Purchases and the spend limit have their own dedicated flows (Buy credits →
// /settings/billing/credits, Adjust limit → /settings/billing/usage-limit).

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getCreditSummary, type CreditSummary } from "@/lib/api-billing";
import clsx from "clsx";

const fmt = (n: number) => Math.round(n).toLocaleString();

export function UsageContent() {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const dateFmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(locale === "he" ? "he-IL" : undefined, { month: "long", day: "numeric" }) : "";
  const money = (amount: string | number | null | undefined, currency = "ILS") => {
    if (amount == null) return "";
    const n = typeof amount === "string" ? Number(amount) : amount;
    try {
      return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${currency} ${n}`;
    }
  };

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setSummary(await getCreditSummary(token));
    } catch (err) {
      console.error("Usage fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    // Stable skeleton: never a flash of "0 credits used" while loading.
    return (
      <div className="p-3 md:p-6 overflow-y-auto h-full">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="h-8 w-48 animate-pulse rounded-xl bg-gray-100" />
          <div className="h-40 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
          <div className="h-32 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
        </div>
      </div>
    );
  }

  const s = summary;
  const uc = s?.usageCredits;

  // ── Plan credit consumption (credits, never tokens) ──
  const included = s?.plan.includedCredits ?? 0;
  const consumed = s?.usage.consumedCredits ?? 0;
  const remainingPlan = s?.usage.remainingPlanCredits ?? 0;
  const pctUsed = s?.usage.consumedPct ?? 0;

  // ── Auto-purchase MONEY spend (separate from credit consumption) ──
  const spent = uc ? Number(uc.spentAmount) : 0;
  const limit = uc?.monthlySpendLimit != null ? Number(uc.monthlySpendLimit) : null;
  const spendPct = limit && limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;

  return (
    <div className="p-3 md:p-6 overflow-y-auto h-full">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("usage.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{t("usage.subtitle")}</p>
        </div>

        {/* ── 1. Plan credit consumption ── */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold text-gray-900">{t("usage.planCredits.title")}</h3>
            {s?.period.resetsAt && (
              <span className="text-xs text-gray-400">{t("usage.planCredits.resets").replace("{date}", dateFmt(s.period.resetsAt))}</span>
            )}
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-gray-900 tabular-nums" dir="ltr">
              {fmt(consumed)} / {fmt(included)}
            </span>
            <span className="text-sm text-gray-500">{t("usage.planCredits.unit")}</span>
            <span className={clsx("ms-auto rounded-full px-2.5 py-0.5 text-xs font-semibold", pctUsed >= 90 ? "bg-red-50 text-red-600" : pctUsed >= 80 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>
              {t("usage.planCredits.pctUsed").replace("{n}", String(pctUsed))}
            </span>
          </div>
          <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className={clsx("h-full rounded-full transition-all", pctUsed >= 90 ? "bg-red-500" : pctUsed >= 80 ? "bg-amber-500" : "bg-primary-500")}
              style={{ width: `${pctUsed}%` }}
            />
          </div>
          <div className="mt-3 text-xs text-gray-500">
            {t("usage.planCredits.remaining").replace("{n}", fmt(remainingPlan))}
          </div>

          {/* What the remaining balance still buys, using the plan's PUBLIC
              commercial ratio. The credit balance above stays authoritative -
              this is an estimate of capacity, not a second balance. */}
          {s?.estimatedRemaining && (s.estimatedRemaining.chats > 0 || s.estimatedRemaining.calls > 0) && (
            <div className="mt-4 rounded-xl bg-gray-50 px-4 py-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                {s.estimatedRemaining.chats > 0 && (
                  <span className="text-gray-600">
                    {t("usage.estimatedRemaining.chats")}{" "}
                    <span className="font-semibold text-gray-900 tabular-nums" dir="ltr">
                      ~{s.estimatedRemaining.chats.toLocaleString()}
                    </span>
                  </span>
                )}
                {s.estimatedRemaining.calls > 0 && (
                  <span className="text-gray-600">
                    {t("usage.estimatedRemaining.calls")}{" "}
                    <span className="font-semibold text-gray-900 tabular-nums" dir="ltr">
                      ~{s.estimatedRemaining.calls.toLocaleString()}
                    </span>
                  </span>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
                {locale === "he" ? s.disclaimer?.he : s.disclaimer?.en}
              </p>
            </div>
          )}
        </div>

        {/* ── POC / Trial banner ── */}
        {s?.evaluation && (
          <div className="rounded-2xl border border-primary-200 bg-primary-50/60 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold text-primary-900">
                {t(`usage.evaluation.${s.evaluation.kind === "POC" ? "poc" : "trial"}Title`)}
              </h3>
              {s.evaluation.expiresAt && (
                <span className="text-xs text-primary-700">
                  {t("usage.evaluation.expires").replace("{date}", dateFmt(s.evaluation.expiresAt))}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-primary-800">
              {t("usage.evaluation.body")
                .replace("{credits}", fmt(s.evaluation.creditCap))
                .replace("{remaining}", fmt(s.totalAvailableCredits))}
            </p>
            <Link href="/settings/billing/plan" className="mt-3 inline-flex text-sm font-medium text-primary-700 hover:text-primary-900">
              {t("usage.evaluation.convertCta")}
            </Link>
          </div>
        )}

        {/* ── 2. Available-credit breakdown (only when >1 source) ── */}
        {s && (s.purchasedCredits.balance > 0 || (s.creditSources && s.creditSources.promotional + s.creditSources.trialOrPoc > 0)) && (
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-900 mb-3">{t("usage.breakdown.title")}</h3>
            <dl className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-gray-500">{t("usage.breakdown.planAllowance")}</dt>
                <dd className="font-medium text-gray-800 tabular-nums" dir="ltr">{fmt(remainingPlan)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-gray-500">{t("usage.breakdown.purchased")}</dt>
                <dd className="font-medium text-emerald-700 tabular-nums" dir="ltr">{fmt(s.purchasedCredits.balance)}</dd>
              </div>
              {/* Promotional and evaluation credits are separate buckets with
                  their own expiry, so they are shown separately rather than
                  folded into "purchased". */}
              {s.creditSources && s.creditSources.promotional > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">{t("usage.breakdown.promotional")}</dt>
                  <dd className="font-medium text-gray-800 tabular-nums" dir="ltr">{fmt(s.creditSources.promotional)}</dd>
                </div>
              )}
              {s.creditSources && s.creditSources.trialOrPoc > 0 && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">{t("usage.breakdown.trialOrPoc")}</dt>
                  <dd className="font-medium text-gray-800 tabular-nums" dir="ltr">{fmt(s.creditSources.trialOrPoc)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-gray-100 pt-1.5">
                <dt className="font-medium text-gray-700">{t("usage.breakdown.total")}</dt>
                <dd className="font-semibold text-gray-900 tabular-nums" dir="ltr">{fmt(s.totalAvailableCredits)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-[11px] text-gray-400">{t("usage.breakdown.order")}</p>
          </div>
        )}

        {/* ── 3+4. Usage credits: auto-purchase state + money-spend limit ── */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">{t("usage.usageCredits.title")}</h3>
              <p className="mt-0.5 text-xs text-gray-500 max-w-md">
                {uc?.enabled ? t("usage.usageCredits.onDesc") : t("usage.usageCredits.offDesc")}
              </p>
            </div>
            <Link
              href="/settings/billing/usage-limit"
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {uc?.enabled ? t("usage.usageCredits.adjustLimit") : t("usage.usageCredits.enable")}
            </Link>
          </div>

          {uc?.enabled ? (
            <div className="mt-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-lg font-semibold text-gray-900 tabular-nums" dir="ltr">
                  {money(spent, uc.currency)} {t("usage.usageCredits.spent")}
                </span>
                {limit != null && (
                  <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", spendPct >= 90 ? "bg-red-50 text-red-600" : spendPct >= 80 ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600")}>
                    {t("usage.planCredits.pctUsed").replace("{n}", String(spendPct))}
                  </span>
                )}
              </div>
              {/* Thin bar - this is MONEY spent on top-ups, NOT plan-credit usage. */}
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className={clsx("h-full rounded-full transition-all", spendPct >= 90 ? "bg-red-500" : spendPct >= 80 ? "bg-amber-500" : "bg-gray-800")}
                  style={{ width: `${spendPct}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500">
                {limit != null && (
                  <span>{t("usage.usageCredits.limitLabel")}: <span className="font-semibold text-gray-800" dir="ltr">{money(limit, uc.currency)}</span></span>
                )}
                {uc.resetsAt && <span>{t("usage.planCredits.resets").replace("{date}", dateFmt(uc.resetsAt))}</span>}
              </div>
            </div>
          ) : (
            <p className="mt-3 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-500">{t("usage.usageCredits.offHint")}</p>
          )}
        </div>

        {/* ── 5+6. Purchased-credit balance + Buy credits ── */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">{t("usage.balance.title")}</h3>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-gray-900 tabular-nums" dir="ltr">{fmt(s?.purchasedCredits.balance ?? 0)}</span>
                <span className="text-sm text-gray-500">{t("usage.planCredits.unit")}</span>
              </div>
            </div>
            <Link
              href="/settings/billing/credits"
              className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              {t("usage.balance.buy")}
            </Link>
          </div>
        </div>

        {/* ── 7. Manage or cancel subscription (Billing owns cancellation) ── */}
        <div className="pt-1">
          <Link href="/settings/billing" className="text-sm font-medium text-gray-500 hover:text-gray-700">
            {t("usage.manageSubscription")}
          </Link>
        </div>
      </div>
    </div>
  );
}
