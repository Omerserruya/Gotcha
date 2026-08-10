"use client";

// Payment method - the dedicated card-management flow.
//
// GOTCHA never captures or stores raw card data. The card is entered on the
// provider's hosted page; we send the person there and, when they come back,
// ask the SERVER whether a new card exists. Their return proves they came back
// and nothing else, so nothing here reports an outcome - it only asks.

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import {
  getPaymentMethods,
  startPaymentMethodSession,
  confirmPaymentMethod,
  removePaymentMethod,
  type PaymentMethod,
} from "@/lib/api-billing";
import { ReceiptDetailsForm, useBillingIdentity } from "@/components/billing/ReceiptDetailsForm";

/** Survives the round trip to the provider's page, which leaves our origin. */
const SESSION_KEY = "gotcha.paymentMethodSession";

function PaymentMethodInner() {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const he = String(locale ?? "").startsWith("he");
  // Asked BEFORE the card, not after. The name travels with the tokenization
  // session and becomes the provider's client record, so a card stored without
  // it belongs to "GOTCHA customer" forever - and every receipt after it says
  // so. The country is what makes the charge legal to price at all.
  const { identity, setIdentity, loading: identityLoading, complete: identityComplete } = useBillingIdentity();
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

  // Coming back from the hosted page. The server is asked what happened; the
  // URL we arrived on is not evidence of anything, so it is not consulted
  // beyond noticing that we returned.
  const params = useSearchParams();
  useEffect(() => {
    if (!token) return;
    const sessionId = typeof window !== "undefined" ? sessionStorage.getItem(SESSION_KEY) : null;
    if (!sessionId) return;

    let cancelled = false;
    let attempts = 0;

    const check = async () => {
      attempts += 1;
      try {
        const { data } = await confirmPaymentMethod(token, sessionId);
        if (cancelled) return;
        if (data.status === "STORED") {
          sessionStorage.removeItem(SESSION_KEY);
          setMsg({ kind: "ok", text: t("settings.billing.cardSaved") });
          await reload();
          return;
        }
      } catch {
        // A failed check is not a failed card. Keep asking for a while.
      }
      // The provider can take a moment to register the card, so a single "not
      // yet" is not an answer. Give up quietly rather than showing an error for
      // someone who simply changed their mind.
      if (!cancelled && attempts < 10) setTimeout(check, 2000);
      else if (!cancelled) sessionStorage.removeItem(SESSION_KEY);
    };

    check();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, params]);

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

  // Start card entry: ask the server for a destination, remember which session
  // this is, and navigate. A full navigation rather than a popup - a card form
  // in a window whose address bar you cannot see is the habit phishing relies
  // on.
  const addCard = async () => {
    if (!token) return;
    setBusy("add");
    setMsg(null);
    try {
      const { data } = await startPaymentMethodSession(token);
      sessionStorage.setItem(SESSION_KEY, data.sessionId);
      window.location.assign(data.redirectUrl);
    } catch {
      setMsg({ kind: "err", text: t("settings.billing.paymentSetupUnavailable") });
      setBusy(null);
    }
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
          disabled={busy !== null || identityLoading || !identityComplete}
          onClick={addCard}
          className="shrink-0 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {methods.length ? t("settings.billing.replaceCard") : t("settings.billing.addCard")}
        </button>
      </div>

      {/* The receipt details, up front. Collecting them after the card would
          mean the provider's client record is already named wrong, and renaming
          it does not rename the receipts already issued against it. */}
      {!identityLoading && !identityComplete && (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50/50 p-5">
          <h2 className="text-sm font-semibold text-amber-900">
            {he ? "קודם - על שם מי הקבלה?" : "First - who is the receipt for?"}
          </h2>
          <p className="mb-4 mt-1 text-xs text-amber-800">
            {he
              ? "השם הזה יופיע על כל חשבונית מס/קבלה, והמדינה קובעת אם נגבה מע״מ. אי אפשר לשמור כרטיס לפני שהם ידועים."
              : "This name appears on every tax invoice/receipt, and the country decides whether VAT is charged. A card cannot be stored before they are known."}
          </p>
          <ReceiptDetailsForm
            value={identity}
            compact
            onSaved={setIdentity}
            saveLabel={he ? "שמירה והמשך" : "Save and continue"}
          />
        </div>
      )}

      {!identityLoading && identityComplete && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-gray-200 px-4 py-2.5 text-sm">
          <span className="text-gray-600">
            {he ? "הקבלה על שם" : "Receipt made out to"}{" "}
            <span className="font-medium text-gray-900">{identity?.billingName}</span>
            {identity?.vatId && <span className="text-gray-400"> · {identity.vatId}</span>}
            <span className="text-gray-400"> · {identity?.billingCountry}</span>
          </span>
          <Link href="/settings/billing/details" className="shrink-0 text-xs font-medium text-primary-600 hover:underline">
            {he ? "עריכה" : "Edit"}
          </Link>
        </div>
      )}

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
