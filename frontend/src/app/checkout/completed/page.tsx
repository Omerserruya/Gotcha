"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import {
  useCheckout, CheckoutShell, CheckoutSummaryCard, CheckoutSkeleton, CheckoutUnavailableState,
} from "@/components/checkout/CheckoutShell";

function Completed() {
  const { t } = useI18n();
  // Reachable only when the SERVER reports COMPLETED. Landing here from a
  // redirect with any other status is corrected by the shell.
  const { phase, summary } = useCheckout(["COMPLETED"]);

  if (phase === "unavailable") return <CheckoutUnavailableState />;

  return (
    <CheckoutShell
      tone="positive"
      eyebrow={t("checkout.completed.eyebrow")}
      heading={t("checkout.completed.title")}
      lede={t("checkout.completed.body")}
    >
      {phase === "loading" || !summary ? (
        <CheckoutSkeleton />
      ) : (
        <>
          <CheckoutSummaryCard summary={summary} />
          <Link
            href="/"
            className="mt-6 inline-flex rounded-xl bg-gray-900 px-5 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
          >
            {t("checkout.action.continue")}
          </Link>
        </>
      )}
    </CheckoutShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Completed />
    </Suspense>
  );
}
