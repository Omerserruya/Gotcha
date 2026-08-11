"use client";

// Landing-page pricing preview.
//
// An editorial section, not a compressed copy of /pricing. It answers three
// questions and then gets out of the way: what does it cost, what do I get for
// it, and where do I read the detail.
//
// It shares the public catalog with /pricing, so a published price change moves
// both surfaces at once and they cannot drift.
//
// Columns on one surface, split by full-strength dividers, matching /pricing.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check } from "@/components/pricing/PricingPrimitives";
import { MilestoneBar } from "@/components/pricing/MilestoneBar";
import {
  getPublicPricing,
  quoteSelection,
  defaultSelection,
  formatMinor,
  publicPricingEnabled,
  type PublicPlan,
  type Selection,
  type PublicTaxSummary,
} from "@/lib/api-public-pricing";

interface Props {
  t: (key: string, vars?: Record<string, string>) => string;
  isRtl: boolean;
}

export default function PricingSection({ t, isRtl }: Props) {
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  // Listed prices are net. The landing page knows nothing about the visitor, so
  // it names the rate instead of folding it into a total.
  const [tax, setTax] = useState<PublicTaxSummary | null>(null);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!publicPricingEnabled) return;
    const ac = new AbortController();
    getPublicPricing({ locale: isRtl ? "he" : "en", signal: ac.signal })
      .then((c) => {
        setPlans(c.plans);
        setTax(c.tax ?? null);
        // Seeded after the catalog arrives, and only for plans not already
        // configured, so switching language cannot discard a chosen volume.
        setSelections((prev) => {
          const next = { ...prev };
          for (const p of c.plans) if (!next[p.key]) next[p.key] = defaultSelection(p);
          return next;
        });
      })
      .catch((e: any) => {
        if (e?.name !== "AbortError") setFailed(true);
      });
    return () => ac.abort();
  }, [isRtl]);

  const taxNote =
    tax && !tax.exempt
      ? isRtl
        ? `המחירים אינם כוללים ${tax.label ?? 'מע"מ'} ${tax.percent}%`
        : `Prices exclude ${tax.label ?? "VAT"} ${tax.percent}%`
      : null;

  const setVolume = (planKey: string, channel: "chat" | "voice", optionKey: string) =>
    setSelections((s) => ({
      ...s,
      [planKey]: { ...(s[planKey] ?? { chat: null, voice: null }), [channel]: optionKey },
    }));

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
              className="hidden shrink-0 items-center gap-2 rounded text-[14px] font-medium text-gray-900 underline-offset-4 transition-colors hover:text-primary-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 lg:inline-flex"
            >
              {t("landing.pricing.viewAll")}
              <svg className="h-4 w-4 rtl:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>
          </div>

          {/* Plans: columns on one surface, same construction as /pricing so
              the two surfaces read as one product, at lower density. */}
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl bg-gray-300 ring-1 ring-gray-300 md:grid-cols-3">
            {plans
              ? plans.map((plan, i) => (
                  <PreviewColumn
                    key={plan.key}
                    plan={plan}
                    previous={i > 0 ? plans[i - 1] : null}
                    selection={selections[plan.key] ?? { chat: null, voice: null }}
                    onVolumeChange={setVolume}
                    isRtl={isRtl}
                    t={t}
                    taxNote={taxNote}
                  />
                ))
              : [0, 1, 2].map((i) => <PreviewSkeleton key={i} />)}
          </div>

          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-2xl text-[12.5px] leading-[1.6] text-[#b0b0b0]">
              {t("landing.pricing.note")}
            </p>
            <Link
              href="/pricing"
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-gray-200 px-5 py-2.5 text-[13.5px] font-medium text-gray-900 transition-colors hover:border-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 lg:hidden"
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
 * A single preview column: a live price, what it includes, what a conversation
 * costs, a worked example, and a CTA. The full comparison, the credits
 * breakdown and the limits belong on /pricing.
 */
function PreviewColumn({
  plan, previous, selection, onVolumeChange, isRtl, t, taxNote,
}: {
  plan: PublicPlan;
  previous: PublicPlan | null;
  selection: Selection;
  onVolumeChange: (planKey: string, channel: "chat" | "voice", optionKey: string) => void;
  isRtl: boolean;
  t: (key: string, vars?: Record<string, string>) => string;
  /** e.g. "Prices exclude VAT 18%". Null when nothing is owed. */
  taxNote?: string | null;
}) {
  const name = isRtl ? plan.nameHe ?? plan.name : plan.name;
  const q = quoteSelection(plan, selection);
  const priced = !plan.salesOnly && !!plan.price;

  // The plan's own one-sentence positioning, written for exactly this purpose
  // and owned by the plan configuration. Deriving a "headline feature" from
  // catalog order instead produced "Configurable data retention" for the base
  // plan, which is a poor thing to lead with.
  const summary = isRtl ? plan.descriptionHe ?? plan.description : plan.description;

  // Same delta logic as /pricing: the entry plan shows what it includes, the
  // ones above it show what they add. Capped here, because this is a preview.
  const included = plan.features.filter((f) => f.included);
  const prevKeys = new Set((previous?.features ?? []).filter((f) => f.included).map((f) => f.key));
  const added = included.filter((f) => !prevKeys.has(f.key));
  const isDelta = previous != null && added.length > 0;
  const headline = (isDelta ? added : included).slice(0, 4);
  const previousName = previous ? (isRtl ? previous.nameHe ?? previous.name : previous.name) : "";

  // A worked example, so "12,000 credits" turns into something a business owner
  // can picture. Skipped when the rounded daily figure would read as zero.
  const chatsDaily = Math.round(q.estimatedChatsDaily);
  const callsDaily = Math.round(q.estimatedCallsDaily);
  const example =
    callsDaily >= 1 && chatsDaily >= 1
      ? t("landing.pricing.exampleBoth")
          .replace("{chatsDaily}", chatsDaily.toLocaleString())
          .replace("{callsDaily}", callsDaily.toLocaleString())
          .replace("{chatsMonthly}", q.estimatedChatsMonthly.toLocaleString())
          .replace("{callsMonthly}", q.estimatedCallsMonthly.toLocaleString())
      : chatsDaily >= 1
        ? t("landing.pricing.exampleChats")
            .replace("{daily}", chatsDaily.toLocaleString())
            .replace("{monthly}", q.estimatedChatsMonthly.toLocaleString())
        : null;

  const adjustable = plan.chatVolumeEnabled || plan.voiceVolumeEnabled;

  return (
    <div className="relative flex flex-col bg-white p-7 transition-colors duration-300 hover:bg-[#fcfcfd] motion-reduce:transition-none">
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
          {priced ? formatMinor(q.monthlyMinor, q.currency) : t("pricing.custom.label")}
        </span>
        {priced && <span className="whitespace-nowrap text-[13px] text-gray-400">/ {t("pricing.month")}</span>}
      </div>

      {/* Listed prices are net. Saying so is the difference between a price and
          a surprise. */}
      {priced && taxNote && (
        <p className="mt-1.5 text-[11px] leading-snug text-gray-400">{taxNote}</p>
      )}

      {/* Adjust the volume here, next to the price it moves. */}
      {adjustable && (
        <div className="mt-5 space-y-4 border-t border-gray-100 pt-4">
          {plan.chatVolumeEnabled && (
            <MilestoneBar
              size="compact"
              legend={t("pricing.chatVolume")}
              hint={t("pricing.perBusinessDay")}
              options={plan.chatOptions}
              value={selection.chat}
              onChange={(k) => onVolumeChange(plan.key, "chat", k)}
              t={t as (k: string) => string}
            />
          )}
          {plan.voiceVolumeEnabled && (
            <MilestoneBar
              size="compact"
              legend={t("pricing.voiceVolume")}
              hint={t("pricing.perBusinessDay")}
              options={plan.voiceOptions}
              value={selection.voice}
              onChange={(k) => onVolumeChange(plan.key, "voice", k)}
              t={t as (k: string) => string}
            />
          )}
        </div>
      )}

      <dl className="mt-5 space-y-1.5 border-t border-gray-100 pt-4 text-[13px]">
        <Row label={t("pricing.includedCredits")} value={q.includedCredits.toLocaleString()} />
        {q.estimatedChatsMonthly > 0 && (
          <Row label={t("pricing.estimatedChats")} value={`~${q.estimatedChatsMonthly.toLocaleString()}`} />
        )}
        {q.estimatedCallsMonthly > 0 && (
          <Row label={t("pricing.estimatedCalls")} value={`~${q.estimatedCallsMonthly.toLocaleString()}`} />
        )}
        {priced && q.pricePerChatMinor != null && (
          <Row label={t("pricing.perConversation")} value={formatMinor(q.pricePerChatMinor, q.currency, 2)} muted />
        )}
        {priced && q.pricePerCallMinor != null && (
          <Row label={t("pricing.perCall")} value={formatMinor(q.pricePerCallMinor, q.currency, 2)} muted />
        )}
      </dl>

      {summary && (
        <p className="mt-4 border-t border-gray-100 pt-4 text-[13px] leading-[1.55] text-gray-600">{summary}</p>
      )}

      {/* What you get. Grows so every CTA lands on the same baseline. */}
      <div className="mt-4 grow">
        {isDelta && (
          <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">
            {t("pricing.everythingIn").replace("{plan}", previousName)}
          </p>
        )}
        <ul className="space-y-2">
          {headline.map((f) => (
            <li key={f.key} className="flex items-start gap-2.5 text-[13px] leading-snug text-gray-700">
              <Check className="mt-[2px] text-gray-900" />
              <span>{f.name}</span>
            </li>
          ))}
        </ul>
      </div>

      {example && (
        <p className="mt-5 rounded-xl bg-[#fafafa] px-3.5 py-3 text-[12px] leading-[1.6] text-gray-500">
          {example}
        </p>
      )}

      <Link
        href="/early-access"
        className={`mt-5 flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-[13.5px] font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 ${
          plan.recommended
            ? "bg-gray-900 text-white hover:bg-gray-800"
            : "border border-gray-200 text-gray-900 hover:border-gray-900"
        }`}
      >
        {t("pricing.cta.getStarted")}
      </Link>
    </div>
  );
}

function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`font-medium tabular-nums ${muted ? "text-gray-500" : "text-gray-900"}`} dir="ltr">
        {value}
      </dd>
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
      <div className="mt-4 space-y-2">
        <div className="h-3 w-4/5 animate-pulse rounded bg-gray-50" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-gray-50" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-gray-50" />
      </div>
      <div className="mt-5 h-10 w-full animate-pulse rounded-xl bg-gray-100" />
    </div>
  );
}
