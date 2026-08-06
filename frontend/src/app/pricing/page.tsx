"use client";

// Public pricing page.
//
// Every price, credit figure and conversation estimate comes from
// /api/public/pricing, which is computed by the canonical pricing service. This
// page contains no plan names, no prices and no volume rules - a test asserts
// that, because the moment marketing numbers get hardcoded here they start
// drifting from what the product actually charges.
//
// The page is reachable only when PUBLIC_PRICING_ENABLED is on. nginx enforces
// that; this component's flag check is a fast local mirror so a disabled build
// renders the notice instead of flashing a request that 404s.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { publicPricingEnabled } from "@/lib/api-public-pricing";
import LoginLink from "@/components/LoginLink";
import { usePublicPricing, planCopy } from "@/components/pricing/usePublicPricing";
import {
  Eyebrow, SectionHeading, CurrencyToggle, PlanSkeleton, Reveal,
} from "@/components/pricing/PricingPrimitives";
import { PlanGrid } from "@/components/pricing/PlanGrid";
import { VolumeConfigurator } from "@/components/pricing/VolumeConfigurator";
import { ComparisonTable } from "@/components/pricing/ComparisonTable";
import { CreditsExplainer, CustomPlanSection, PricingFaq, PricingNotice } from "@/components/pricing/PricingSections";

export default function PricingPage() {
  const { t, locale } = useI18n();
  const { user, isLoading: authLoading } = useAuth();
  const isHe = locale === "he";
  const p = usePublicPricing(locale);

  // Signed-in visitors manage their plan in the app; everyone else joins early
  // access. Resolved after auth settles so the CTA never flips under a click.
  const signedIn = !authLoading && !!user;
  const ctaHref = signedIn ? "/settings/billing/plan" : "/early-access";
  const ctaLabel = signedIn ? t("pricing.cta.managePlan") : t("pricing.cta.getStarted");

  // The flag is off in this build: render the notice, never a broken catalog.
  if (!publicPricingEnabled) {
    return (
      <Shell t={t}>
        <PricingNotice kind="disabled" t={t} />
      </Shell>
    );
  }

  if (p.state === "disabled" || p.state === "empty" || p.state === "error") {
    return (
      <Shell t={t}>
        <PricingNotice kind={p.state} t={t} onRetry={p.retry} />
      </Shell>
    );
  }

  const disclaimer = isHe ? p.catalog?.disclaimer.he ?? "" : p.catalog?.disclaimer.en ?? "";

  return (
    <Shell t={t}>
      {/* ── Introduction ── */}
      <section className="border-b border-gray-200 bg-white px-4 pb-14 pt-28 sm:px-12 sm:pb-20 sm:pt-36 lg:px-20">
        <div className="mx-auto max-w-[1240px]">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <Eyebrow>{t("pricing.hero.label")}</Eyebrow>
              <SectionHeading as="h1" className="mt-4">
                {t("pricing.hero.title")}
              </SectionHeading>
              <p className="mt-5 text-[16px] leading-[1.7] text-gray-500">{t("pricing.hero.subtitle")}</p>
            </div>
            {p.catalog && (
              <CurrencyToggle
                value={p.currency}
                options={p.catalog.currency.available}
                onChange={p.setCurrency}
                label={t("pricing.currencyLabel")}
              />
            )}
          </div>

          {/* One short paragraph on the unit, before any number is shown. */}
          <p className="mt-8 max-w-2xl border-s-2 border-gray-200 ps-4 text-[14px] leading-[1.7] text-gray-500">
            {t("pricing.hero.creditsNote")}
          </p>
        </div>
      </section>

      {/* ── Plans ── */}
      <section className="bg-[#fafafa] px-4 py-14 sm:px-12 sm:py-20 lg:px-20" aria-labelledby="plans-heading">
        <div className="mx-auto max-w-[1240px]">
          <h2 id="plans-heading" className="sr-only">
            {t("pricing.plansHeading")}
          </h2>
          {p.state === "loading" && !p.catalog ? (
            <PlanSkeleton />
          ) : (
            <PlanGrid
              plans={p.plans}
              selections={p.selections}
              activeKey={p.activeKey}
              onSelect={p.setActiveKey}
              onVolumeChange={p.setVolume}
              isHe={isHe}
              t={t}
              ctaHref={ctaHref}
              ctaLabel={ctaLabel}
            />
          )}
          <p className="mt-5 text-[12px] leading-[1.6] text-gray-400">{disclaimer}</p>
        </div>
      </section>

      {/* ── Configurator ── */}
      {p.activePlan && p.catalog && (
        <section className="border-y border-gray-200 bg-white px-4 py-16 sm:px-12 sm:py-24 lg:px-20" aria-labelledby="configure-heading">
          <div className="mx-auto max-w-[1240px]">
            <h2 id="configure-heading" className="sr-only">
              {t("pricing.configureHeading")}
            </h2>
            <VolumeConfigurator
              plan={p.activePlan}
              selection={p.selections[p.activePlan.key] ?? { chat: null, voice: null }}
              onChange={(channel, key) => p.setVolume(p.activePlan!.key, channel, key)}
              currencyMeta={p.catalog.currency}
              disclaimer={disclaimer}
              ctaHref={ctaHref}
              ctaLabel={ctaLabel}
              isHe={isHe}
              t={t}
            />
          </div>
        </section>
      )}

      {/* ── Full comparison ── */}
      <section className="bg-[#fafafa] px-4 py-20 sm:px-12 sm:py-28 lg:px-20" aria-labelledby="compare-heading">
        <div className="mx-auto max-w-[1240px]">
          <Reveal>
            <div className="mb-10 max-w-2xl">
              <Eyebrow>{t("pricing.comparison.label")}</Eyebrow>
              <SectionHeading className="mt-4" as="h2">
                <span id="compare-heading">{t("pricing.comparison.title")}</span>
              </SectionHeading>
              <p className="mt-4 text-[15px] leading-[1.7] text-gray-500">{t("pricing.comparison.subtitle")}</p>
            </div>
          </Reveal>
          <ComparisonTable plans={p.plans} isHe={isHe} t={t} />
        </div>
      </section>

      <CreditsExplainer t={t} />
      <CustomPlanSection t={t} ctaHref="/early-access?plan=custom" />
      <PricingFaq t={t} />

      {/* ── Closing CTA ── */}
      <section className="border-t border-gray-200 bg-[#fafafa] px-4 py-20 sm:px-12 sm:py-24 lg:px-20">
        <div className="mx-auto max-w-[720px] text-center">
          <SectionHeading as="h2">{t("pricing.closing.title")}</SectionHeading>
          <p className="mt-4 text-[15px] leading-[1.7] text-gray-500">{t("pricing.closing.body")}</p>
          <Link
            href={ctaHref}
            className="mt-7 inline-flex rounded-xl bg-gray-900 px-7 py-3.5 text-[14px] font-semibold text-white transition-colors duration-200 hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
          >
            {ctaLabel}
          </Link>
        </div>
      </section>

      {/* Clears the mobile fixed summary bar. */}
      <div className="h-20 sm:hidden" aria-hidden="true" />
    </Shell>
  );
}

/**
 * Minimal public chrome: a link back to the marketing site and the language
 * switch. Deliberately not the app shell - this page is for people who are not
 * signed in.
 */
function Shell({ t, children }: { t: (k: string) => string; children: React.ReactNode }) {
  const { locale, setLocale } = useI18n();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-white">
      <a
        href="#plans-heading"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-gray-900 focus:px-4 focus:py-2 focus:text-[13px] focus:text-white"
      >
        {t("pricing.a11y.skipToPlans")}
      </a>

      <header
        className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
          scrolled ? "border-b border-gray-200 bg-white/90 backdrop-blur-xl" : "bg-transparent"
        }`}
      >
        <div className="mx-auto flex max-w-[1240px] items-center justify-between px-4 py-3.5 sm:px-12 lg:px-20">
          <Link href="/" className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 rounded">
            {/* dir="ltr": in RTL the trailing period is reordered to the
                front and the brand reads ".GOTCHA". */}
            <span dir="ltr" className="text-[17px] font-bold tracking-[-0.02em] text-gray-900">GOTCHA.</span>
          </Link>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setLocale(locale === "he" ? "en" : "he")}
              className="text-[13px] font-medium text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 rounded px-1"
            >
              {locale === "he" ? "English" : "עברית"}
            </button>
            <LoginLink className="text-[13px] font-medium text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 rounded px-1">
              {t("landing.nav.login")}
            </LoginLink>
            <Link
              href="/early-access"
              className="rounded-full bg-primary-500 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
            >
              {t("landing.nav.getStarted")}
            </Link>
          </div>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
