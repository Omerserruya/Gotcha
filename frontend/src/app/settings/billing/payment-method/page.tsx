"use client";

// Payment method - the dedicated card-management flow. GOTCHA never captures or
// stores raw card data: capture happens on the iCount hosted PayPage (or, in
// dev/mock, a page-token prompt), and only the resulting provider token reaches
// our backend. Kept on its own route so the main Billing page stays compact.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import {
  getPaymentMethods,
  addPaymentMethod,
  removePaymentMethod,
  type PaymentMethod,
} from "@/lib/api-billing";

function PaymentMethodInner() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const pm = await getPaymentMethods(token).catch(() => ({ paymentMethods: [] as PaymentMethod[] }));
      setMethods(pm.paymentMethods);
    } finally {
      setLoading(false);
    }
  }, [token]);

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

  // Secure payment setup is NOT available yet.
  //
  // The previous implementation opened a provider popup and accepted a token
  // the BROWSER posted back, and fell through to window.prompt when no page URL
  // was configured - which let anyone type a payment token straight into the
  // application. Both are gone: a provider token must never originate in a
  // browser, and neither the popup contract nor the redirect replacement is
  // verified yet.
  //
  // Tests inject provider fixtures directly through the billing service; there
  // is deliberately no application route that accepts a client-supplied token.
  const addCard = () => {
    setMsg({ kind: "err", text: t("settings.billing.paymentSetupUnavailable") });
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link href="/settings/billing" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
        <svg className="h-4 w-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("settings.billing.backToBilling")}
      </Link>

      <div className="mb-6 mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("settings.billing.payment")}</h1>
          <p className="mt-1 text-sm text-gray-500">{t("settings.billing.paymentSubtitle")}</p>
        </div>
        <button
          disabled={busy !== null}
          onClick={addCard}
          className="shrink-0 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {methods.length ? t("settings.billing.replaceCard") : t("settings.billing.addCard")}
        </button>
      </div>

      {msg && (
        <div className={`mb-6 rounded-xl px-4 py-2.5 text-sm border ${msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="h-16 animate-pulse rounded-xl bg-gray-50" />
      ) : methods.length === 0 ? (
        <p className="text-sm text-gray-500">{t("settings.billing.noCard")}</p>
      ) : (
        <ul className="space-y-2">
          {methods.map((m) => (
            <li key={m.id} className="flex items-center justify-between rounded-xl border border-gray-200 px-4 py-3 text-sm">
              <div className="flex items-center gap-3">
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
              <button
                disabled={busy !== null}
                onClick={() => run(`rm-${m.id}`, () => removePaymentMethod(token!, m.id), t("settings.billing.cardRemoved"))}
                className="text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                {t("settings.billing.removeCard")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs text-gray-400">{t("settings.billing.pciNote")}</p>
    </div>
  );
}

export default function PaymentMethodPage() {
  return (
    <RequirePermission perm="settings:billing:manage" redirectTo="/settings/billing">
      <PaymentMethodInner />
    </RequirePermission>
  );
}
