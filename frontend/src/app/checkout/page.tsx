"use client";

/**
 * Checkout entry point: where the emailed payment link lands.
 *
 * This page decides nothing. It loads the checkout and hands over to whichever
 * of the five outcome pages the SERVER says it belongs on, which is the same
 * self-correction every one of those pages already relies on.
 *
 * That is deliberate. A dispatcher with its own idea of where a status belongs
 * is a second copy of `pathForStatus`, and the two would eventually disagree
 * about something that matters, like whether a paid checkout is still asking
 * for a card.
 *
 * Most visitors never see this page for longer than a redirect. It renders a
 * skeleton rather than nothing so that a slow lookup does not read as a broken
 * link, which is exactly what a blank page means to someone who just clicked
 * through from email to pay.
 */

import { Suspense } from "react";
import { useI18n } from "@/context/I18nContext";
import {
  useCheckout,
  CheckoutShell,
  CheckoutSkeleton,
  CheckoutUnavailableState,
} from "@/components/checkout/CheckoutShell";

function CheckoutEntry() {
  const { t } = useI18n();

  // An empty expected list makes EVERY status unexpected, so the shell's
  // existing redirect runs for all of them. No status belongs on this page.
  const { phase } = useCheckout([]);

  // Covers a link with no reference, an expired or revoked token, and a
  // reference that is not this visitor's. Identical in all three cases by
  // design: an unauthorized visitor must not learn whether a checkout exists.
  if (phase === "unavailable") return <CheckoutUnavailableState />;

  return (
    <CheckoutShell
      eyebrow={t("checkout.opening.eyebrow")}
      heading={t("checkout.opening.title")}
      lede={t("checkout.opening.body")}
    >
      <CheckoutSkeleton />
    </CheckoutShell>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CheckoutEntry />
    </Suspense>
  );
}
