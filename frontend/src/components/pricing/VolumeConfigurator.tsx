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
import { useEffect, useMemo, useRef, useState } from "react";
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

  // The narrow summary is FIXED, so without scoping it floats over the hero and
  // the plan cards - announcing a plan the visitor has not chosen yet and
  // covering the content they are reading. Show it only while the configurator
  // is actually on screen.
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const hasSelectors = plan.chatVolumeEnabled || plan.voiceVolumeEnabled;

  const total = formatMinor(q.monthlyMinor, q.currency);

  // One sentence for assistive tech whenever the configuration changes.
  const announcement = t("pricing.a11y.totalChanged")
    .replace("{plan}", name)
    .replace("{total}", total)
    .replace("{credits}", q.includedCredits.toLocaleString());

  return (
    <div ref={rootRef} className="grid gap-10 lg:grid-cols-[1fr_20rem] lg:gap-12">
      {/* ── Selectors ── */}
      <div>
        <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-gray-900">
          {t("pricing.configureTitle").replace("{plan}", name)}
        </h3>
        <p className="mt-1.5 max-w-xl text-[14px] leading-[1.6] text-gray-500">
          {hasSelectors ? t("pricing.configureSubtitle") : t("pricing.fixedAllowance")}
        </p>

        {hasSelectors ? (
          <div className="mt-7 space-y-11">
            {plan.chatVolumeEnabled && (
              <VolumeRow
                legend={t("pricing.chatVolume")}
                hint={t("pricing.perBusinessDay")}
                options={plan.chatOptions}
                value={selection.chat}
                onChange={(k) => onChange("chat", k)}
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
        <div
          aria-hidden={!inView}
          className={`fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur-md transition-[opacity,transform] duration-300 sm:hidden motion-reduce:transition-none ${
            inView ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0"
          }`}
        >
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
 * One channel's volume, as an adjustment bar with milestones.
 *
 * The volumes are a short ordered ladder, so a bar reads the way the decision
 * actually feels: more conversations to the right, more money. Each configured
 * option is a milestone on the track rather than a free-scrolling number, so the
 * visitor can only land on a volume the plan actually sells.
 *
 * The control is a native `<input type="range">` stepping between option
 * indexes, kept transparent over the drawn track. That is deliberate: arrow
 * keys, Home/End, page keys and touch dragging all come from the platform, and
 * `aria-valuetext` reads the volume and its cost instead of "3 out of 4".
 */
function VolumeRow({
  legend, hint, options, value, onChange, t,
}: {
  legend: string;
  hint: string;
  options: PublicVolumeOption[];
  value: string | null;
  onChange: (key: string) => void;
  t: (k: string) => string;
}) {
  const [focused, setFocused] = useState(false);
  if (options.length === 0) return null;

  const index = Math.max(0, options.findIndex((o) => o.key === value));
  const max = options.length - 1;
  const current = options[index];
  const pct = max > 0 ? (index / max) * 100 : 0;
  const free = current.additionalPrice.amount === "0.00";

  const cost = free
    ? t("pricing.included")
    : `+${current.additionalPrice.formatted} / ${t("pricing.month")}`;

  return (
    <fieldset>
      {/* The unit lives on the reading below, not here as well: stating "per
          business day" twice within one control reads as a mistake. */}
      <legend className="mb-4 text-[14px] font-medium text-gray-900">{legend}</legend>

      {/* Capped width. Stretched across a 1,200px column the bar reads as a
          progress indicator rather than something to grab. */}
      <div className="max-w-xl">

        {/* The current reading, stated before the control so the number is the
            headline and the bar is the way to change it. */}
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="flex items-baseline gap-1.5">
            <span className="text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-gray-900" dir="ltr">
              {current.dailyVolume}
            </span>
            <span className="text-[12.5px] text-gray-500">{hint}</span>
          </p>
          <p className="text-[12.5px] tabular-nums text-gray-500" dir="ltr">
            <span className={free ? "" : "font-medium text-gray-900"}>{cost}</span>
            {!free && (
              <span className="text-gray-400">
                {" · "}+{current.additionalCredits.toLocaleString()} {t("pricing.creditsWord")}
              </span>
            )}
          </p>
        </div>

        {/* Forced LTR: a quantity ladder runs low to high left to right in Hebrew
            too, and mirroring it makes "more" point the wrong way. */}
        <div className="px-2.5" dir="ltr">
          <div className="relative h-6">
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gray-200" />
            <div
              className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gray-900 transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${pct}%` }}
            />

            {options.map((o, i) => (
              <span
                key={o.key}
                aria-hidden="true"
                className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                  i <= index ? "bg-white/70" : "bg-gray-300"
                }`}
                style={{ left: `${max > 0 ? (i / max) * 100 : 0}%` }}
              />
            ))}

            <span
              aria-hidden="true"
              className={`pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-gray-900 bg-white shadow-sm transition-[left] duration-200 motion-reduce:transition-none ${
                focused ? "ring-2 ring-primary-400 ring-offset-2" : ""
              }`}
              style={{ left: `${pct}%` }}
            />

            <input
              type="range"
              min={0}
              max={max}
              step={1}
              value={index}
              onChange={(e) => onChange(options[Number(e.target.value)].key)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              aria-label={legend}
              aria-valuetext={t("pricing.a11y.volumeValue")
                .replace("{volume}", String(current.dailyVolume))
                .replace("{hint}", hint)
                .replace("{cost}", cost)}
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
            />
          </div>

          {/* Milestone labels. Clickable for a mouse, but hidden from assistive
              tech: the range input above is the one accessible control, and a
              second set of five buttons would only add noise to it. */}
          <div className="relative mt-2.5 h-5">
            {options.map((o, i) => {
              const p = max > 0 ? (i / max) * 100 : 0;
              const align = i === 0 ? "translate-x-0" : i === max ? "-translate-x-full" : "-translate-x-1/2";
              return (
                <button
                  key={o.key}
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={() => onChange(o.key)}
                  className={`absolute top-0 ${align} rounded px-1 text-[11.5px] tabular-nums transition-colors duration-200 ${
                    i === index ? "font-semibold text-gray-900" : "text-gray-400 hover:text-gray-700"
                  }`}
                  style={{ left: `${p}%` }}
                >
                  {o.dailyVolume}
                </button>
              );
            })}
          </div>
        </div>

        <p className="mt-3 text-[11.5px] text-gray-400">{t("pricing.volumeHint")}</p>
      </div>
    </fieldset>
  );
}
