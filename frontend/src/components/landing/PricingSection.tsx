"use client";

// Landing-page pricing preview.
//
// An editorial section, not a compressed copy of /pricing. It answers three
// questions and then gets out of the way: what does it cost, what do I get for
// it, and where do I read the detail.
//
// It shares the public catalog with /pricing, so a published price change moves
// both surfaces at once and they cannot drift.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  getPublicPricing,
  quoteSelection,
  defaultSelection,
  publicPricingEnabled,
  type PublicPlan,
} from "@/lib/api-public-pricing";

interface Props {
  t: (key: string, vars?: Record<string, string>) => string;
  isRtl: boolean;
}

export default function PricingSection({ t, isRtl }: Props) {
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!publicPricingEnabled) return;
    const ac = new AbortController();
    getPublicPricing({ locale: isRtl ? "he" : "en", signal: ac.signal })
      .then((c) => setPlans(c.plans))
      .catch((e: any) => {
        if (e?.name !== "AbortError") setFailed(true);
      });
    return () => ac.abort();
  }, [isRtl]);

  // One gentle entrance, matching the rest of the landing page.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && (setShown(true), io.disconnect()),
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The section simply does not exist when pricing is unpublished or broken.
  // A marketing page with an empty pricing block is worse than none.
  if (!publicPricingEnabled || failed) return null;
  if (plans && plans.length === 0) return null;

  return (
    <section
      ref={ref}
      id="pricing"
      className="scroll-mt-24 bg-white px-4 py-20 sm:px-12 sm:py-36 lg:px-20"
      aria-labelledby="landing-pricing-heading"
    >
      <div className="mx-auto max-w-[1240px]">
        <div
          className={`transition-[opacity,transform] duration-[700ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
            shown ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
          } motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none`}
        >
          {/* Header: statement on the left, the one commercial idea on the right. */}
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
            <div className="max-w-2xl">
              <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.2em] text-primary-500">
                {t("landing.pricing.label")}
              </p>
              <h2
                id="landing-pricing-heading"
                className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-semibold leading-[1.15] tracking-[-0.03em] text-gray-900"
              >
                {t("landing.pricing.title")}
              </h2>
              <p className="mt-4 text-[15px] leading-[1.7] text-[#6b6b6b]">
                {t("landing.pricing.subtitle")}
              </p>
            </div>
            <Link
              href="/pricing"
              className="hidden shrink-0 items-center gap-2 text-[14px] font-medium text-gray-900 underline-offset-4 transition-colors hover:text-primary-600 hover:underline lg:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 rounded"
            >
              {t("landing.pricing.viewAll")}
              <svg className="h-4 w-4 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>
          </div>

          {/* Plans: one surface, hairline dividers. Same construction as
              /pricing so the two read as one product, at lower density. */}
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl bg-gray-200/70 md:grid-cols-3">
            {plans
              ? plans.map((plan, i) => (
                  <PreviewColumn key={plan.key} plan={plan} previous={i > 0 ? plans[i - 1] : null} isRtl={isRtl} t={t} />
                ))
              : [0, 1, 2].map((i) => <PreviewSkeleton key={i} />)}
          </div>

          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-2xl text-[12.5px] leading-[1.6] text-[#b0b0b0]">
              {t("landing.pricing.note")}
            </p>
            <Link
              href="/pricing"
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-gray-200 px-5 py-2.5 text-[13.5px] font-medium text-gray-900 transition-colors hover:border-gray-900 lg:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
            >
              {t("landing.pricing.viewAll")}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A single preview column: price, credits, estimated capacity, and ONE
 * differentiator. Anything more belongs on /pricing.
 */
function PreviewColumn({
  plan, previous, isRtl, t,
}: {
  plan: PublicPlan;
  previous: PublicPlan | null;
  isRtl: boolean;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const name = isRtl ? plan.nameHe ?? plan.name : plan.name;
  const q = quoteSelection(plan, defaultSelection(plan));

  // The single most meaningful capability this plan adds over the one below.
  const prevKeys = new Set((previous?.features ?? []).filter((f) => f.included).map((f) => f.key));
  const added = plan.features.filter((f) => f.included && !prevKeys.has(f.key));
  const differentiator = added[added.length - 1] ?? plan.features.find((f) => f.included);

  return (
    <div className="relative flex flex-col bg-white p-7">
      <div className="flex min-h-[1.75rem] flex-wrap items-center gap-x-2 gap-y-1.5">
        <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-gray-900">{name}</h3>
        {plan.recommended && (
          <span className="whitespace-nowrap rounded-full bg-gray-900 px-2.5 py-0.5 text-[11px] font-medium text-white">
            {t("pricing.recommended")}
          </span>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-baseline gap-x-1.5" dir="ltr">
        <span className="text-[2rem] font-semibold leading-none tracking-[-0.03em] tabular-nums text-gray-900">
          {plan.salesOnly || !plan.price ? t("pricing.custom") : plan.price.formatted}
        </span>
        {plan.price && !plan.salesOnly && (
          <span className="whitespace-nowrap text-[13px] text-gray-400">/ {t("pricing.month")}</span>
        )}
      </div>

      <dl className="mt-5 space-y-1.5 border-t border-gray-100 pt-4 text-[13px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-gray-500">{t("pricing.includedCredits")}</dt>
          <dd className="font-medium tabular-nums text-gray-900" dir="ltr">
            {plan.includedCredits.toLocaleString()}
          </dd>
        </div>
        {q.estimatedChatsMonthly > 0 && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500">{t("pricing.estimatedChats")}</dt>
            <dd className="font-medium tabular-nums text-gray-900" dir="ltr">
              ~{q.estimatedChatsMonthly.toLocaleString()}
            </dd>
          </div>
        )}
      </dl>

      {differentiator && (
        <p className="mt-4 border-t border-gray-100 pt-4 text-[13px] leading-[1.55] text-gray-600">
          {previous && added.length > 0
            ? t("landing.pricing.adds").replace("{feature}", differentiator.name)
            : differentiator.name}
        </p>
      )}
    </div>
  );
}

/** No numerals while loading: a flash of "$0" would be a lie about the price. */
function PreviewSkeleton() {
  return (
    <div className="bg-white p-7">
      <div className="h-4 w-24 animate-pulse rounded bg-gray-100" />
      <div className="mt-6 h-8 w-28 animate-pulse rounded bg-gray-100" />
      <div className="mt-6 space-y-2 border-t border-gray-100 pt-4">
        <div className="h-3 w-full animate-pulse rounded bg-gray-50" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-gray-50" />
      </div>
      <div className="mt-4 h-3 w-4/5 animate-pulse rounded bg-gray-50" />
    </div>
  );
}
