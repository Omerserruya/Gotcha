"use client";

// Billing - the subscription center: current plan, plan changes, payment
// method, invoices, cancellation. Credits (balance, packages, auto-purchase)
// live on Settings → Usage - one canonical home per concept, no duplicates.
//
// Everything here is backed by the real billing service (iCount provider):
// upgrades charge immediately (prorated) and only apply on payment success;
// downgrades and cancellation take effect at period end (shown as a
// scheduled change). No action is offered that the provider cannot execute.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { track } from "@/lib/analytics";
import {
  getSubscription,
  getPlans,
  changePlan,
  cancelSubscription,
  resumeSubscription,
  migratePlan,
  getPaymentMethods,
  addPaymentMethod,
  removePaymentMethod,
  getInvoices,
  type Subscription,
  type Plan,
  type PaymentMethod,
  type Invoice,
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

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      {children}
    </div>
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
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const dateFmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(locale === "he" ? "he-IL" : undefined) : "";

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [s, p, pm, inv] = await Promise.all([
        getSubscription(token),
        getPlans(token),
        getPaymentMethods(token).catch(() => ({ paymentMethods: [] as PaymentMethod[] })),
        getInvoices(token).catch(() => ({ invoices: [] as Invoice[] })),
      ]);
      setSub(s.subscription);
      setPlans(p.plans);
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

  // iCount PayPage: in production this opens the hosted page and returns a token.
  // Dev/mock accepts a token directly so the flow is testable end-to-end.
  const addCard = async () => {
    const paypageUrl = process.env.NEXT_PUBLIC_ICOUNT_PAYPAGE_URL;
    if (paypageUrl) {
      window.open(paypageUrl, "icount-paypage", "width=480,height=640");
      // A production integration listens for the page's postMessage with the token.
      return;
    }
    const pageToken = window.prompt(t("settings.billing.devTokenPrompt"), "pt_dev");
    if (!pageToken) return;
    await run("add-card", () => addPaymentMethod(token!, pageToken), t("settings.billing.cardSaved"));
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div className="h-8 w-64 animate-pulse rounded-xl bg-gray-100" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-44 animate-pulse rounded-2xl border border-gray-100 bg-gray-50" />
        ))}
      </div>
    );
  }

  const isGrandfathered = sub?.planKey === "grandfathered" || sub?.status === "GRANDFATHERED";
  const currentPlan = plans.find((p) => p.key === sub?.planKey);
  const statusLabel = (s: string, cancelScheduled: boolean) =>
    cancelScheduled ? t("settings.billing.status.scheduledCancel") : t(`settings.billing.status.${s}`) || s;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("settings.billing.title")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("settings.billing.subtitle")}</p>
      </div>

      {msg && (
        <div className={`rounded-xl px-4 py-2.5 text-sm border ${msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.text}
        </div>
      )}

      {/* ── Subscription summary ── */}
      <Section
        title={t("settings.billing.current")}
        action={sub && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[sub.status] ?? "bg-gray-100"}`}>
            {statusLabel(sub.status, sub.cancelAtPeriodEnd)}
          </span>
        )}
      >
        {!sub ? (
          <p className="text-gray-500">{t("settings.billing.noSubscription")}</p>
        ) : (
          <div className="space-y-2 text-sm text-gray-700">
            <div>
              {t("settings.billing.plan")}: <span className="font-medium">{currentPlan?.name ?? sub.planKey}</span>
              {currentPlan && !currentPlan.salesOnly && (
                <span className="text-gray-500"> · <span dir="ltr">₪{currentPlan.basePrice}</span> {t("settings.billing.perMonth")}</span>
              )}
              {currentPlan && (
                <span className="text-gray-500"> · {t("settings.billing.includedCredits").replace("{n}", Math.round(currentPlan.includedAiUnits).toLocaleString())}</span>
              )}
            </div>
            {sub.currentPeriodStart && sub.currentPeriodEnd && (
              <div>
                {t("settings.billing.period")}: <span dir="ltr">{dateFmt(sub.currentPeriodStart)} - {dateFmt(sub.currentPeriodEnd)}</span>
              </div>
            )}
            {sub.trialEndsAt && <div>{t("settings.billing.trialEnds")}: {dateFmt(sub.trialEndsAt)}</div>}
            {sub.currentPeriodEnd && !sub.cancelAtPeriodEnd && (
              <div>{t("settings.billing.renews")}: {dateFmt(sub.currentPeriodEnd)}</div>
            )}
            {sub.status === "PAST_DUE" && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">{t("settings.billing.pastDueHint")}</div>
            )}
            {sub.pendingChange && !sub.pendingChange.targetPlanKey && (
              <div className="text-amber-700">{t("settings.billing.cancelScheduled").replace("{date}", dateFmt(sub.pendingChange.effectiveAt))}</div>
            )}
            {sub.pendingChange?.targetPlanKey && (
              <div className="text-amber-700">
                {t("settings.billing.downgradeScheduled")
                  .replace("{plan}", plans.find((p) => p.key === sub.pendingChange!.targetPlanKey)?.name ?? sub.pendingChange.targetPlanKey)
                  .replace("{date}", dateFmt(sub.pendingChange.effectiveAt))}
              </div>
            )}
            {sub.cancelAtPeriodEnd && !sub.pendingChange && (
              <div className="text-amber-700">{t("settings.billing.cancelScheduled").replace("{date}", dateFmt(sub.currentPeriodEnd))}</div>
            )}
            {isGrandfathered && <div className="text-purple-700">{t("settings.billing.legacyHint")}</div>}
            <div className="pt-2">
              {sub.cancelAtPeriodEnd ? (
                <button
                  disabled={busy !== null}
                  onClick={() => run("resume", () => resumeSubscription(token!), t("settings.billing.resumed"))}
                  className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {t("settings.billing.resumeCta")}
                </button>
              ) : (
                !isGrandfathered && sub.status !== "CANCELED" && (
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
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {t("settings.billing.cancelCta")}
                  </button>
                )
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ── Plans ── */}
      <Section title={t("settings.billing.plans")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {plans.filter((p) => p.key !== "grandfathered").map((p) => {
            const current = sub?.planKey === p.key;
            const isUpgrade = (currentPlan?.includedAiUnits ?? 0) < p.includedAiUnits;
            return (
              <div key={p.id} className={`rounded-xl border p-4 ${current ? "border-primary-500 ring-1 ring-primary-500" : "border-gray-200"}`}>
                <div className="font-semibold text-gray-900">{p.name}</div>
                <div className="mt-1 text-2xl font-bold text-gray-900" dir="ltr">{p.salesOnly ? t("settings.billing.custom") : `₪${p.basePrice ?? "-"}`}</div>
                <div className="text-xs text-gray-500">{p.salesOnly ? t("settings.billing.contactSales") : t("settings.billing.perMonth")}</div>
                <div className="mt-2 text-sm text-gray-600">{t("settings.billing.creditsPerMonth").replace("{n}", Math.round(p.includedAiUnits).toLocaleString())}</div>
                <div className="mt-3">
                  {current ? (
                    <span className="text-xs font-medium text-primary-600">{t("settings.billing.currentPlan")}</span>
                  ) : p.salesOnly ? (
                    <a href="mailto:sales@gotcha.co.il" className="text-xs font-medium text-primary-600 hover:underline">{t("settings.billing.contactSales")}</a>
                  ) : (
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        setConfirm({
                          title: t("settings.billing.changeTitle").replace("{plan}", p.name),
                          body: isGrandfathered
                            ? t("settings.billing.migrateBody").replace("{plan}", p.name)
                            : isUpgrade
                              ? t("settings.billing.upgradeBody").replace("{plan}", p.name)
                              : t("settings.billing.downgradeBody").replace("{plan}", p.name).replace("{date}", dateFmt(sub?.currentPeriodEnd)),
                          cta: t("settings.billing.confirmChange"),
                          onConfirm: () => {
                            track("plan_change_confirmed", { plan: p.key, upgrade: isUpgrade });
                            void run(
                              `plan-${p.key}`,
                              () => (isGrandfathered ? migratePlan(token!, p.key) : changePlan(token!, p.key)),
                              t("settings.billing.changeDone").replace("{plan}", p.name),
                            );
                          },
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
        <p className="mt-3 text-xs text-gray-400">{t("settings.billing.prorationNote")}</p>
        <p className="mt-1 text-xs text-gray-400">
          {t("settings.billing.creditsMoved")} <Link href="/settings/usage" className="text-primary-600 hover:underline">{t("settings.billing.creditsMovedLink")}</Link>
        </p>
      </Section>

      {/* ── Payment methods ── */}
      <Section
        title={t("settings.billing.payment")}
        action={
          <button
            disabled={busy !== null}
            onClick={addCard}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {methods.length ? t("settings.billing.replaceCard") : t("settings.billing.addCard")}
          </button>
        }
      >
        {methods.length === 0 ? (
          <p className="text-sm text-gray-500">{t("settings.billing.noCard")}</p>
        ) : (
          <ul className="space-y-2">
            {methods.map((m) => (
              <li key={m.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
                <span dir="ltr">
                  {(m.brand ?? "card").toUpperCase()} •••• {m.last4} {m.expMonth && `(${m.expMonth}/${m.expYear})`}{" "}
                  {m.isDefault && <span className="ms-2 text-xs text-primary-600">{t("settings.billing.defaultCard")}</span>}
                </span>
                <button
                  disabled={busy !== null}
                  onClick={() => run(`rm-${m.id}`, () => removePaymentMethod(token!, m.id), t("settings.billing.cardRemoved"))}
                  className="text-xs text-red-600 hover:underline"
                >
                  {t("settings.billing.removeCard")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── Invoices ── */}
      <Section title={t("settings.billing.invoices")}>
        {invoices.length === 0 ? (
          <p className="text-sm text-gray-500">{t("settings.billing.noInvoices")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-xs uppercase text-gray-500">
                <th className="py-2 text-start">{t("settings.billing.invDate")}</th>
                <th className="text-start">{t("settings.billing.invType")}</th>
                <th className="text-start">{t("settings.billing.invAmount")}</th>
                <th className="text-start">{t("settings.billing.invStatus")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-gray-100">
                  <td className="py-2">{dateFmt(inv.createdAt)}</td>
                  <td>{t(`settings.billing.invTypes.${inv.type}`) || inv.type.replace(/_/g, " ").toLowerCase()}</td>
                  <td dir="ltr">₪{inv.amount}</td>
                  <td>{t(`settings.billing.invStatuses.${inv.status}`) || inv.status}</td>
                  <td className="text-end">
                    {inv.providerPdfUrl && (
                      <a href={inv.providerPdfUrl} target="_blank" rel="noreferrer" className="text-primary-600 hover:underline">PDF</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Confirmation modal - no plan change or cancellation from one stray click. */}
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
