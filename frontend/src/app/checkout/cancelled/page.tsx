"use client";

/**
 * The customer closed the hosted payment page without finishing.
 *
 * Nothing happened, and that is the entire message. No card was stored, no
 * charge was attempted, and the checkout is exactly where it was - so this page
 * changes no state at all. It cannot: it is reached by a browser redirect, and
 * a browser arriving somewhere is not an instruction to the server.
 *
 * The expected status is therefore still PAYMENT_REQUIRED. Anything else means
 * the customer got further than they thought, and the shell routes them to
 * whichever page their real status belongs on rather than telling them here
 * that they cancelled something that in fact went through.
 */

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/context/I18nContext";
import { useCheckout, CheckoutShell, CheckoutUnavailableState } from "@/components/checkout/CheckoutShell";

function Cancelled() {
  const { t } = useI18n();
  const params = useSearchParams();
  const reference = params.get("ref") ?? "";
  const { phase } = useCheckout(["PAYMENT_REQUIRED", "AWAITING_PAYMENT_SETUP"]);

  if (phase === "unavailable") return <CheckoutUnavailableState />;

  return (
    <CheckoutShell
      tone="warning"
      eyebrow={t("checkout.cancelled.eyebrow")}
      heading={t("checkout.cancelled.title")}
      lede={t("checkout.cancelled.body")}
    >
      <Link
        href={`/checkout/payment-required?ref=${encodeURIComponent(reference)}`}
        className="inline-flex rounded-xl bg-gray-900 px-5 py-3 text-[14px] font-medium text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
      >
        {t("checkout.action.tryAgain")}
      </Link>
    </CheckoutShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Cancelled />
    </Suspense>
  );
}
