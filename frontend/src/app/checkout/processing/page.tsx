"use client";

import { Suspense } from "react";
import { useI18n } from "@/context/I18nContext";
import {
  useCheckout, CheckoutShell, CheckoutSummaryCard, CheckoutSkeleton, CheckoutUnavailableState,
} from "@/components/checkout/CheckoutShell";

function Processing() {
  const { t } = useI18n();
  // Polls while waiting. Returning to this page is NOT proof of payment; the
  // server decides, and the shell moves us when it does.
  const { phase, summary } = useCheckout(["PROCESSING", "MANUAL_REVIEW"], { poll: true });

  if (phase === "unavailable") return <CheckoutUnavailableState />;

  const manualReview = summary?.status === "MANUAL_REVIEW";

  return (
    <CheckoutShell
      eyebrow={t("checkout.processing.eyebrow")}
      heading={manualReview ? t("checkout.manualReview.title") : t("checkout.processing.title")}
      lede={manualReview ? t("checkout.manualReview.body") : t("checkout.processing.body")}
    >
      {phase === "loading" || !summary ? (
        <CheckoutSkeleton />
      ) : (
        <>
          <CheckoutSummaryCard summary={summary} />
          <div className="mt-6 flex items-center gap-3" role="status" aria-live="polite">
            {!manualReview && (
              <span
                aria-hidden="true"
                className="h-2 w-2 animate-pulse rounded-full bg-primary-500 motion-reduce:animate-none"
              />
            )}
            <p className="text-[13px] text-gray-500">
              {manualReview ? t("checkout.manualReview.status") : t("checkout.processing.status")}
            </p>
          </div>
        </>
      )}
    </CheckoutShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Processing />
    </Suspense>
  );
}
