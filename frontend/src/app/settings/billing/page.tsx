"use client";

// Billing - the subscription center: current plan, payment method, invoices,
// cancellation. It shows the CURRENT state compactly; the full plan catalog is
// NOT here - "Adjust plan" opens a dedicated flow (/settings/billing/plan), and
// card capture opens the secure provider flow (/settings/billing/payment-method).
// Credits (balance, packages, auto-purchase) live on Settings → Usage - one
// canonical home per concept.
//
// Everything is backed by the real billing service (iCount provider): upgrades
// charge immediately (prorated) and only apply on payment success; downgrades
// and cancellation take effect at period end (shown as a scheduled change).

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { usePermissions } from "@/context/PermissionsContext";
import { track } from "@/lib/analytics";
import {
  getSubscription,
  getPlans,
  cancelSubscription,
  resumeSubscription,
  getPaymentMethods,
  getInvoices,
  getCurrentPricing,
  type Subscription,
  type Plan,
  type PaymentMethod,
  settledCharge,
  type Invoice,
  type CurrentSubscriptionView,
} from "@/lib/api-billing";

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  TRIALING: "bg-blue-100 text-blue-800",
  PAST_DUE: "bg-amber-100 text-amber-800",
  SUSPENDED: "bg-red-100 text-red-800",
  CANCELED: "bg-gray-200 text-gray-700",
  GRANDFATHERED: "bg-purple-100 text-purple-800",
  PENDING: "bg-gray-100 text-gray-600",
  PAUSED: "bg-gray-100 text-gray-600",
};

const INVOICE_STATUS_STYLES: Record<string, string> = {
  PAID: "text-green-700",
  OPEN: "text-blue-700",
  PENDING: "text-amber-700",
  FAILED: "text-red-700",
  REFUNDED: "text-purple-700",
  VOIDED: "text-gray-500",
};

// Section = a labelled band with an optional single action, separated by a hair
// line rather than wrapped in a heavy bordered card. This is the compact,
// low-chrome hierarchy the Billing redesign calls for.
function Section({
  title,
  action,
  children,
  first,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <section className={first ? "" : "border-t border-gray-100 pt-6 mt-6"}>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

interface ConfirmState {
  title: string;
  body: string;
  cta: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
}

export default function BillingSettingsPage() {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const { can } = usePermissions();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  // The subscription's own commercial snapshot. Rendering from this rather than
  // the live plan row is what stops a published price change from restating what
  // an existing customer sees on their own billing page.
  const [current, setCurrent] = useState<CurrentSubscriptionView | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const canCancel = can("settings:billing:cancel");
  const canManage = can("settings:billing:manage");

  const dateFmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(locale === "he" ? "he-IL" : undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
  const money = (amount: string | number | null | undefined, currency = "ILS") => {
    if (amount == null) return "";
    const n = typeof amount === "string" ? Number(amount) : amount;
    try {
      return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${currency} ${n}`;
    }
  };

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [s, p, pm, inv, cur] = await Promise.all([
        getSubscription(token),
        getPlans(token),
        getPaymentMethods(token).catch(() => ({ paymentMethods: [] as PaymentMethod[] })),
        getInvoices(token).catch(() => ({ invoices: [] as Invoice[] })),
        getCurrentPricing(token).catch(() => ({ subscription: null as CurrentSubscriptionView | null })),
      ]);
      setSub(s.subscription);
      setPlans(p.plans);
      setCurrent(cur.subscription);
      setMethods(pm.paymentMethods);
      setInvoices(inv.invoices);
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("settings.billing.loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    if (!token) return;
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: okText });
      await reload();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("settings.billing.actionFailed") });
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <div className="h-8 w-64 animate-pulse rounded-xl bg-gray-100" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-50" />
        ))}
      </div>
    );
  }

  const isGrandfathered = sub?.planKey === "grandfathered" || sub?.status === "GRANDFATHERED";
  const currentPlan = plans.find((p) => p.key === sub?.planKey);
  const statusLabel = (s: string, cancelScheduled: boolean) =>
    cancelScheduled ? t("settings.billing.status.scheduledCancel") : t(`settings.billing.status.${s}`) || s;
  const planDesc = (() => {
    if (!sub) return "";
    const key = `settings.billing.planDesc.${sub.planKey}`;
    const v = t(key);
    return v && v !== key ? v : "";
  })();
  const renewsAt = sub?.currentPeriodEnd;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t("settings.billing.title")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("settings.billing.subtitle")}</p>
      </div>

      {msg && (
        <div className={`mb-6 rounded-xl px-4 py-2.5 text-sm border ${msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.text}
        </div>
      )}

      {/* ── Current plan ── */}
      <Section
        first
        title={t("settings.billing.current")}
        action={
          canManage && !isGrandfathered ? (
            <Link
              href="/settings/billing/plan"
              onClick={() => track("adjust_plan_opened", {})}
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("settings.billing.adjustPlan")}
            </Link>
          ) : isGrandfathered && canManage ? (
            <Link href="/settings/billing/plan" className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
              {t("settings.billing.choosePlan")}
            </Link>
          ) : undefined
        }
      >
        {!sub ? (
          <p className="text-sm text-gray-500">{t("settings.billing.noSubscription")}</p>
        ) : (
          <div className="flex items-start gap-4">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h12A2.25 2.25 0 0120.25 6v12A2.25 2.25 0 0118 20.25H6A2.25 2.25 0 013.75 18V6z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold text-gray-900">{currentPlan?.name ?? sub.planKey}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[sub.status] ?? "bg-gray-100"}`}>
                  {statusLabel(sub.status, sub.cancelAtPeriodEnd)}
                </span>
              </div>
              {planDesc && <p className="mt-0.5 text-sm text-gray-500">{planDesc}</p>}
              <div className="mt-2 space-y-0.5 text-sm text-gray-600">
                {/* Contracted terms, from the snapshot when there is one. */}
                {current ? (
                  <div>
                    {current.includedCredits > 0 && (
                      <span>{t("settings.billing.includedCredits").replace("{n}", current.includedCredits.toLocaleString())}</span>
                    )}
                    <span className="text-gray-400">
                      {current.includedCredits > 0 ? " · " : ""}
                      <span dir="ltr">{current.monthlyPrice.display.formatted}</span>
                      {" / "}
                      {t("settings.billing.interval.MONTHLY")}
                    </span>
                  </div>
                ) : currentPlan ? (
                  <div>
                    {currentPlan.includedAiUnits > 0 && (
                      <span>{t("settings.billing.includedCredits").replace("{n}", Math.round(currentPlan.includedAiUnits).toLocaleString())}</span>
                    )}
                    {!currentPlan.salesOnly && currentPlan.basePrice != null && (
                      <span className="text-gray-400">
                        {currentPlan.includedAiUnits > 0 ? " · " : ""}
                        <span dir="ltr">{money(currentPlan.basePrice, currentPlan.currency)}</span>
                        {" / "}
                        {t(`settings.billing.interval.${(currentPlan as any).billingInterval ?? "MONTHLY"}`)}
                      </span>
                    )}
                  </div>
                ) : null}

                {/* Selected recurring volume, when the plan offers a selector. */}
                {current && (current.chatDailyVolume != null || current.voiceDailyVolume != null) && (
                  <div className="text-gray-500">
                    {current.chatDailyVolume != null && (
                      <span>
                        {t("settings.billing.pricing.chatVolume")}:{" "}
                        <span dir="ltr">{current.chatDailyVolume}</span> {t("settings.billing.pricing.perBusinessDay")}
                      </span>
                    )}
                    {current.chatDailyVolume != null && current.voiceDailyVolume != null && " · "}
                    {current.voiceDailyVolume != null && (
                      <span>
                        {t("settings.billing.pricing.voiceVolume")}:{" "}
                        <span dir="ltr">{current.voiceDailyVolume}</span> {t("settings.billing.pricing.perBusinessDay")}
                      </span>
                    )}
                  </div>
                )}

                {/* Estimated capacity, using the plan's PUBLIC commercial ratio. */}
                {current && (current.estimate.chat.monthly > 0 || current.estimate.voice.monthly > 0) && (
                  <div className="text-gray-500">
                    {current.estimate.chat.monthly > 0 && (
                      <span>
                        {t("settings.billing.pricing.estimatedChats")}:{" "}
                        <span dir="ltr">~{current.estimate.chat.monthly.toLocaleString()}</span>
                      </span>
                    )}
                    {current.estimate.chat.monthly > 0 && current.estimate.voice.monthly > 0 && " · "}
                    {current.estimate.voice.monthly > 0 && (
                      <span>
                        {t("settings.billing.pricing.estimatedCalls")}:{" "}
                        <span dir="ltr">~{current.estimate.voice.monthly.toLocaleString()}</span>
                      </span>
                    )}
                  </div>
                )}
                {renewsAt && !sub.cancelAtPeriodEnd && (
                  <div>{t("settings.billing.renewsOn").replace("{date}", dateFmt(renewsAt))}</div>
                )}
                {sub.trialEndsAt && <div className="text-gray-500">{t("settings.billing.trialEnds")}: {dateFmt(sub.trialEndsAt)}</div>}
                {sub.pendingChange?.targetPlanKey && (
                  <div className="text-amber-700">
                    {t("settings.billing.downgradeScheduled")
                      .replace("{plan}", plans.find((p) => p.key === sub.pendingChange!.targetPlanKey)?.name ?? sub.pendingChange.targetPlanKey)
                      .replace("{date}", dateFmt(sub.pendingChange.effectiveAt))}
                  </div>
                )}
                {(sub.cancelAtPeriodEnd || (sub.pendingChange && !sub.pendingChange.targetPlanKey)) && (
                  <div className="text-amber-700">
                    {t("settings.billing.cancelScheduled").replace("{date}", dateFmt(sub.pendingChange?.effectiveAt ?? sub.currentPeriodEnd))}
                  </div>
                )}
                {sub.status === "PAST_DUE" && (
                  <div className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-amber-800">{t("settings.billing.pastDueHint")}</div>
                )}
                {isGrandfathered && <div className="text-purple-700">{t("settings.billing.legacyHint")}</div>}
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* ── Payment ── */}
      <Section
        title={t("settings.billing.payment")}
        action={
          canManage ? (
            <Link href="/settings/billing/payment-method" className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
              {methods.length ? t("settings.billing.update") : t("settings.billing.addCard")}
            </Link>
          ) : undefined
        }
      >
        {methods.length === 0 ? (
          <p className="text-sm text-gray-500">{t("settings.billing.noCard")}</p>
        ) : (
          <div className="space-y-1">
            {methods.map((m) => (
              <div key={m.id} className="flex items-center gap-3 text-sm text-gray-700">
                <span className="flex h-6 w-9 items-center justify-center rounded border border-gray-200 bg-gray-50 text-[10px] font-semibold uppercase text-gray-500" dir="ltr">
                  {(m.brand ?? "card").slice(0, 4)}
                </span>
                <span dir="ltr">
                  {t("settings.billing.cardEndingIn").replace("{brand}", (m.brand ?? "Card")).replace("{last4}", m.last4 ?? "----")}
                </span>
                {m.expMonth && (
                  <span className="text-gray-400" dir="ltr">
                    {t("settings.billing.expires")} {String(m.expMonth).padStart(2, "0")}/{String(m.expYear).slice(-2)}
                  </span>
                )}
                {m.isDefault && <span className="text-xs text-primary-600">{t("settings.billing.defaultCard")}</span>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Invoices ── */}
      <Section title={t("settings.billing.invoices")}>
        {invoices.length === 0 ? (
          <p className="text-sm text-gray-500">{t("settings.billing.noInvoices")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-xs uppercase tracking-wider text-gray-400">
                <th className="pb-2 text-start font-medium">{t("settings.billing.invDate")}</th>
                <th className="pb-2 text-start font-medium">{t("settings.billing.invAmount")}</th>
                <th className="pb-2 text-start font-medium">{t("settings.billing.invStatus")}</th>
                <th className="pb-2 text-end font-medium">{t("settings.billing.invAction")}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-gray-50">
                  <td className="py-2.5 text-gray-700">{dateFmt(inv.createdAt)}</td>
                  <td className="py-2.5 text-gray-700" dir="ltr">
                    {money(inv.amount, inv.currency)}
                    {/* The shekel figure, when it differs. This is the number on
                        the customer's bank statement - showing only the invoice
                        currency is what makes people ring up asking what the
                        other charge was. */}
                    {(() => {
                      const charge = settledCharge(inv);
                      if (!charge || charge.chargeCurrency === inv.currency) return null;
                      return (
                        <span className="block text-xs text-gray-400">
                          {money(charge.chargeAmount!, charge.chargeCurrency!)}
                        </span>
                      );
                    })()}
                  </td>
                  <td className={`py-2.5 font-medium ${INVOICE_STATUS_STYLES[inv.status] ?? "text-gray-600"}`}>
                    {t(`settings.billing.invStatuses.${inv.status}`) || inv.status}
                  </td>
                  <td className="py-2.5 text-end">
                    {inv.providerPdfUrl ? (
                      <a href={inv.providerPdfUrl} target="_blank" rel="noreferrer" className="font-medium text-primary-600 hover:underline">
                        {t("settings.billing.view")}
                      </a>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* ── Cancellation ──
          Always present. "Where do I cancel?" must have an answer on this page
          in every state - a workspace with no subscription used to drop the
          section entirely, which reads as a missing button rather than as
          nothing to cancel. */}
      <Section title={t("settings.billing.cancellation")}>
        {!sub ? (
          <p className="max-w-xl text-sm text-gray-500">{t("settings.billing.cancelNothingToCancel")}</p>
        ) : isGrandfathered ? (
          <p className="max-w-xl text-sm text-gray-500">{t("settings.billing.cancelLegacyPlan")}</p>
        ) : sub.status === "CANCELED" ? (
          <p className="max-w-xl text-sm text-gray-500">{t("settings.billing.cancelAlreadyCanceled")}</p>
        ) : (
          <>
          {sub.cancelAtPeriodEnd ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-amber-700">
                {t("settings.billing.cancelScheduled").replace("{date}", dateFmt(sub.pendingChange?.effectiveAt ?? sub.currentPeriodEnd))}
              </p>
              {canCancel && (
                <button
                  disabled={busy !== null}
                  onClick={() => run("resume", () => resumeSubscription(token!), t("settings.billing.resumed"))}
                  className="shrink-0 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {t("settings.billing.resumeCta")}
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="max-w-xl text-sm text-gray-500">
                {t("settings.billing.cancelExplain").replace("{date}", dateFmt(sub.currentPeriodEnd))}
              </p>
              {canCancel ? (
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    setConfirm({
                      title: t("settings.billing.cancelTitle"),
                      body: t("settings.billing.cancelBody").replace("{date}", dateFmt(sub.currentPeriodEnd)),
                      cta: t("settings.billing.cancelCta"),
                      tone: "danger",
                      onConfirm: () => {
                        track("subscription_cancel_confirmed", {});
                        void run("cancel", () => cancelSubscription(token!), t("settings.billing.cancelDone"));
                      },
                    })
                  }
                  className="shrink-0 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  {t("settings.billing.cancelCta")}
                </button>
              ) : (
                <span className="shrink-0 text-xs text-gray-400">{t("settings.billing.cancelNoPermission")}</span>
              )}
            </div>
          )}
          </>
        )}
      </Section>

      {/* Confirmation modal - cancellation is never one stray click. */}
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
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  c.onConfirm();
                }}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold text-white ${confirm.tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-primary-500 hover:bg-primary-600"}`}
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
