"use client";

// Credits explainer, custom plan and FAQ.
//
// These carry most of the page's credibility, so the copy states only what the
// product actually does. No SLA, no uptime promise, no certification, no
// guarantee - every claim here maps to implemented behaviour in the billing
// service, because a pricing page is the worst place to over-promise.

import Link from "next/link";
import { useState } from "react";
import { Eyebrow, SectionHeading, Reveal } from "./PricingPrimitives";

/**
 * What a credit is.
 *
 * Presented as a short narrative with four facts, not four bordered cards.
 * Deliberately never mentions tokens or models: credits are the only unit a
 * customer ever sees.
 */
export function CreditsExplainer({ t }: { t: (k: string) => string }) {
  const points: Array<{ title: string; body: string }> = [
    { title: t("pricing.credits.p1.title"), body: t("pricing.credits.p1.body") },
    { title: t("pricing.credits.p2.title"), body: t("pricing.credits.p2.body") },
    { title: t("pricing.credits.p3.title"), body: t("pricing.credits.p3.body") },
    { title: t("pricing.credits.p4.title"), body: t("pricing.credits.p4.body") },
  ];

  return (
    <section className="bg-white px-4 py-20 sm:px-12 sm:py-28 lg:px-20" aria-labelledby="credits-heading">
      <div className="mx-auto max-w-[1240px]">
        <Reveal>
          <div className="max-w-2xl">
            <Eyebrow>{t("pricing.credits.label")}</Eyebrow>
            <SectionHeading className="mt-4" as="h2">
              <span id="credits-heading">{t("pricing.credits.title")}</span>
            </SectionHeading>
            <p className="mt-4 text-[15px] leading-[1.7] text-gray-500">{t("pricing.credits.intro")}</p>
          </div>
        </Reveal>

        <div className="mt-12 grid gap-x-12 gap-y-9 border-t border-gray-200 pt-10 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((p, i) => (
            <Reveal key={p.title} delay={i * 60}>
              <div>
                <h3 className="text-[14px] font-semibold text-gray-900">{p.title}</h3>
                <p className="mt-2 text-[13.5px] leading-[1.65] text-gray-500">{p.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Custom plan.
 *
 * A real sales path, not a footnote. Claims are limited to what the platform can
 * genuinely configure per organization: feature selection, numeric limits,
 * credit allocation, chat and voice volumes, contract terms.
 */
export function CustomPlanSection({
  t, ctaHref,
}: {
  t: (k: string) => string;
  ctaHref: string;
}) {
  const items = [
    t("pricing.custom.i1"),
    t("pricing.custom.i2"),
    t("pricing.custom.i3"),
    t("pricing.custom.i4"),
  ];
  return (
    <section className="bg-[#fafafa] px-4 py-20 sm:px-12 sm:py-28 lg:px-20" aria-labelledby="custom-heading">
      <div className="mx-auto max-w-[1240px]">
        <Reveal>
          <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-16">
            <div>
              <Eyebrow>{t("pricing.custom.label")}</Eyebrow>
              <SectionHeading className="mt-4" as="h2">
                <span id="custom-heading">{t("pricing.custom.title")}</span>
              </SectionHeading>
              <p className="mt-4 max-w-xl text-[15px] leading-[1.7] text-gray-500">
                {t("pricing.custom.body")}
              </p>
              <Link
                href={ctaHref}
                className="mt-7 inline-flex items-center gap-2 rounded-xl bg-gray-900 px-6 py-3 text-[14px] font-semibold text-white transition-colors duration-200 hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
              >
                {t("pricing.custom.cta")}
                <svg className="h-4 w-4 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </Link>
            </div>

            <ul className="divide-y divide-gray-200 border-y border-gray-200">
              {items.map((item) => (
                <li key={item} className="flex items-start gap-3 py-3.5 text-[14px] leading-[1.6] text-gray-700">
                  <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-gray-900" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/**
 * FAQ.
 *
 * Every answer describes behaviour that exists: period-end cancellation,
 * included credits resetting at renewal, purchased credits persisting,
 * auto-purchase with a monthly ceiling, ILS as a display conversion, and
 * POC/Trial being sales-provisioned rather than self-serve.
 */
export function PricingFaq({ t }: { t: (k: string) => string }) {
  const items = (t("pricing.faq.items") as unknown as Array<{ q: string; a: string }>) ?? [];
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <section className="bg-white px-4 py-20 sm:px-12 sm:py-28 lg:px-20" aria-labelledby="faq-heading">
      <div className="mx-auto max-w-[760px]">
        <Reveal>
          <div className="text-center">
            <Eyebrow>{t("pricing.faq.label")}</Eyebrow>
            <SectionHeading className="mt-4" as="h2">
              <span id="faq-heading">{t("pricing.faq.title")}</span>
            </SectionHeading>
          </div>
        </Reveal>
        <dl className="mt-12 border-t border-gray-200">
          {items.map((item, i) => (
            <FaqRow key={i} question={item.q} answer={item.a} />
          ))}
        </dl>
      </div>
    </section>
  );
}

function FaqRow({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-200">
      <dt>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-start justify-between gap-6 py-5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
        >
          <span className="text-[15px] font-medium leading-[1.5] text-gray-900">{question}</span>
          <span className="relative mt-1.5 h-3 w-3 shrink-0" aria-hidden="true">
            <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gray-500" />
            <span
              className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gray-500 transition-transform duration-200 ${
                open ? "scale-y-0" : "scale-y-100"
              }`}
            />
          </span>
        </button>
      </dt>
      <dd
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <p className="pb-5 pe-9 text-[14px] leading-[1.7] text-gray-500">{answer}</p>
        </div>
      </dd>
    </div>
  );
}

/**
 * States the public page can be in besides "showing prices".
 *
 * Each says only what the visitor needs. None reveals configuration, a stack
 * trace, or whether a catalog exists at all.
 */
export function PricingNotice({
  kind, t, onRetry,
}: {
  kind: "disabled" | "empty" | "error";
  t: (k: string) => string;
  onRetry?: () => void;
}) {
  return (
    <div className="mx-auto max-w-[560px] px-4 py-24 text-center">
      <h2 className="text-[19px] font-semibold text-gray-900">{t(`pricing.state.${kind}.title`)}</h2>
      <p className="mt-2.5 text-[14px] leading-[1.65] text-gray-500">{t(`pricing.state.${kind}.body`)}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {kind === "error" && onRetry && (
          <button
            onClick={onRetry}
            className="rounded-xl border border-gray-200 px-5 py-2.5 text-[14px] font-medium text-gray-900 transition-colors hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            {t("pricing.state.retry")}
          </button>
        )}
        <Link
          href="/early-access"
          className="rounded-xl bg-gray-900 px-5 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
        >
          {t("pricing.state.earlyAccess")}
        </Link>
      </div>
    </div>
  );
}
