"use client";

// Full capability comparison.
//
// Desktop is a real <table> with a sticky header and proper scope attributes,
// because that is what a comparison IS and screen readers navigate it that way.
//
// Narrow screens get a deliberately different pattern rather than the same
// table squeezed until it overflows: pick two plans, then read accordion
// categories comparing exactly those two. That is the interaction someone
// actually performs on a phone.

import { useMemo, useState } from "react";
import { planCopy } from "./usePublicPricing";
import { Check, NotIncluded } from "./PricingPrimitives";
import type { PublicPlan } from "@/lib/api-public-pricing";

const CATEGORY_ORDER = ["COMMUNICATION", "AI", "VOICE", "MANAGEMENT"] as const;

/** Limits worth comparing publicly. Storage and retention stay out of the marketing table. */
const LIMIT_ROWS = [
  "limit:users",
  "limit:ai_employees",
  "limit:channels",
  "limit:departments",
  "limit:knowledge_sources",
  "limit:workflows",
] as const;

interface Row {
  key: string;
  label: string;
  description: string | null;
  /** Per plan key: true/false for a capability, or a number for a limit. */
  values: Record<string, boolean | number | null>;
  kind: "feature" | "limit";
}

export function ComparisonTable({
  plans, isHe, t,
}: {
  plans: PublicPlan[];
  isHe: boolean;
  t: (k: string) => string;
}) {
  const groups = useMemo(() => buildGroups(plans, t), [plans, t]);
  const [mobilePair, setMobilePair] = useState<[string, string]>(() => [
    plans[0]?.key ?? "",
    (plans.find((p) => p.recommended) ?? plans[1] ?? plans[0])?.key ?? "",
  ]);

  if (plans.length === 0) return null;

  return (
    <>
      {/* ── Desktop / tablet: semantic table ── */}
      <div className="hidden overflow-hidden rounded-2xl border border-gray-200 md:block">
        <table className="w-full border-collapse text-[13.5px]">
          <caption className="sr-only">{t("pricing.comparison.caption")}</caption>
          <thead>
            <tr className="sticky top-0 z-10 bg-white/95 backdrop-blur">
              <th scope="col" className="w-[38%] px-5 py-4 text-start text-[11px] font-medium uppercase tracking-[0.14em] text-gray-400">
                {t("pricing.comparison.capability")}
              </th>
              {plans.map((p) => (
                <th key={p.key} scope="col" className="px-4 py-4 text-center">
                  <span className="block text-[14px] font-semibold text-gray-900">{planCopy(p, isHe).name}</span>
                  {p.price && (
                    <span className="mt-0.5 block text-[12px] font-normal tabular-nums text-gray-400" dir="ltr">
                      {p.price.formatted}/{t("pricing.month")}
                    </span>
                  )}
                </th>
              ))}
            </tr>
            <tr>
              <td colSpan={plans.length + 1} className="h-px bg-gray-200 p-0" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <>
                <tr key={`h-${g.category}`} className="bg-[#fafafa]">
                  <th
                    scope="colgroup"
                    colSpan={plans.length + 1}
                    className="px-5 py-2.5 text-start text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500"
                  >
                    {g.label}
                  </th>
                </tr>
                {g.rows.map((row) => (
                  <tr key={row.key} className="border-t border-gray-100">
                    <th scope="row" className="px-5 py-3 text-start font-normal text-gray-700">
                      <span>{row.label}</span>
                      {row.description && (
                        <span className="mt-0.5 block text-[12px] leading-snug text-gray-400">{row.description}</span>
                      )}
                    </th>
                    {plans.map((p) => (
                      <td key={p.key} className="px-4 py-3 text-center">
                        <Cell value={row.values[p.key]} kind={row.kind} t={t} />
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Narrow: choose two plans, compare by category ── */}
      <div className="md:hidden">
        <PairPicker plans={plans} pair={mobilePair} onChange={setMobilePair} isHe={isHe} t={t} />
        <div className="mt-4 space-y-2">
          {groups.map((g) => (
            <MobileCategory
              key={g.category}
              label={g.label}
              rows={g.rows}
              pair={mobilePair}
              plans={plans}
              isHe={isHe}
              t={t}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function Cell({ value, kind, t }: { value: boolean | number | null | undefined; kind: Row["kind"]; t: (k: string) => string }) {
  if (kind === "limit") {
    if (value == null) return <NotIncluded label={t("pricing.comparison.notIncluded")} />;
    const n = Number(value);
    if (n === 0) return <NotIncluded label={t("pricing.comparison.notIncluded")} />;
    return (
      <span className="font-medium tabular-nums text-gray-900" dir="ltr">
        {n < 0 ? t("pricing.comparison.unlimited") : n.toLocaleString()}
      </span>
    );
  }
  return value ? (
    <>
      <Check className="mx-auto text-gray-900" />
      <span className="sr-only">{t("pricing.comparison.included")}</span>
    </>
  ) : (
    <NotIncluded label={t("pricing.comparison.notIncluded")} />
  );
}

function PairPicker({
  plans, pair, onChange, isHe, t,
}: {
  plans: PublicPlan[];
  pair: [string, string];
  onChange: (p: [string, string]) => void;
  isHe: boolean;
  t: (k: string) => string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {[0, 1].map((slot) => (
        <label key={slot} className="block">
          <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-gray-400">
            {slot === 0 ? t("pricing.comparison.compareA") : t("pricing.comparison.compareB")}
          </span>
          <select
            value={pair[slot]}
            onChange={(e) => {
              const next: [string, string] = [...pair] as [string, string];
              next[slot] = e.target.value;
              onChange(next);
            }}
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-[14px] font-medium text-gray-900 focus:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {planCopy(p, isHe).name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

function MobileCategory({
  label, rows, pair, plans, isHe, t,
}: {
  label: string;
  rows: Row[];
  pair: [string, string];
  plans: PublicPlan[];
  isHe: boolean;
  t: (k: string) => string;
}) {
  const [open, setOpen] = useState(false);
  // Only rows where the two chosen plans actually differ lead; identical rows
  // still render but after, so the comparison answers "what changes?" first.
  const differing = rows.filter((r) => r.values[pair[0]] !== r.values[pair[1]]);
  const same = rows.filter((r) => r.values[pair[0]] === r.values[pair[1]]);

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 bg-white px-4 py-3.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400"
      >
        <span className="text-[13.5px] font-semibold text-gray-900">{label}</span>
        <span className="flex items-center gap-2">
          {differing.length > 0 && (
            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700">
              {t("pricing.comparison.differences").replace("{n}", String(differing.length))}
            </span>
          )}
          <svg
            className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          <table className="w-full text-[13px]">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr className="bg-[#fafafa]">
                <th scope="col" className="px-4 py-2 text-start text-[11px] font-medium uppercase tracking-[0.12em] text-gray-400">
                  {t("pricing.comparison.capability")}
                </th>
                {pair.map((k) => (
                  <th key={k} scope="col" className="px-3 py-2 text-center text-[12px] font-semibold text-gray-700">
                    {planCopy(plans.find((p) => p.key === k)!, isHe).name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...differing, ...same].map((row) => (
                <tr key={row.key} className="border-t border-gray-100">
                  <th scope="row" className="px-4 py-2.5 text-start font-normal text-gray-700">{row.label}</th>
                  {pair.map((k) => (
                    <td key={k} className="px-3 py-2.5 text-center">
                      <Cell value={row.values[k]} kind={row.kind} t={t} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function buildGroups(plans: PublicPlan[], t: (k: string) => string) {
  const byCategory = new Map<string, Row[]>();

  // Features, in catalog order, union across plans.
  const seen = new Set<string>();
  for (const p of plans) {
    for (const f of p.features) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      const values: Record<string, boolean | number | null> = {};
      for (const q of plans) values[q.key] = q.features.find((x) => x.key === f.key)?.included ?? false;
      const list = byCategory.get(f.category) ?? [];
      list.push({ key: f.key, label: f.name, description: f.description, values, kind: "feature" });
      byCategory.set(f.category, list);
    }
  }

  const groups = CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => ({
    category: c as string,
    label: t(`pricing.comparison.category.${c}`),
    rows: byCategory.get(c)!,
  }));

  // Limits as their own group - numbers matter as much as ticks.
  const limitRows: Row[] = LIMIT_ROWS.filter((k) => plans.some((p) => p.limits[k] != null)).map((k) => {
    const values: Record<string, boolean | number | null> = {};
    for (const p of plans) values[p.key] = p.limits[k] ?? null;
    return {
      key: k,
      label: t(`pricing.comparison.limit.${k.replace("limit:", "")}`),
      description: null,
      values,
      kind: "limit" as const,
    };
  });
  if (limitRows.length) {
    groups.push({ category: "LIMITS", label: t("pricing.comparison.category.LIMITS"), rows: limitRows });
  }

  return groups;
}
