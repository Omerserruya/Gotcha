"use client";

import { Suspense } from "react";
import { useI18n } from "@/context/I18nContext";
import { useCheckout, CheckoutShell, CheckoutUnavailableState } from "@/components/checkout/CheckoutShell";

function Expired() {
  const { t } = useI18n();
  const { phase } = useCheckout(["EXPIRED"]);

  if (phase === "unavailable") return <CheckoutUnavailableState />;

  return (
    <CheckoutShell
      tone="warning"
      eyebrow={t("checkout.expired.eyebrow")}
      heading={t("checkout.expired.title")}
      // A new link is a deliberate act by an administrator, never automatic:
      // reissuing would silently create a fresh commercial offer.
      lede={t("checkout.expired.body")}
    >
      <a
        href="mailto:support@gotcha.co.il"
        className="inline-flex rounded-xl border border-gray-200 px-5 py-3 text-[14px] font-medium text-gray-900 transition-colors hover:border-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
      >
        {t("checkout.action.requestNewLink")}
      </a>
    </CheckoutShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Expired />
    </Suspense>
  );
}
