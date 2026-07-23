"use client";

// Adjust plan - the dedicated plan-selection flow. Kept OFF the main Billing
// page so the catalog only appears when the user explicitly chooses to change.
// A change is validated + charged provider-side (upgrades immediate/prorated,
// downgrades scheduled to period end); success is reported only after the
// billing service confirms, then we return to Billing.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { usePermissions } from "@/context/PermissionsContext";
import { RequirePermission } from "@/components/RequirePermission";
import { track } from "@/lib/analytics";
import {
  getSubscription,
  getPlans,
  changePlan,
  migratePlan,
  type Subscription,
  type Plan,
} from "@/lib/api-billing";

interface ConfirmState {
  plan: Plan;
  title: string;
  body: string;
  cta: string;
  onConfirm: () => void;
}

function AdjustPlanInner() {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const router = useRouter();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const dateFmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(locale === "he" ? "he-IL" : undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
  const money = (amount: string | number | null | undefined, currency = "ILS") => {
    if (amount == null) return "";
    const n = typeof amount === "string" ? Number(amount) : amount;
    try {
      return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
    } catch {
      return `${currency} ${n}`;
    }
  };

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [s, p] = await Promise.all([getSubscription(token), getPlans(token)]);
      setSub(s.subscription);
      setPlans(p.plans);
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("settings.billing.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  const isGrandfathered = sub?.planKey === "grandfathered" || sub?.status === "GRANDFATHERED";
  const currentPlan = plans.find((p) => p.key === sub?.planKey);

  const applyChange = async (plan: Plan, migrate: boolean) => {
    if (!token) return;
    setBusy(plan.key);
    setMsg(null);
    try {
      // Only report success once the billing service (and its provider call)
      // confirms - never on the local click.
      await (migrate ? migratePlan(token, plan.key) : changePlan(token, plan.key));
      track("plan_change_confirmed", { plan: plan.key });
      // Return to Billing with the refreshed current-plan state.
      router.push("/settings/billing");
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("settings.billing.actionFailed") });
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div className="h-8 w-48 animate-pulse rounded-xl bg-gray-100" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-gray-50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link href="/settings/billing" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
        <svg className="h-4 w-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("settings.billing.backToBilling")}
      </Link>

      <div className="mb-6 mt-3">
        <h1 className="text-2xl font-bold text-gray-900">{t("settings.billing.adjustPlan")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("settings.billing.adjustPlanSubtitle")}</p>
      </div>

      {msg && (
        <div className={`mb-6 rounded-xl px-4 py-2.5 text-sm border ${msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.text}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plans
          .filter((p) => p.key !== "grandfathered")
          .map((p) => {
            const current = sub?.planKey === p.key;
            const isUpgrade = (currentPlan?.includedAiUnits ?? 0) < p.includedAiUnits;
            return (
              <div key={p.id} className={`rounded-2xl border p-5 ${current ? "border-primary-500 ring-1 ring-primary-500" : "border-gray-200"}`}>
                <div className="font-semibold text-gray-900">{p.name}</div>
                <div className="mt-1 text-2xl font-bold text-gray-900" dir="ltr">
                  {p.salesOnly ? t("settings.billing.custom") : money(p.basePrice, p.currency)}
                </div>
                <div className="text-xs text-gray-500">
                  {p.salesOnly ? t("settings.billing.contactSales") : t(`settings.billing.interval.${(p as any).billingInterval ?? "MONTHLY"}`)}
                </div>
                <div className="mt-3 text-sm text-gray-600">
                  {t("settings.billing.creditsPerMonth").replace("{n}", Math.round(p.includedAiUnits).toLocaleString())}
                </div>
                <div className="mt-4">
                  {current ? (
                    <span className="text-xs font-medium text-primary-600">{t("settings.billing.currentPlan")}</span>
                  ) : p.salesOnly ? (
                    <a href="mailto:sales@gotcha.co.il" className="text-xs font-medium text-primary-600 hover:underline">
                      {t("settings.billing.contactSales")}
                    </a>
                  ) : (
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        setConfirm({
                          plan: p,
                          title: t("settings.billing.changeTitle").replace("{plan}", p.name),
                          body: isGrandfathered
                            ? t("settings.billing.migrateBody").replace("{plan}", p.name)
                            : isUpgrade
                              ? t("settings.billing.upgradeBody").replace("{plan}", p.name)
                              : t("settings.billing.downgradeBody").replace("{plan}", p.name).replace("{date}", dateFmt(sub?.currentPeriodEnd)),
                          cta: t("settings.billing.confirmChange"),
                          onConfirm: () => applyChange(p, !!isGrandfathered),
                        })
                      }
                      className="rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-600 disabled:opacity-50"
                    >
                      {isGrandfathered ? t("settings.billing.choosePlan") : isUpgrade ? t("settings.billing.upgrade") : t("settings.billing.downgrade")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      <p className="mt-4 text-xs text-gray-400">{t("settings.billing.prorationNote")}</p>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-gray-900">{confirm.title}</h4>
            <p className="mt-2 whitespace-pre-line text-sm text-gray-600">{confirm.body}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
                {t("settings.billing.back")}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  c.onConfirm();
                }}
                className="rounded-lg bg-primary-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-primary-600 disabled:opacity-50"
              >
                {confirm.cta}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdjustPlanPage() {
  return (
    <RequirePermission perm="settings:billing:manage" redirectTo="/settings/billing">
      <AdjustPlanInner />
    </RequirePermission>
  );
}
