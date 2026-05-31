"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import {
  getPricingUnitCosts,
  getPricingTrends,
  type PricingCategoryRow,
  type PricingUnitCosts,
  type PricingTrends,
  type PricingCategoryKey,
} from "@/lib/api";
import clsx from "clsx";

type Period = 7 | 30 | 90 | 365;

// Tailwind palette per category — keeps Find-Visual-Identity matching across
// the page (card border, swatch in legend, bar fill in trends).
const COLOR_MAP: Record<string, { bg: string; border: string; text: string; bar: string; dot: string }> = {
  violet: { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-700", bar: "bg-violet-500", dot: "bg-violet-500" },
  blue:   { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-700",   bar: "bg-blue-500",   dot: "bg-blue-500" },
  rose:   { bg: "bg-rose-50",   border: "border-rose-200",   text: "text-rose-700",   bar: "bg-rose-500",   dot: "bg-rose-500" },
  emerald:{ bg: "bg-emerald-50",border: "border-emerald-200",text: "text-emerald-700",bar: "bg-emerald-500",dot: "bg-emerald-500" },
  amber:  { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-700",  bar: "bg-amber-500",  dot: "bg-amber-500" },
  slate:  { bg: "bg-slate-50",  border: "border-slate-200",  text: "text-slate-700",  bar: "bg-slate-500",  dot: "bg-slate-500" },
  indigo: { bg: "bg-indigo-50", border: "border-indigo-200", text: "text-indigo-700", bar: "bg-indigo-500", dot: "bg-indigo-500" },
};

function colorOf(color: string) {
  return COLOR_MAP[color] ?? COLOR_MAP.slate;
}

function fmtUsd(n: number, digits = 4): string {
  if (!isFinite(n) || n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(digits)}`;
}
function fmtUsdShort(n: number): string {
  if (!isFinite(n) || n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n >= 1000) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return Math.round(n).toLocaleString();
}
function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export default function SystemPricingPage() {
  const { token } = useAuth();
  const [period, setPeriod] = useState<Period>(30);
  const [unit, setUnit] = useState<PricingUnitCosts | null>(null);
  const [trends, setTrends] = useState<PricingTrends | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [u, t] = await Promise.all([
        getPricingUnitCosts(token, period),
        getPricingTrends(token, period),
      ]);
      setUnit(u.data);
      setTrends(t.data);
    } catch (err) {
      console.error("Pricing fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <SystemLayout>
      <div className="p-6 overflow-y-auto h-screen">
        <Header period={period} setPeriod={setPeriod} unit={unit} />
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
          </div>
        ) : !unit ? (
          <p className="text-sm text-gray-400 text-center py-12">Failed to load pricing data.</p>
        ) : (
          <div className="space-y-8 mt-6">
            <PlatformSummary unit={unit} />
            <UnitEconomicsSection categories={unit.categories} />
            <CalculatorSection categories={unit.categories} />
            <TrendsSection trends={trends} />
            <PricingTable pricing={unit.pricing} />
          </div>
        )}
      </div>
    </SystemLayout>
  );
}

// ─── Header ─────────────────────────────────────────────────

function Header({
  period,
  setPeriod,
  unit,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  unit: PricingUnitCosts | null;
}) {
  const totalCost = unit?.totals.costUsd ?? 0;
  const totalCalls = unit?.totals.calls ?? 0;
  return (
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Pricing Model</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Unit economics for every AI feature · {fmtUsdShort(totalCost)} cost across{" "}
          {totalCalls.toLocaleString()} calls (last {unit?.period ?? period} days)
        </p>
      </div>
      <select
        value={period}
        onChange={(e) => setPeriod(Number(e.target.value) as Period)}
        className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none w-fit"
      >
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
        <option value={365}>Last year</option>
      </select>
    </div>
  );
}

// ─── Top-of-page summary ────────────────────────────────────

function PlatformSummary({ unit }: { unit: PricingUnitCosts }) {
  const t = unit.totals;
  const blendedInputPer1K = t.promptTokens > 0 ? (t.inputCostUsd / t.promptTokens) * 1000 : 0;
  const blendedOutputPer1K = t.completionTokens > 0 ? (t.outputCostUsd / t.completionTokens) * 1000 : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      <SummaryCard label="Total Cost" value={fmtUsdShort(t.costUsd)} sub={`${t.calls.toLocaleString()} calls`} highlight />
      <SummaryCard label="Conversations" value={fmtNum(t.conversations)} sub={t.calls > 0 ? `${(t.calls / Math.max(1, t.conversations)).toFixed(1)} calls/convo` : ""} />
      <SummaryCard label="Input Tokens" value={fmtNum(t.promptTokens)} sub={fmtUsdShort(t.inputCostUsd)} />
      <SummaryCard label="Output Tokens" value={fmtNum(t.completionTokens)} sub={fmtUsdShort(t.outputCostUsd)} />
      <SummaryCard label="Blended $/1K in" value={fmtUsd(blendedInputPer1K, 5)} sub="prompt rate" />
      <SummaryCard label="Blended $/1K out" value={fmtUsd(blendedOutputPer1K, 5)} sub="completion rate" />
    </div>
  );
}

function SummaryCard({
  label, value, sub, highlight,
}: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={clsx(
      "rounded-2xl border p-4",
      highlight ? "bg-green-50 border-green-200" : "bg-white border-gray-200",
    )}>
      <p className={clsx(
        "text-[10px] font-medium uppercase tracking-wider",
        highlight ? "text-green-600" : "text-gray-500",
      )}>{label}</p>
      <p className={clsx(
        "text-xl font-bold mt-1",
        highlight ? "text-green-700" : "text-gray-900",
      )}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

// ─── Unit economics per category ────────────────────────────

function UnitEconomicsSection({ categories }: { categories: PricingCategoryRow[] }) {
  const visible = categories.filter((c) => c.calls > 0 || c.category !== "other");
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Unit Economics by Feature</h2>
        <p className="text-xs text-gray-400">Avg cost per call · per conversation · blended in/out rates</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {visible.map((c) => (
          <CategoryCard key={c.category} row={c} />
        ))}
      </div>
    </section>
  );
}

function CategoryCard({ row }: { row: PricingCategoryRow }) {
  const c = colorOf(row.color);
  const hasData = row.calls > 0;
  return (
    <div className={clsx("rounded-2xl border p-5 bg-white", c.border)}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={clsx("w-2 h-2 rounded-full", c.dot)} />
            <h3 className="font-semibold text-gray-900 text-sm">{row.label}</h3>
          </div>
          <p className="text-[11px] text-gray-400 mt-0.5">{row.description}</p>
        </div>
        <span className={clsx("text-xs px-2 py-0.5 rounded-full font-medium border", c.bg, c.border, c.text)}>
          {fmtUsdShort(row.costUsd)}
        </span>
      </div>

      {!hasData ? (
        <p className="text-xs text-gray-400 py-6 text-center">No usage in this period.</p>
      ) : (
        <>
          {/* Headline unit metrics — what you'd price-list against. */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Metric label="Per call" value={fmtUsd(row.avgCostPerCall, 5)} sub={`${row.calls.toLocaleString()} calls`} />
            <Metric
              label="Per conversation"
              value={row.avgCostPerConversation !== null ? fmtUsd(row.avgCostPerConversation, 5) : "—"}
              sub={row.conversations > 0 ? `${row.conversations.toLocaleString()} convos` : "n/a"}
            />
            <Metric
              label="$/1K input"
              value={row.blendedInputUsdPer1K !== null ? fmtUsd(row.blendedInputUsdPer1K, 5) : "—"}
              sub={`${fmtNum(row.promptTokens)} in`}
            />
            <Metric
              label="$/1K output"
              value={row.blendedOutputUsdPer1K !== null ? fmtUsd(row.blendedOutputUsdPer1K, 5) : "—"}
              sub={`${fmtNum(row.completionTokens)} out`}
            />
          </div>

          {/* In/out cost split bar — visualises where the bill actually went. */}
          <div className="mb-3">
            <div className="flex justify-between text-[10px] text-gray-400 mb-1">
              <span>Input · {fmtUsdShort(row.inputCostUsd)}</span>
              <span>Output · {fmtUsdShort(row.outputCostUsd)}</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-sky-400"
                style={{ width: `${pctOfTotal(row.inputCostUsd, row.inputCostUsd + row.outputCostUsd)}%` }}
              />
              <div
                className="h-full bg-fuchsia-400"
                style={{ width: `${pctOfTotal(row.outputCostUsd, row.inputCostUsd + row.outputCostUsd)}%` }}
              />
            </div>
          </div>

          {/* Cache hit footer — when prompt prefix caching is working, $/1K
              effective drops sharply. Useful sanity check next to the rates. */}
          <div className="flex items-center justify-between text-[11px] text-gray-500 pt-2 border-t border-gray-100">
            <span>Cache hit: <span className={clsx(
              "font-mono font-semibold",
              row.cacheHitPct === null ? "text-gray-300" :
              row.cacheHitPct >= 40 ? "text-emerald-600" :
              row.cacheHitPct >= 20 ? "text-amber-600" : "text-rose-600",
            )}>{fmtPct(row.cacheHitPct)}</span></span>
            <span>{row.modelMix.length} model{row.modelMix.length === 1 ? "" : "s"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-gray-50 p-2.5">
      <p className="text-[9px] text-gray-400 uppercase tracking-wider font-medium">{label}</p>
      <p className="text-sm font-bold text-gray-900 font-mono">{value}</p>
      {sub && <p className="text-[9px] text-gray-400 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

function pctOfTotal(part: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

// ─── Pricing calculator ─────────────────────────────────────
//
// Lets the operator answer "what price-per-X should I charge to hit a target
// gross margin?". Inputs are per-category expected volume (calls or convos
// per tenant per month) and a markup %; output is the suggested price plus
// projected revenue, COGS, and margin.

type CalcRow = {
  enabled: boolean;
  unit: "call" | "conversation";
  /** Expected volume per tenant per month. */
  volume: number;
  /** Gross margin target as a percentage (0..95). */
  marginPct: number;
};

function CalculatorSection({ categories }: { categories: PricingCategoryRow[] }) {
  // Categories that actually have data — calculator otherwise has nothing to
  // base unit cost on.
  const billable = categories.filter((c) => c.calls > 0 || c.category === "autonomous_agent" || c.category === "call_pilot" || c.category === "copilot_inbox");

  const [rows, setRows] = useState<Record<string, CalcRow>>(() => {
    const init: Record<string, CalcRow> = {};
    for (const c of billable) {
      init[c.category] = {
        enabled: c.calls > 0,
        // Default to whatever the natural billing unit is for this surface;
        // operator can flip per-category.
        unit: c.perConversation && c.avgCostPerConversation !== null ? "conversation" : "call",
        volume:
          c.perConversation && c.avgCostPerConversation !== null
            ? Math.max(50, Math.round(c.conversations / Math.max(1, c.calls > 0 ? 1 : 1)))
            : 1000,
        marginPct: 70,
      };
    }
    return init;
  });

  // Re-sync when the underlying period/data shifts: enable categories that
  // newly have data, leave operator overrides intact otherwise.
  useEffect(() => {
    setRows((prev) => {
      const next = { ...prev };
      for (const c of billable) {
        if (!next[c.category]) {
          next[c.category] = {
            enabled: c.calls > 0,
            unit: c.perConversation && c.avgCostPerConversation !== null ? "conversation" : "call",
            volume: 1000,
            marginPct: 70,
          };
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.map((c) => c.category).join(",")]);

  const update = (key: PricingCategoryKey, patch: Partial<CalcRow>) =>
    setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));

  // Per-row pricing math.
  const computed = useMemo(() => {
    return billable.map((c) => {
      const cfg = rows[c.category] ?? { enabled: false, unit: "call" as const, volume: 0, marginPct: 70 };
      const unitCost =
        cfg.unit === "conversation"
          ? c.avgCostPerConversation ?? c.avgCostPerCall
          : c.avgCostPerCall;
      const m = Math.max(0, Math.min(95, cfg.marginPct)) / 100;
      // Standard gross-margin pricing: price = cost / (1 - margin).
      const suggestedPrice = m < 0.99 ? unitCost / (1 - m) : unitCost;
      const cogsPerTenant = unitCost * cfg.volume;
      const revenuePerTenant = suggestedPrice * cfg.volume;
      const profitPerTenant = revenuePerTenant - cogsPerTenant;
      return {
        row: c,
        cfg,
        unitCost,
        suggestedPrice,
        cogsPerTenant,
        revenuePerTenant,
        profitPerTenant,
      };
    });
  }, [billable, rows]);

  const totals = useMemo(() => {
    return computed.reduce(
      (acc, r) => {
        if (!r.cfg.enabled) return acc;
        acc.cogs += r.cogsPerTenant;
        acc.revenue += r.revenuePerTenant;
        acc.profit += r.profitPerTenant;
        return acc;
      },
      { cogs: 0, revenue: 0, profit: 0 },
    );
  }, [computed]);

  const totalMargin = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : 0;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Pricing Calculator</h2>
        <p className="text-xs text-gray-400">Set expected volume + target margin → suggested price per unit</p>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-400">
              <tr>
                <th className="text-start py-2.5 px-4">Feature</th>
                <th className="text-start py-2.5 px-2">Bill by</th>
                <th className="text-end py-2.5 px-2">Unit cost</th>
                <th className="text-end py-2.5 px-2">Volume / tenant / mo</th>
                <th className="text-end py-2.5 px-2">Margin %</th>
                <th className="text-end py-2.5 px-2">Suggested price</th>
                <th className="text-end py-2.5 px-2">COGS / tenant</th>
                <th className="text-end py-2.5 px-2">Revenue / tenant</th>
                <th className="text-end py-2.5 px-4">Profit / tenant</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {computed.map(({ row, cfg, unitCost, suggestedPrice, cogsPerTenant, revenuePerTenant, profitPerTenant }) => {
                const c = colorOf(row.color);
                return (
                  <tr key={row.category} className={clsx(cfg.enabled ? "" : "opacity-50")}>
                    <td className="py-2 px-4">
                      <label className="inline-flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={cfg.enabled}
                          onChange={(e) => update(row.category, { enabled: e.target.checked })}
                        />
                        <span className={clsx("w-2 h-2 rounded-full", c.dot)} />
                        <span className="font-medium text-gray-800">{row.label}</span>
                      </label>
                    </td>
                    <td className="py-2 px-2">
                      <select
                        value={cfg.unit}
                        onChange={(e) => update(row.category, { unit: e.target.value as "call" | "conversation" })}
                        className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 focus:ring-1 focus:ring-violet-200 outline-none"
                      >
                        <option value="call">per call</option>
                        <option value="conversation" disabled={row.avgCostPerConversation === null}>
                          per conversation{row.avgCostPerConversation === null ? " (n/a)" : ""}
                        </option>
                      </select>
                    </td>
                    <td className="py-2 px-2 text-end font-mono text-xs text-gray-700">{fmtUsd(unitCost, 5)}</td>
                    <td className="py-2 px-2 text-end">
                      <input
                        type="number"
                        min={0}
                        value={cfg.volume}
                        onChange={(e) => update(row.category, { volume: Math.max(0, Number(e.target.value) || 0) })}
                        className="w-24 text-end font-mono text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 focus:ring-1 focus:ring-violet-200 outline-none"
                      />
                    </td>
                    <td className="py-2 px-2 text-end">
                      <input
                        type="number"
                        min={0}
                        max={95}
                        value={cfg.marginPct}
                        onChange={(e) =>
                          update(row.category, { marginPct: Math.max(0, Math.min(95, Number(e.target.value) || 0)) })
                        }
                        className="w-16 text-end font-mono text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 focus:ring-1 focus:ring-violet-200 outline-none"
                      />
                    </td>
                    <td className="py-2 px-2 text-end font-mono text-xs font-semibold text-violet-700">
                      {fmtUsd(suggestedPrice, 5)}
                    </td>
                    <td className="py-2 px-2 text-end font-mono text-xs text-gray-600">{fmtUsdShort(cogsPerTenant)}</td>
                    <td className="py-2 px-2 text-end font-mono text-xs text-gray-700">{fmtUsdShort(revenuePerTenant)}</td>
                    <td className="py-2 px-4 text-end font-mono text-xs font-semibold text-emerald-600">
                      {fmtUsdShort(profitPerTenant)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 border-t border-gray-200">
              <tr>
                <td colSpan={6} className="py-2.5 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Per-tenant totals (enabled rows)
                </td>
                <td className="py-2.5 px-2 text-end font-mono text-sm font-bold text-gray-700">
                  {fmtUsdShort(totals.cogs)}
                </td>
                <td className="py-2.5 px-2 text-end font-mono text-sm font-bold text-gray-900">
                  {fmtUsdShort(totals.revenue)}
                </td>
                <td className="py-2.5 px-4 text-end">
                  <span className="font-mono text-sm font-bold text-emerald-700">{fmtUsdShort(totals.profit)}</span>
                  <span className="text-[10px] text-gray-400 ms-1">({totalMargin.toFixed(0)}% margin)</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p className="text-[11px] text-gray-400 mt-2 px-1">
        Unit costs reflect observed average over the selected period (cache-discounted). Suggested
        price = cost ÷ (1 − margin). Call-pilot covers AI tokens only — Twilio/STT/TTS provider
        fees are not included.
      </p>
    </section>
  );
}

// ─── Trends chart ───────────────────────────────────────────

function TrendsSection({ trends }: { trends: PricingTrends | null }) {
  if (!trends || trends.days.length === 0) return null;

  // Per-day stacked totals → used to scale bar heights.
  const dailyTotals = trends.days.map((_, i) =>
    trends.series.reduce((sum, s) => sum + (s.cost[i] || 0), 0),
  );
  const maxDaily = Math.max(0.0001, ...dailyTotals);

  // Visible series — drop categories that contributed nothing in this period
  // so the legend doesn't bloat.
  const visibleSeries = trends.series.filter((s) => s.cost.some((v) => v > 0));

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Daily Cost Trend</h2>
        <p className="text-xs text-gray-400">Stacked by feature category</p>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
          {visibleSeries.map((s) => {
            const c = colorOf(s.color);
            const total = s.cost.reduce((a, b) => a + b, 0);
            return (
              <div key={s.category} className="flex items-center gap-1.5">
                <span className={clsx("w-2.5 h-2.5 rounded-sm", c.dot)} />
                <span className="text-xs text-gray-600">{s.label}</span>
                <span className="text-[10px] text-gray-400 font-mono">{fmtUsdShort(total)}</span>
              </div>
            );
          })}
        </div>

        {/* Bars — pure CSS stacked column chart. Width auto-fits container. */}
        <div className="flex items-end gap-0.5 h-48 overflow-x-auto pb-1">
          {trends.days.map((day, i) => {
            const dayTotal = dailyTotals[i];
            const heightPct = (dayTotal / maxDaily) * 100;
            return (
              <div
                key={day}
                className="flex-1 min-w-[6px] flex flex-col items-center group relative"
                title={`${day} · ${fmtUsdShort(dayTotal)}`}
              >
                <div className="w-full flex flex-col-reverse rounded-t-sm overflow-hidden" style={{ height: `${heightPct}%`, minHeight: dayTotal > 0 ? "2px" : 0 }}>
                  {visibleSeries.map((s) => {
                    const v = s.cost[i] || 0;
                    if (v <= 0 || dayTotal <= 0) return null;
                    const c = colorOf(s.color);
                    return (
                      <div
                        key={s.category}
                        className={c.bar}
                        style={{ height: `${(v / dayTotal) * 100}%` }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* X-axis labels — only first, middle, last to avoid clutter. */}
        <div className="flex justify-between mt-1 px-1 text-[10px] text-gray-400">
          <span>{trends.days[0]}</span>
          {trends.days.length > 2 && <span>{trends.days[Math.floor(trends.days.length / 2)]}</span>}
          <span>{trends.days[trends.days.length - 1]}</span>
        </div>
      </div>
    </section>
  );
}

// ─── Provider rate card ─────────────────────────────────────

function PricingTable({ pricing }: { pricing: Record<string, { prompt: number; completion: number }> }) {
  const rows = Object.entries(pricing);
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Provider Rate Card</h2>
        <p className="text-xs text-gray-400">What we pay OpenAI per 1M tokens</p>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-400">
            <tr>
              <th className="text-start py-2 px-4">Model</th>
              <th className="text-end py-2 px-4">Input ($/1M)</th>
              <th className="text-end py-2 px-4">Output ($/1M)</th>
              <th className="text-end py-2 px-4">In·Out ratio</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map(([model, p]) => (
              <tr key={model}>
                <td className="py-2 px-4 font-mono text-xs text-gray-700">{model}</td>
                <td className="py-2 px-4 text-end font-mono text-xs">${p.prompt.toFixed(2)}</td>
                <td className="py-2 px-4 text-end font-mono text-xs">${p.completion.toFixed(2)}</td>
                <td className="py-2 px-4 text-end font-mono text-xs text-gray-400">
                  {p.prompt > 0 ? `1 : ${(p.completion / p.prompt).toFixed(1)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
