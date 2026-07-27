"use client";

import { Suspense, useState } from "react";
import { useI18n } from "@/context/I18nContext";
import {
  useCheckout, CheckoutShell, CheckoutSummaryCard, CheckoutSkeleton, CheckoutUnavailableState,
} from "@/components/checkout/CheckoutShell";
import { startPaymentSession } from "@/lib/api-checkout";

function PaymentRequired() {
  const { t } = useI18n();
  const { phase, summary, reference, token } = useCheckout(["PAYMENT_REQUIRED", "AWAITING_PAYMENT_SETUP"]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function beginPayment() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const authToken = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const { redirectUrl } = await startPaymentSession(reference, { token, authToken });
      // A full navigation, not a popup. A hosted card form inside a popup or an
      // iframe teaches people to type card details into a window whose address
      // bar they cannot see, which is the habit phishing depends on.
      window.location.assign(redirectUrl);
    } catch {
      setError(t("checkout.error.paymentSetupFailed"));
      setStarting(false);
    }
  }

  if (phase === "unavailable") return <CheckoutUnavailableState />;

  return (
    <CheckoutShell
      eyebrow={t("checkout.paymentRequired.eyebrow")}
      heading={t("checkout.paymentRequired.title")}
      lede={t("checkout.paymentRequired.body")}
    >
      {phase === "loading" || !summary ? (
        <CheckoutSkeleton />
      ) : (
        <>
          <CheckoutSummaryCard summary={summary} />
          <div className="mt-6">
            {summary.paymentSetupAvailable ? (
              <>
                <button
                  type="button"
                  onClick={beginPayment}
                  disabled={starting}
                  aria-busy={starting}
                  className="w-full rounded-xl bg-gray-900 px-5 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 sm:w-auto"
                >
                  {t("checkout.action.startPayment")}
                </button>
                {error && (
                  <p role="alert" className="mt-3 text-[13px] leading-[1.6] text-red-600">
                    {error}
                  </p>
                )}
              </>
            ) : (
              // Honest, and names no provider or internal limitation.
              <p className="rounded-xl bg-gray-50 px-4 py-3 text-[13px] leading-[1.6] text-gray-600">
                {t("checkout.paymentRequired.unavailable")}
              </p>
            )}
          </div>
        </>
      )}
    </CheckoutShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PaymentRequired />
    </Suspense>
  );
}
