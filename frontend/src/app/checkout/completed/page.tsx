"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/context/I18nContext";
import { resendWelcomeEmail } from "@/lib/api-checkout";
import {
  useCheckout, CheckoutShell, CheckoutSummaryCard, CheckoutSkeleton, CheckoutUnavailableState,
} from "@/components/checkout/CheckoutShell";

/**
 * The end of a paid signup, which is really the START of the account.
 *
 * This page used to be a dead end with a button to "/", which for a visitor
 * with no app session is the public marketing site - so the customer who had
 * just paid was shown the page that sells them what they had bought.
 *
 * The ordering fix upstream is what makes the destination simple again: the
 * provisioning email asks for a password FIRST, so by the time anyone reaches
 * this screen they are signed in, and `/login` forwards them to setup without
 * stopping. Someone who paid a forwarded invoice without signing in lands on
 * the login page instead, which is correct - they are not the admin, and the
 * admin's own way in went to the admin's own inbox.
 */
function Completed() {
  const { t } = useI18n();
  const params = useSearchParams();
  const reference = params?.get("ref") ?? "";
  // Reachable only when the SERVER reports COMPLETED. Landing here from a
  // redirect with any other status is corrected by the shell.
  const { phase, summary } = useCheckout(["COMPLETED"]);

  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function onResend() {
    if (!reference || resend === "sending") return;
    setResend("sending");
    try {
      // No token: the request that brought them here established the checkout
      // cookie, so the reference alone is authorized and nothing sensitive
      // goes back into the address bar.
      await resendWelcomeEmail(reference);
      setResend("sent");
    } catch {
      setResend("failed");
    }
  }

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
            href="/login?next=/setup"
            className="mt-6 inline-flex rounded-xl bg-gray-900 px-5 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
          >
            {t("checkout.action.continue")}
          </Link>

          {/* The quiet repair path. It matters only for the admin whose invoice
              somebody else paid: their welcome email is the one thing carrying
              a way to set a password, so asking for it again must not require
              the permissions they cannot yet hold. */}
          <p className="mt-4 text-[13px] text-gray-500" role="status" aria-live="polite">
            {resend === "sent" ? (
              t("checkout.completed.resendDone")
            ) : resend === "failed" ? (
              t("checkout.completed.resendFailed")
            ) : (
              <>
                {t("checkout.completed.noEmailYet")}{" "}
                <button
                  type="button"
                  onClick={onResend}
                  disabled={resend === "sending" || !reference}
                  className="font-semibold text-primary-600 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {resend === "sending" ? t("checkout.action.resending") : t("checkout.action.resendEmail")}
                </button>
              </>
            )}
          </p>
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
