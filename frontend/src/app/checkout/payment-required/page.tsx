"use client";

import { Suspense } from "react";
import { useI18n } from "@/context/I18nContext";
import {
  useCheckout, CheckoutShell, CheckoutSummaryCard, CheckoutSkeleton, CheckoutUnavailableState,
} from "@/components/checkout/CheckoutShell";

function PaymentRequired() {
  const { t } = useI18n();
  const { phase, summary } = useCheckout(["PAYMENT_REQUIRED", "AWAITING_PAYMENT_SETUP"]);

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
              <button
                type="button"
                className="w-full rounded-xl bg-gray-900 px-5 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 sm:w-auto"
              >
                {t("checkout.action.startPayment")}
              </button>
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
