"use client";

// The three-plan comparison.
//
// Composed as columns on ONE surface, split by dividers rather than floated as
// three separate cards. That is what makes it read as a considered comparison
// instead of a template card grid, and it keeps the price baselines, credit
// blocks and CTAs aligned across columns by construction.
//
// The dividers are a full-strength grey, not a tint: on a white page a 20%
// hairline all but disappeared and the three plans ran together.
//
// Each column prices a LIVE selection. The volume bar sits in the column
// itself, so the thing you change and the price that changes are next to each
// other, and every figure below (credits, capacity, price per conversation)
// moves with it.

import Link from "next/link";
import { planCopy } from "./usePublicPricing";
import { Price, Tag, Check, Reveal } from "./PricingPrimitives";
import { MilestoneBar } from "./MilestoneBar";
import { quoteSelection, formatMinor, type PublicPlan, type Selection } from "@/lib/api-public-pricing";

export interface PlanGridProps {
  plans: PublicPlan[];
  selections: Record<string, Selection>;
  activeKey: string | null;
  onSelect: (key: string) => void;
  /** Adjusting a column's bar. Absent on the landing preview. */
  onVolumeChange?: (planKey: string, channel: "chat" | "voice", optionKey: string) => void;
  isHe: boolean;
  t: (k: string) => string;
  /** Present when the visitor is signed in. */
  currentPlanKey?: string | null;
  /** Where the primary CTA goes. Differs for signed-in visitors. */
  ctaHref: string;
  ctaLabel: string;
  /** Compact variant for the landing page preview. */
  compact?: boolean;
}

export function PlanGrid({
  plans, selections, activeKey, onSelect, onVolumeChange, isHe, t, currentPlanKey,
  ctaHref, ctaLabel, compact = false,
}: PlanGridProps) {
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl bg-gray-300 ring-1 ring-gray-300 md:grid-cols-2 xl:grid-cols-3">
      {plans.map((plan, i) => (
        <Reveal key={plan.key} delay={i * 70} className="h-full">
          <PlanColumn
            plan={plan}
            previous={i > 0 ? plans[i - 1] : null}
            selection={selections[plan.key] ?? { chat: null, voice: null }}
            active={plan.key === activeKey}
            isCurrent={currentPlanKey === plan.key}
            onSelect={() => onSelect(plan.key)}
            onVolumeChange={onVolumeChange}
            isHe={isHe}
            t={t}
            ctaHref={ctaHref}
            ctaLabel={ctaLabel}
            compact={compact}
          />
        </Reveal>
      ))}
    </div>
  );
}

function PlanColumn({
  plan, previous, selection, active, isCurrent, onSelect, onVolumeChange, isHe, t,
  ctaHref, ctaLabel, compact,
}: {
  plan: PublicPlan;
  previous: PublicPlan | null;
  selection: Selection;
  active: boolean;
  isCurrent: boolean;
  onSelect: () => void;
  onVolumeChange?: (planKey: string, channel: "chat" | "voice", optionKey: string) => void;
  isHe: boolean;
  t: (k: string) => string;
  ctaHref: string;
  ctaLabel: string;
  compact: boolean;
}) {
  const { name, description } = planCopy(plan, isHe);
  const q = quoteSelection(plan, selection);

  // The entry plan lists everything it includes: it is the one column where the
  // full list IS the story, and truncating it made the cheapest plan look
  // thinner than it is.
  //
  // The plans above it lead with what they ADD, because repeating twenty shared
  // capabilities on every column makes three products look identical and buries
  // the actual reason to move up. The inherited set still appears underneath, as
  // a dense muted line, so nothing is hidden.
  const included = plan.features.filter((f) => f.included);
  const prevKeys = new Set((previous?.features ?? []).filter((f) => f.included).map((f) => f.key));
  const added = included.filter((f) => !prevKeys.has(f.key));
  const inherited = included.filter((f) => prevKeys.has(f.key));
  const isDelta = previous != null && added.length > 0;
  const ticked = isDelta ? added : included;
  const headline = compact ? ticked.slice(0, 3) : ticked;

  const adjustable = !compact && !!onVolumeChange && (plan.chatVolumeEnabled || plan.voiceVolumeEnabled);
  const priced = !plan.salesOnly && !!plan.price;

  return (
    <div
      className={`relative flex h-full flex-col bg-white p-6 sm:p-7 transition-colors duration-300 motion-reduce:transition-none ${
        active ? "" : "hover:bg-[#fcfcfd]"
      }`}
    >
      {/* Which column the detailed configurator below is showing.
          A top edge rather than an inset outline: a full rectangle drawn inside
          a rounded container squares off its corners and reads as a misplaced
          border. This is also not colour alone - the CTA and "See details"
          state the same thing. */}
      {active && (
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-gray-900" />
      )}

      {/* Header: name, then badges on their own line so a long Hebrew name and
          a badge never collide on a narrow column. */}
      <div className="flex min-h-[1.75rem] flex-wrap items-center gap-x-2 gap-y-1.5">
        <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-gray-900">{name}</h3>
        {plan.recommended && <Tag tone="accent">{t("pricing.recommended")}</Tag>}
        {isCurrent && <Tag>{t("pricing.currentPlan")}</Tag>}
      </div>

      {/* Fixed height keeps price baselines aligned across columns whether a
          description wraps to two lines or four. */}
      {description && (
        <p className="mt-2 min-h-[3.75rem] text-[13.5px] leading-[1.55] text-gray-500">{description}</p>
      )}

      <div className="mt-5">
        {priced ? (
          <Price
            formatted={formatMinor(q.monthlyMinor, q.currency)}
            interval={t("pricing.month")}
            size={compact ? "lg" : "xl"}
          />
        ) : (
          <Price formatted={t("pricing.custom")} size={compact ? "lg" : "xl"} />
        )}
        {/* Quotes the SELECTED total in the charged currency, not the plan's
            base price, or the note would understate what is actually billed. */}
        {priced && q.isEstimatedConversion && (
          <p className="mt-1.5 text-[11px] leading-snug text-gray-400">
            {t("pricing.approxIn")
              .replace("{display}", q.currency)
              .replace("{charged}", q.chargedCurrency)}{" "}
            <span dir="ltr" className="tabular-nums">
              {formatMinor(q.monthlyBaseMinor, q.baseCurrency)}
            </span>
          </p>
        )}
      </div>

      {/* Adjust the volume here, next to the price it moves. */}
      {adjustable && (
        <div className="mt-6 space-y-5 border-t border-gray-100 pt-5">
          {plan.chatVolumeEnabled && (
            <MilestoneBar
              size="compact"
              legend={t("pricing.chatVolume")}
              hint={t("pricing.perBusinessDay")}
              options={plan.chatOptions}
              value={selection.chat}
              onChange={(k) => onVolumeChange!(plan.key, "chat", k)}
              t={t}
            />
          )}
          {plan.voiceVolumeEnabled && (
            <MilestoneBar
              size="compact"
              legend={t("pricing.voiceVolume")}
              hint={t("pricing.perBusinessDay")}
              options={plan.voiceOptions}
              value={selection.voice}
              onChange={(k) => onVolumeChange!(plan.key, "voice", k)}
              t={t}
            />
          )}
        </div>
      )}

      {/* Credits, capacity and unit price. A definition list because that is
          what it is. Every figure follows the bar above. */}
      <dl className="mt-6 space-y-2 border-t border-gray-100 pt-5 text-[13.5px]">
        <Row label={t("pricing.includedCredits")} value={q.includedCredits.toLocaleString()} />
        {q.estimatedChatsMonthly > 0 && (
          <Row label={t("pricing.estimatedChats")} value={`~${q.estimatedChatsMonthly.toLocaleString()}`} />
        )}
        {q.estimatedCallsMonthly > 0 && (
          <Row label={t("pricing.estimatedCalls")} value={`~${q.estimatedCallsMonthly.toLocaleString()}`} />
        )}
        {priced && q.pricePerChatMinor != null && (
          <Row
            label={t("pricing.perConversation")}
            value={formatMinor(q.pricePerChatMinor, q.currency, 2)}
            muted
          />
        )}
        {priced && q.pricePerCallMinor != null && (
          <Row label={t("pricing.perCall")} value={formatMinor(q.pricePerCallMinor, q.currency, 2)} muted />
        )}
      </dl>

      <div className="mt-5 grow border-t border-gray-100 pt-5">
        {isDelta && (
          <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">
            {t("pricing.everythingIn").replace("{plan}", planCopy(previous!, isHe).name)}
          </p>
        )}
        <ul className="space-y-2">
          {headline.map((f) => (
            <li key={f.key} className="flex items-start gap-2.5 text-[13.5px] leading-snug text-gray-700">
              <Check className="mt-[3px] text-gray-900" />
              <span>{f.name}</span>
            </li>
          ))}
        </ul>

        {/* Everything carried up from the plan below, stated in full but set
            quietly so it does not compete with what this plan adds. */}
        {!compact && isDelta && inherited.length > 0 && (
          <p className="mt-4 text-[12px] leading-[1.6] text-gray-400">
            <span className="font-medium text-gray-500">{t("pricing.alsoIncludes")} </span>
            {inherited.map((f) => f.name).join(", ")}
          </p>
        )}
      </div>

      {/* CTA pinned to the bottom of every column by the grow above it. */}
      <div className="mt-7">
        {compact ? (
          <button
            onClick={onSelect}
            className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-[13.5px] font-medium text-gray-700 transition-colors duration-200 hover:border-gray-300 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            {t("pricing.seeDetails")}
          </button>
        ) : (
          <>
            <Link
              href={ctaHref}
              onClick={onSelect}
              className={`flex w-full items-center justify-center rounded-xl px-4 py-3 text-[14px] font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 ${
                plan.recommended
                  ? "bg-gray-900 text-white hover:bg-gray-800"
                  : "border border-gray-200 text-gray-900 hover:border-gray-900"
              }`}
            >
              {isCurrent ? t("pricing.managePlan") : ctaLabel}
            </Link>
            {/* The volume is adjusted above now, so this opens the detailed
                breakdown - credits split, blended unit price, FX note. */}
            {(plan.chatVolumeEnabled || plan.voiceVolumeEnabled) && (
              <button
                onClick={onSelect}
                className="mt-2.5 w-full rounded text-center text-[12.5px] font-medium text-primary-600 underline-offset-4 transition-colors hover:text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
              >
                {t("pricing.seeDetails")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One figure in the plan's summary list. */
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
