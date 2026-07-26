"use client";

// Plan configurator + commercial summary.
//
// The brief: it must feel like a product configurator, not a settings form, and
// the visitor must always understand WHY the price changed. So every selector
// states what it adds (credits and money), and the summary breaks the total
// into included versus added rather than showing one opaque figure.
//
// Desktop: the summary sticks alongside the selectors.
// Narrow: it becomes a compact fixed bar so the total is never scrolled away.

import Link from "next/link";
import { useMemo } from "react";
import { planCopy } from "./usePublicPricing";
import { Price, Rule, PriceAnnouncer } from "./PricingPrimitives";
import {
  quoteSelection,
  formatMinor,
  type PublicPlan,
  type PublicVolumeOption,
  type Selection,
} from "@/lib/api-public-pricing";

interface Props {
  plan: PublicPlan;
  selection: Selection;
  onChange: (channel: "chat" | "voice", key: string) => void;
  currencyMeta: {
    display: string;
    base: string;
    isEstimatedConversion: boolean;
    chargedCurrency: string;
    fx: { rate: string; rateDate: string; isFallback: boolean } | null;
  };
  disclaimer: string;
  ctaHref: string;
  ctaLabel: string;
  isHe: boolean;
  t: (k: string) => string;
}

export function VolumeConfigurator({
  plan, selection, onChange, currencyMeta, disclaimer, ctaHref, ctaLabel, isHe, t,
}: Props) {
  const q = useMemo(() => quoteSelection(plan, selection), [plan, selection]);
  const { name } = planCopy(plan, isHe);
  const hasSelectors = plan.chatVolumeEnabled || plan.voiceVolumeEnabled;

  const total = formatMinor(q.monthlyMinor, q.currency);

  // One sentence for assistive tech whenever the configuration changes.
  const announcement = t("pricing.a11y.totalChanged")
    .replace("{plan}", name)
    .replace("{total}", total)
    .replace("{credits}", q.includedCredits.toLocaleString());

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_20rem] lg:gap-12">
      {/* ── Selectors ── */}
      <div>
        <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-gray-900">
          {t("pricing.configureTitle").replace("{plan}", name)}
        </h3>
        <p className="mt-1.5 max-w-xl text-[14px] leading-[1.6] text-gray-500">
          {hasSelectors ? t("pricing.configureSubtitle") : t("pricing.fixedAllowance")}
        </p>

        {hasSelectors ? (
          <div className="mt-7 space-y-8">
            {plan.chatVolumeEnabled && (
              <VolumeRow
                legend={t("pricing.chatVolume")}
                hint={t("pricing.perBusinessDay")}
                options={plan.chatOptions}
                value={selection.chat}
                onChange={(k) => onChange("chat", k)}
                currency={currencyMeta.display}
                t={t}
              />
            )}
            {plan.voiceVolumeEnabled && (
              <VolumeRow
                legend={t("pricing.voiceVolume")}
                hint={t("pricing.perBusinessDay")}
                options={plan.voiceOptions}
                value={selection.voice}
                onChange={(k) => onChange("voice", k)}
                currency={currencyMeta.display}
                t={t}
              />
            )}
          </div>
        ) : (
          <div className="mt-7 grid gap-4 sm:grid-cols-2">
            <Fact label={t("pricing.includedCredits")} value={plan.includedCredits.toLocaleString()} />
            <Fact
              label={t("pricing.estimatedChats")}
              value={`~${q.estimatedChatsMonthly.toLocaleString()} ${t("pricing.perMonth")}`}
            />
            {plan.creditPackagesEligible && (
              <Fact label={t("pricing.extraCredits")} value={t("pricing.extraCreditsAvailable")} />
            )}
            {plan.autoPurchaseEligible && (
              <Fact label={t("pricing.autoTopUp")} value={t("pricing.autoTopUpAvailable")} />
            )}
          </div>
        )}
      </div>

      {/* ── Summary ── */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <PriceAnnouncer message={announcement} />

        {/* Desktop / tablet */}
        <div className="hidden rounded-2xl border border-gray-200 bg-white p-6 sm:block">
          <SummaryBody q={q} plan={plan} currencyMeta={currencyMeta} name={name} t={t} />
          <Link
            href={ctaHref}
            className="mt-6 flex w-full items-center justify-center rounded-xl bg-gray-900 px-4 py-3 text-[14px] font-semibold text-white transition-colors duration-200 hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
          >
            {ctaLabel}
          </Link>
          <p className="mt-3 text-[11px] leading-[1.5] text-gray-400">{disclaimer}</p>
        </div>

        {/* Narrow: fixed bar so the total is always visible while configuring. */}
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur-md sm:hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[11px] uppercase tracking-[0.12em] text-gray-400">{name}</p>
              <div className="flex items-baseline gap-1.5" dir="ltr">
                <span className="text-[19px] font-semibold tabular-nums text-gray-900">{total}</span>
                <span className="text-[11px] text-gray-400">/ {t("pricing.month")}</span>
              </div>
              <p className="truncate text-[11px] tabular-nums text-gray-500" dir="ltr">
                {q.includedCredits.toLocaleString()} {t("pricing.creditsWord")}
                {q.estimatedChatsMonthly > 0 ? ` · ~${q.estimatedChatsMonthly.toLocaleString()} ${t("pricing.chatsWord")}` : ""}
              </p>
            </div>
            <Link
              href={ctaHref}
              className="shrink-0 rounded-xl bg-gray-900 px-4 py-2.5 text-[13px] font-semibold text-white"
            >
              {ctaLabel}
            </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** The summary body, shared so the two breakpoints cannot drift apart. */
function SummaryBody({
  q, plan, currencyMeta, name, t,
}: {
  q: ReturnType<typeof quoteSelection>;
  plan: PublicPlan;
  currencyMeta: Props["currencyMeta"];
  name: string;
  t: (k: string) => string;
}) {
  return (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-gray-400">
        {t("pricing.yourPlan")}
      </p>
      <p className="mt-1 text-[15px] font-semibold text-gray-900">{name}</p>

      <div className="mt-4">
        <Price formatted={formatMinor(q.monthlyMinor, q.currency)} interval={t("pricing.month")} size="lg" />
      </div>

      <Rule className="my-5" />

      {/* Credits, broken into included versus added: the visitor has to be able
          to see WHY the number moved, not just that it did. */}
      <dl className="space-y-2 text-[13px]">
        <Line label={t("pricing.planCredits")} value={q.baseCredits.toLocaleString()} />
        {q.addedCredits > 0 && (
          <Line label={t("pricing.addedCredits")} value={`+${q.addedCredits.toLocaleString()}`} accent />
        )}
        <Line
          label={t("pricing.totalCredits")}
          value={q.includedCredits.toLocaleString()}
          strong
        />
      </dl>

      <Rule className="my-5" />

      <dl className="space-y-2 text-[13px]">
        {q.estimatedChatsMonthly > 0 && (
          <Line
            label={t("pricing.estimatedChats")}
            value={`~${q.estimatedChatsMonthly.toLocaleString()}`}
            sub={`~${q.estimatedChatsDaily} ${t("pricing.perDayShort")}`}
          />
        )}
        {q.estimatedCallsMonthly > 0 && (
          <Line
            label={t("pricing.estimatedCalls")}
            value={`~${q.estimatedCallsMonthly.toLocaleString()}`}
            sub={`~${q.estimatedCallsDaily} ${t("pricing.perDayShort")}`}
          />
        )}
        {q.pricePerChatMinor != null && (
          <Line label={t("pricing.perConversation")} value={formatMinor(q.pricePerChatMinor, q.currency, 2)} />
        )}
        {q.pricePerCallMinor != null && (
          <Line label={t("pricing.perCall")} value={formatMinor(q.pricePerCallMinor, q.currency, 2)} />
        )}
        {q.pricePerChatMinor != null && q.pricePerCallMinor != null && q.pricePerInteractionMinor != null && (
          <Line
            label={t("pricing.blended")}
            value={formatMinor(q.pricePerInteractionMinor, q.currency, 2)}
          />
        )}
      </dl>

      {/* Which currency is actually charged, stated before the CTA. */}
      {currencyMeta.isEstimatedConversion && currencyMeta.display !== currencyMeta.base && (
        <p className="mt-4 rounded-xl bg-gray-50 px-3 py-2.5 text-[11px] leading-[1.5] text-gray-500">
          {t("pricing.fxNote")
            .replace("{display}", currencyMeta.display)
            .replace("{charged}", currencyMeta.chargedCurrency)}
          {currencyMeta.fx && (
            <>
              {" "}
              <span dir="ltr" className="tabular-nums">
                1 {currencyMeta.base} = {currencyMeta.fx.rate} {currencyMeta.display}
              </span>
              {", "}
              <span dir="ltr">{currencyMeta.fx.rateDate}</span>
            </>
          )}
        </p>
      )}
    </>
  );
}

function Line({
  label, value, sub, strong, accent,
}: { label: string; value: string; sub?: string; strong?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? "font-medium text-gray-700" : "text-gray-500"}>{label}</dt>
      <dd className="text-end">
        <span
          className={`tabular-nums ${
            strong ? "font-semibold text-gray-900" : accent ? "font-medium text-primary-600" : "font-medium text-gray-900"
          }`}
          dir="ltr"
        >
          {value}
        </span>
        {sub && <span className="block text-[11px] tabular-nums text-gray-400" dir="ltr">{sub}</span>}
      </dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <p className="text-[11px] uppercase tracking-[0.12em] text-gray-400">{label}</p>
      <p className="mt-1 text-[15px] font-medium tabular-nums text-gray-900" dir="ltr">{value}</p>
    </div>
  );
}

/**
 * One channel's volume options.
 *
 * A real radiogroup: arrow keys move between options, the selected one is
 * exposed, and each option states the volume AND what it adds, so the price
 * change is never a surprise.
 */
function VolumeRow({
  legend, hint, options, value, onChange, currency, t,
}: {
  legend: string;
  hint: string;
  options: PublicVolumeOption[];
  value: string | null;
  onChange: (key: string) => void;
  currency: string;
  t: (k: string) => string;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset>
      <legend className="mb-3 flex flex-wrap items-baseline gap-2">
        <span className="text-[14px] font-medium text-gray-900">{legend}</span>
        <span className="text-[12px] text-gray-400">{hint}</span>
      </legend>
      <div role="radiogroup" aria-label={legend} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {options.map((o) => {
          const selected = value === o.key;
          const free = o.additionalPrice.amount === "0.00";
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.key)}
              className={`rounded-xl border px-3 py-3 text-start transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 ${
                selected
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-200 bg-white text-gray-900 hover:border-gray-400"
              }`}
            >
              <span className="block text-[17px] font-semibold tabular-nums" dir="ltr">
                {o.dailyVolume}
              </span>
              <span
                className={`mt-0.5 block text-[11px] tabular-nums ${selected ? "text-white/70" : "text-gray-400"}`}
                dir="ltr"
              >
                {free ? t("pricing.included") : `+${o.additionalPrice.formatted}`}
              </span>
              {!free && (
                <span
                  className={`mt-0.5 block text-[10px] tabular-nums ${selected ? "text-white/50" : "text-gray-400"}`}
                  dir="ltr"
                >
                  +{o.additionalCredits.toLocaleString()} {t("pricing.creditsWord")}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
