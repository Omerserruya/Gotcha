"use client";

// The three-plan comparison.
//
// Composed as ONE bordered surface split by hairline gaps (`gap-px` over a grey
// background) rather than three floating cards. That is what makes it read as a
// considered comparison instead of a template card grid, and it keeps the price
// baselines, credit blocks and CTAs aligned across columns by construction.

import Link from "next/link";
import { planCopy } from "./usePublicPricing";
import { Price, Tag, Check, Reveal } from "./PricingPrimitives";
import { quoteSelection, formatMinor, type PublicPlan, type Selection } from "@/lib/api-public-pricing";

export interface PlanGridProps {
  plans: PublicPlan[];
  selections: Record<string, Selection>;
  activeKey: string | null;
  onSelect: (key: string) => void;
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
  plans, selections, activeKey, onSelect, isHe, t, currentPlanKey, ctaHref, ctaLabel, compact = false,
}: PlanGridProps) {
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl bg-gray-200/70 md:grid-cols-2 xl:grid-cols-3">
      {plans.map((plan, i) => (
        <Reveal key={plan.key} delay={i * 70}>
          <PlanColumn
            plan={plan}
            previous={i > 0 ? plans[i - 1] : null}
            selection={selections[plan.key] ?? { chat: null, voice: null }}
            active={plan.key === activeKey}
            isCurrent={currentPlanKey === plan.key}
            onSelect={() => onSelect(plan.key)}
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
  plan, previous, selection, active, isCurrent, onSelect, isHe, t, ctaHref, ctaLabel, compact,
}: {
  plan: PublicPlan;
  previous: PublicPlan | null;
  selection: Selection;
  active: boolean;
  isCurrent: boolean;
  onSelect: () => void;
  isHe: boolean;
  t: (k: string) => string;
  ctaHref: string;
  ctaLabel: string;
  compact: boolean;
}) {
  const { name, description } = planCopy(plan, isHe);
  const q = quoteSelection(plan, selection);

  // Show what this plan ADDS over the one below it. Repeating the shared
  // capabilities on every column makes three products look identical and hides
  // the actual reason to move up.
  const included = plan.features.filter((f) => f.included);
  const prevKeys = new Set((previous?.features ?? []).filter((f) => f.included).map((f) => f.key));
  const added = included.filter((f) => !prevKeys.has(f.key));
  const isDelta = previous != null && added.length > 0;
  const headline = (isDelta ? added : included).slice(0, compact ? 3 : 5);

  return (
    <div
      className={`relative flex h-full flex-col bg-white p-6 sm:p-7 transition-shadow duration-300 ${
        active ? "shadow-[inset_0_0_0_1.5px_rgb(17,24,39)]" : "hover:shadow-panel"
      }`}
    >
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
        {plan.salesOnly || !plan.price ? (
          <Price formatted={t("pricing.custom")} size={compact ? "lg" : "xl"} />
        ) : (
          <Price
            formatted={plan.price.formatted}
            interval={t("pricing.month")}
            size={compact ? "lg" : "xl"}
          />
        )}
        {plan.price?.isEstimatedConversion && (
          <p className="mt-1.5 text-[11px] leading-snug text-gray-400">
            {t("pricing.approxIn")
              .replace("{display}", plan.price.currency)
              .replace("{charged}", plan.price.chargedCurrency)}{" "}
            <span dir="ltr" className="tabular-nums">{plan.price.base.formatted}</span>
          </p>
        )}
      </div>

      {/* Credits + capacity. A definition list because that is what it is. */}
      <dl className="mt-6 space-y-2 border-t border-gray-100 pt-5 text-[13.5px]">
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
        {q.estimatedCallsMonthly > 0 && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500">{t("pricing.estimatedCalls")}</dt>
            <dd className="font-medium tabular-nums text-gray-900" dir="ltr">
              ~{q.estimatedCallsMonthly.toLocaleString()}
            </dd>
          </div>
        )}
        {!compact && q.pricePerChatMinor != null && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500">{t("pricing.perConversation")}</dt>
            <dd className="font-medium tabular-nums text-gray-900" dir="ltr">
              {formatMinor(q.pricePerChatMinor, q.currency, 2)}
            </dd>
          </div>
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
            {(plan.chatVolumeEnabled || plan.voiceVolumeEnabled) && (
              <button
                onClick={onSelect}
                className="mt-2.5 w-full text-center text-[12.5px] font-medium text-primary-600 underline-offset-4 transition-colors hover:text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 rounded"
              >
                {t("pricing.configureVolume")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
