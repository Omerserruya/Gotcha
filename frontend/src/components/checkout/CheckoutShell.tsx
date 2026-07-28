"use client";

/**
 * Customer checkout chrome.
 *
 * One shell behind five routes. It owns fetching, the loading and error states,
 * and self-correction: if the server says a checkout is in a different state
 * than the page you are on, you get moved. That matters because these URLs are
 * emailed, bookmarked and returned to hours later.
 *
 * Deliberately not the app shell. Someone here is not signed in, may never have
 * been, and is deciding whether to trust us with a card.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import {
  advanceCheckout,
  getCheckoutStatus,
  pathForStatus,
  type CheckoutSummary,
  type CheckoutStatus,
} from "@/lib/api-checkout";

type Phase = "loading" | "ready" | "unavailable";

/**
 * Load a checkout, and optionally keep asking the server to move it forward.
 *
 * `drive` is what turns a customer returning from the payment page into a
 * completed checkout. It sends no outcome - only a request to re-check - so
 * this hook cannot make a checkout succeed by claiming it did. Everything it
 * displays comes back from the server afterwards.
 */
export function useCheckout(expected: CheckoutStatus[], opts: { poll?: boolean; drive?: boolean } = {}) {
  const params = useSearchParams();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [summary, setSummary] = useState<CheckoutSummary | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reference = params?.get("ref") ?? "";
  const token = useCheckoutToken(reference, params?.get("token") ?? null);

  useEffect(() => {
    if (!reference) {
      setPhase("unavailable");
      return;
    }
    let cancelled = false;
    const ac = new AbortController();

    const load = async () => {
      try {
        const authToken = typeof window !== "undefined" ? localStorage.getItem("token") : null;

        if (opts.drive) {
          // Ask the server to look again before reading the status, so the
          // customer sees the result of this check rather than the one before
          // it. A failure here is not fatal: the status read below still shows
          // where things stand.
          await advanceCheckout(reference, { token, authToken, signal: ac.signal }).catch(() => {});
        }

        const data = await getCheckoutStatus(reference, { token, authToken, signal: ac.signal });
        if (cancelled) return;
        setSummary(data);
        setPhase("ready");

        // The server is authoritative about which page this belongs on, so a
        // stale link corrects itself rather than showing the wrong story.
        if (!expected.includes(data.status)) {
          const target = pathForStatus(data.status);
          // Only the reference travels. The request that just succeeded also
          // established the checkout cookie, so the next page is authorized
          // without the token being put back into a URL.
          router.replace(`${target}?ref=${encodeURIComponent(reference)}`);
          return;
        }
        // Only the waiting page polls, and only while it is still waiting.
        if (opts.poll && (data.status === "PROCESSING" || data.status === "AWAITING_PAYMENT_SETUP")) {
          timer.current = setTimeout(load, 4000);
        }
      } catch {
        if (!cancelled) setPhase("unavailable");
      }
    };

    load();
    return () => {
      cancelled = true;
      ac.abort();
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference, token]);

  return { phase, summary, reference, token };
}

/**
 * Use the continuation token once, then let the server hold it.
 *
 * The token is a bearer credential for this checkout: it can show the plan and
 * price, start a payment session, and ask the server to charge. It arrives in a
 * URL because it comes from an email, and there it stays - in browser history,
 * in a shared device's autocomplete, and visible in any screen-share, which is
 * a normal thing to do while paying if you have called support.
 *
 * It used to be moved to sessionStorage, which solved the URL and left the
 * credential somewhere any script on the page could read. Now the first
 * authorized request hands it to an HttpOnly cookie scoped to /api/checkout,
 * and the browser carries it from there. Nothing script-readable keeps it, and
 * only the opaque reference stays in the address bar.
 *
 * The token is still stripped from the URL on sight, which is why this runs in
 * a layout effect - the address bar should not hold a credential for however
 * long paint happens to take.
 */
function useCheckoutToken(reference: string, fromUrl: string | null): string | null {
  // Not state: rewriting the URL must not re-run the request effect below,
  // and the value is needed exactly once.
  const [token] = useState<string | null>(fromUrl);

  useLayoutEffect(() => {
    if (!reference || !fromUrl) return;
    // No navigation, so page state and any polling in progress are untouched.
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
  }, [reference, fromUrl]);

  return token;
}

export function CheckoutShell({
  children,
  eyebrow,
  heading,
  lede,
  tone = "neutral",
}: {
  children?: React.ReactNode;
  eyebrow?: string;
  heading: string;
  lede?: string;
  tone?: "neutral" | "positive" | "warning" | "critical";
}) {
  const accent = {
    neutral: "text-primary-500",
    positive: "text-emerald-600",
    warning: "text-amber-600",
    critical: "text-red-600",
  }[tone];

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="mx-auto flex max-w-[640px] items-center px-5 py-5">
          {/* dir="ltr" on the wordmark: in an RTL page the trailing period is
              reordered to the front and the brand reads ".GOTCHA". A name is
              not a sentence and should not be bidi-reordered. */}
          <Link
            href="/"
            dir="ltr"
            className="rounded text-[17px] font-bold tracking-[-0.02em] text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            GOTCHA.
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-5 py-14 sm:py-20">
        {eyebrow && (
          <p className={`mb-3 text-[11px] font-medium uppercase tracking-[0.2em] ${accent}`}>{eyebrow}</p>
        )}
        <h1 className="text-[clamp(1.5rem,4vw,2.125rem)] font-semibold leading-[1.15] tracking-[-0.03em] text-gray-900">
          {heading}
        </h1>
        {lede && <p className="mt-4 text-[15px] leading-[1.7] text-gray-500">{lede}</p>}
        <div className="mt-8">{children}</div>
      </main>
    </div>
  );
}

/** The commercial summary, from the server. Nothing here is computed locally. */
export function CheckoutSummaryCard({ summary }: { summary: CheckoutSummary }) {
  const { t } = useI18n();
  const symbol = summary.currency === "ILS" ? "₪" : "$";
  const charge = summary.charge;
  // The plan is priced in dollars and the card is debited in shekels. Showing
  // only the dollar figure would leave someone unable to recognize the line on
  // their own statement, and that is exactly the sort of surprise that turns
  // into a chargeback.
  const converted = charge && charge.currency !== summary.currency;

  return (
    <div className="rounded-2xl border border-gray-200 p-5">
      {summary.organizationName && (
        <p className="mb-4 text-[13px] text-gray-500">{summary.organizationName}</p>
      )}
      <dl className="space-y-2.5 text-[14px]">
        <Line label={t("checkout.summary.plan")} value={summary.planName} strong />
        <Line
          label={t("checkout.summary.recurring")}
          value={`${symbol}${Number(summary.amount).toLocaleString("en-US")} ${summary.currency}`}
        />
        {converted && (
          <Line
            label={t("checkout.summary.charged")}
            value={`₪${Number(charge!.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
            strong
          />
        )}
        <Line label={t("checkout.summary.credits")} value={summary.includedCredits.toLocaleString()} />
        {/* How often this recurs, stated rather than implied. "Recurring $39"
            leaves someone to guess whether that is monthly or yearly, and the
            two are a factor of twelve apart. */}
        <Line
          label={t("checkout.summary.interval")}
          value={t(
            summary.billingInterval === "ANNUAL"
              ? "checkout.summary.intervalAnnual"
              : "checkout.summary.intervalMonthly",
          )}
        />
        {/* The offer has an expiry, and it is not reissued automatically - a new
            link is a new commercial offer and a deliberate act. Someone who
            leaves this open overnight should know that before they come back. */}
        {summary.expiresAt && (
          <Line label={t("checkout.summary.offerValid")} value={formatExpiry(summary.expiresAt)} />
        )}
      </dl>
      {converted && (
        <p className="mt-3 text-[12.5px] leading-[1.6] text-gray-500">
          {charge!.settled
            ? t("checkout.summary.rateSettled").replace("{rate}", charge!.exchangeRate)
            : t("checkout.summary.rateIndicative").replace("{rate}", charge!.exchangeRate)}
        </p>
      )}
      <p className="mt-4 border-t border-gray-100 pt-3 text-[12.5px] leading-[1.6] text-gray-500">
        {t("checkout.summary.activationNote")}
      </p>
    </div>
  );
}

/**
 * The expiry, to the minute, in the viewer's own timezone.
 *
 * Not a relative "in 3 days": someone reading this is deciding whether to go
 * and find their card now or later, and a date they can check against a
 * calendar answers that better than an interval they have to add to the time
 * they think it is.
 */
function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-semibold text-gray-900" : "text-gray-800"}`} dir="ltr">
        {value}
      </dd>
    </div>
  );
}

/** Stable skeleton. Shows no numerals: a flash of "$0" would misstate the price. */
export function CheckoutSkeleton() {
  return (
    <div className="rounded-2xl border border-gray-200 p-5">
      <div className="h-3 w-28 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
      <div className="mt-5 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-3 w-full animate-pulse rounded bg-gray-50 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

/**
 * The state for a link that is wrong, expired at the edge, or not ours to show.
 *
 * Deliberately identical whatever the cause: an unauthorized visitor must not
 * learn whether a reference was real.
 */
export function CheckoutUnavailableState() {
  const { t } = useI18n();
  return (
    <CheckoutShell
      tone="warning"
      eyebrow={t("checkout.unavailable.eyebrow")}
      heading={t("checkout.unavailable.title")}
      lede={t("checkout.unavailable.body")}
    >
      <Link
        href="/"
        className="inline-flex rounded-xl border border-gray-200 px-5 py-2.5 text-[14px] font-medium text-gray-900 transition-colors hover:border-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
      >
        {t("checkout.action.backHome")}
      </Link>
    </CheckoutShell>
  );
}
