"use client";

import { Suspense } from "react";
import { useI18n } from "@/context/I18nContext";
import {
  useCheckout, CheckoutShell, CheckoutSummaryCard, CheckoutSkeleton, CheckoutUnavailableState,
} from "@/components/checkout/CheckoutShell";

function Failed() {
  const { t } = useI18n();
  const { phase, summary } = useCheckout(["FAILED"]);

  if (phase === "unavailable") return <CheckoutUnavailableState />;

  return (
    <CheckoutShell
      tone="critical"
      eyebrow={t("checkout.failed.eyebrow")}
      heading={t("checkout.failed.title")}
      // No decline payload, no provider endpoint, no internal code.
      lede={t("checkout.failed.body")}
    >
      {phase === "loading" || !summary ? (
        <CheckoutSkeleton />
      ) : (
        <>
          <CheckoutSummaryCard summary={summary} />
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {summary.retryEligible && (
              <button
                type="button"
                disabled={!summary.paymentSetupAvailable}
                className="rounded-xl bg-gray-900 px-5 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
              >
                {t("checkout.action.tryAgain")}
              </button>
            )}
            <a
              href="mailto:support@gotcha.co.il"
              className="rounded-xl border border-gray-200 px-5 py-3 text-center text-[14px] font-medium text-gray-900 transition-colors hover:border-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
            >
              {t("checkout.action.contactSupport")}
            </a>
          </div>
        </>
      )}
    </CheckoutShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Failed />
    </Suspense>
  );
}
