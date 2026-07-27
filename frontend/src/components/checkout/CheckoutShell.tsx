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

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/context/I18nContext";
import {
  getCheckoutStatus,
  pathForStatus,
  type CheckoutSummary,
  type CheckoutStatus,
} from "@/lib/api-checkout";

type Phase = "loading" | "ready" | "unavailable";

export function useCheckout(expected: CheckoutStatus[], opts: { poll?: boolean } = {}) {
  const params = useSearchParams();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [summary, setSummary] = useState<CheckoutSummary | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reference = params?.get("ref") ?? "";
  const token = params?.get("token");

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
        const data = await getCheckoutStatus(reference, { token, authToken, signal: ac.signal });
        if (cancelled) return;
        setSummary(data);
        setPhase("ready");

        // The server is authoritative about which page this belongs on, so a
        // stale link corrects itself rather than showing the wrong story.
        if (!expected.includes(data.status)) {
          const target = pathForStatus(data.status);
          router.replace(`${target}?ref=${encodeURIComponent(reference)}${token ? `&token=${encodeURIComponent(token)}` : ""}`);
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
          <Link
            href="/"
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
        <Line label={t("checkout.summary.credits")} value={summary.includedCredits.toLocaleString()} />
      </dl>
      <p className="mt-4 border-t border-gray-100 pt-3 text-[12.5px] leading-[1.6] text-gray-500">
        {t("checkout.summary.activationNote")}
      </p>
    </div>
  );
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
