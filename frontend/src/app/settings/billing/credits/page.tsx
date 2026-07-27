"use client";

// Buy usage credits - the dedicated purchase flow. A purchase is a real charge
// through the billing service (iCount): the balance only updates AFTER the
// provider confirms payment, and a receipt/invoice becomes available on Billing.
// Kept off the Usage page so the catalog appears only when the user chooses to
// buy, and so Usage stays a status surface, not a storefront.

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import { track } from "@/lib/analytics";
import {
  getPackages,
  buyCredits,
  getCreditSummary,
  type CreditPackage,
  type CreditSummary,
} from "@/lib/api-billing";

function BuyCreditsInner() {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmPkg, setConfirmPkg] = useState<CreditPackage | null>(null);

  const fmt = (n: number) => Math.round(n).toLocaleString();
  const money = (amount: string | number, currency = "ILS") => {
    const n = typeof amount === "string" ? Number(amount) : amount;
    try {
      return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
    } catch {
      return `${currency} ${n}`;
    }
  };

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [pk, cs] = await Promise.all([
        getPackages(token).catch(() => ({ packages: [] as CreditPackage[] })),
        getCreditSummary(token).catch(() => null),
      ]);
      setPackages(pk.packages || []);
      setSummary(cs);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // One identity per visit to this page. Generated on mount rather than on
  // click, which is what makes a double-click a single purchase.
  const intentRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const purchase = async (pkg: CreditPackage) => {
    if (!token) return;
    setBusy(pkg.key);
    setMsg(null);
    try {
      // Success only after the provider confirms; then refresh the balance.
      // The intent key is per page load and per package, so clicking twice in
      // quick succession is one purchase rather than two charges.
      const r = await buyCredits(token, pkg.key, `${intentRef.current}:${pkg.key}`);
      if (r.outcomeUnknown) {
        // Deliberately not an error, and deliberately not a retry prompt: they
        // may already have been charged.
        setMsg({ kind: "ok", text: t("usage.buy.checking") });
        await load();
        return;
      }
      if (!r.success) throw new Error(r.failureCode || t("usage.buy.failed"));
      track("credits_purchase_confirmed", { package: pkg.key });
      setMsg({ kind: "ok", text: t("usage.buy.done").replace("{n}", fmt(pkg.units)) });
      await load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("usage.buy.failed") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link href="/settings/usage" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
        <svg className="h-4 w-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("usage.buy.back")}
      </Link>

      <div className="mb-6 mt-3 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("usage.buy.pageTitle")}</h1>
          <p className="mt-1 text-sm text-gray-500">{t("usage.buy.pageSubtitle")}</p>
        </div>
        {summary && (
          <div className="text-end">
            <p className="text-xs text-gray-400">{t("usage.balance.title")}</p>
            <p className="text-lg font-bold text-gray-900 tabular-nums" dir="ltr">{fmt(summary.purchasedCredits.balance)}</p>
          </div>
        )}
      </div>

      {msg && (
        <div className={`mb-6 rounded-xl px-4 py-2.5 text-sm border ${msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-50" />)}</div>
      ) : packages.length === 0 ? (
        <p className="text-sm text-gray-500">{t("usage.buy.noPackages")}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {packages.map((pk) => (
            <li key={pk.id} className="flex items-center justify-between gap-4 py-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">{t("usage.buy.credits").replace("{n}", fmt(pk.units))}</p>
                <p className="text-xs text-gray-400" dir="ltr">{money(pk.price, pk.currency)}</p>
              </div>
              <button
                disabled={busy !== null}
                onClick={() => setConfirmPkg(pk)}
                className="shrink-0 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === pk.key ? t("usage.buy.processing") : t("usage.buy.cta")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs text-gray-400">{t("usage.buy.receiptNote")}</p>

      {/* Price review before any charge - a purchase is never one accidental click. */}
      {confirmPkg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-gray-900">{t("usage.buy.confirmTitle")}</h4>
            <p className="mt-2 text-sm text-gray-600">
              {t("usage.buy.confirmBody").replace("{n}", fmt(confirmPkg.units)).replace("{price}", money(confirmPkg.price, confirmPkg.currency))}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmPkg(null)} className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
                {t("usage.buy.cancel")}
              </button>
              <button
                onClick={() => {
                  const pk = confirmPkg;
                  setConfirmPkg(null);
                  void purchase(pk);
                }}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                {t("usage.buy.confirmCta")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BuyCreditsPage() {
  return (
    <RequirePermission perm="settings:billing:manage" redirectTo="/settings/usage">
      <BuyCreditsInner />
    </RequirePermission>
  );
}
