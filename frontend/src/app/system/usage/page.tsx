"use client";

import { useState, useEffect, useCallback } from "react";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import { getSystemUsageStats, getSystemUsageByTenant } from "@/lib/api";
import clsx from "clsx";

type Period = 7 | 30 | 90 | 365;

interface AiFeatureRow {
  feature: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Subset of promptTokens that hit OpenAI's automatic prefix cache. */
  cachedPromptTokens?: number;
  costUsd: number;
  calls: number;
}
interface AiModelRow {
  model: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  costUsd: number;
  calls: number;
}
interface TenantAiRow {
  tenant: { id: string; name: string; slug: string };
  usage: Record<string, { total: number; count: number; costUsd: number }>;
  aiByFeature: AiFeatureRow[];
  aiCostUsd: number;
  aiCachedPromptTokens?: number;
  aiPromptTokens?: number;
}

const TYPE_LABELS: Record<string, string> = {
  ai_tokens: "AI Tokens",
  message_sent: "Messages",
  tool_call: "Tool Calls",
  automation_run: "Automations",
};

const TYPE_COLORS: Record<string, string> = {
  ai_tokens: "bg-violet-500",
  message_sent: "bg-blue-500",
  tool_call: "bg-emerald-500",
  automation_run: "bg-amber-500",
};

const TYPE_BG: Record<string, string> = {
  ai_tokens: "bg-violet-50 text-violet-700 border-violet-200",
  message_sent: "bg-blue-50 text-blue-700 border-blue-200",
  tool_call: "bg-emerald-50 text-emerald-700 border-emerald-200",
  automation_run: "bg-amber-50 text-amber-700 border-amber-200",
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}
function formatCost(usd: number): string {
  if (!usd) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export default function SystemUsagePage() {
  const { token } = useAuth();
  const [period, setPeriod] = useState<Period>(30);
  const [stats, setStats] = useState<Record<string, { total: number; count: number; costUsd: number }>>({});
  const [aiTokens, setAiTokens] = useState<{
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    /** Subset of promptTokens that came from OpenAI's prefix cache (50% billing). */
    cachedPromptTokens?: number;
    costUsd: number;
    calls: number;
    byFeature: AiFeatureRow[];
    byModel: AiModelRow[];
  } | null>(null);
  const [totalEvents, setTotalEvents] = useState(0);
  const [byTenant, setByTenant] = useState<TenantAiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTenantId, setExpandedTenantId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [statsRes, tenantRes] = await Promise.all([
        getSystemUsageStats(token, period),
        getSystemUsageByTenant(token, period),
      ]);
      setStats(statsRes.data?.stats || {});
      setAiTokens(statsRes.data?.aiTokens || null);
      setTotalEvents(statsRes.data?.totalEvents || 0);
      setByTenant((tenantRes.data as TenantAiRow[]) || []);
    } catch (err) {
      console.error("System usage fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const aiTotalCost = aiTokens?.costUsd ?? 0;
  const aiTotalTokens = aiTokens?.totalTokens ?? 0;
  // Cache observability — driven by OpenAI's prompt_tokens_details.cached_tokens
  // captured per call in trackAIUsage. Hit % is cached / total prompt; savings
  // is the 50% billing discount applied to cached tokens (per AI_MODEL_PRICING).
  const aiPromptTokens = aiTokens?.promptTokens ?? 0;
  const aiCachedTokens = aiTokens?.cachedPromptTokens ?? 0;
  const aiCacheHitPct = aiPromptTokens > 0 ? (aiCachedTokens / aiPromptTokens) * 100 : 0;
  // Savings estimate: cached tokens were billed at 50% off, so saved = 0.5 *
  // (cached / 1M) * promptRate. We don't have per-call model on the aggregate,
  // so use the weighted blended rate from byModel (falls back to gpt-4o-mini).
  const blendedPromptUsdPerToken = aiTokens && aiTokens.byModel.length > 0
    ? aiTokens.byModel.reduce((acc, m) => {
        // Use cost / tokens as the observed per-token rate; ignores cached
        // discount already baked into costUsd so it's only an estimate.
        const obs = m.totalTokens > 0 ? m.costUsd / m.totalTokens : 0;
        return acc + obs;
      }, 0) / Math.max(1, aiTokens.byModel.length)
    : 0;
  const aiCachedSavingsUsd = aiCachedTokens * blendedPromptUsdPerToken * 0.5;

  // Max tenant total for bar sizing (falls back to 1 to avoid NaN)
  const maxTenantUsage = Math.max(1, ...byTenant.map((t) =>
    Object.values(t.usage).reduce((sum, u) => sum + u.total, 0)
  ));

  return (
    <SystemLayout>
      <div className="p-6 overflow-y-auto h-screen">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Platform Usage</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {totalEvents.toLocaleString()} total events &middot; {aiTokens ? `${formatNumber(aiTotalTokens)} AI tokens` : ""}
              {aiTotalCost > 0 && ` · est. ${formatCost(aiTotalCost)}`}
            </p>
          </div>
          <select
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value) as Period)}
            className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>All time</option>
          </select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Global Stat Cards — includes AI cost + cache hit observability.
                Cache Hit % surfaces whether the sessionId-pinned prefix cache
                is actually delivering savings. <20% on a workload that should
                be cacheable (autonomous agents, live copilot) signals broken
                prefix stability. */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
              <StatCard
                label="Est. AI Cost"
                value={formatCost(aiTotalCost)}
                sub={`${aiTokens?.calls || 0} calls`}
                highlight
              />
              <StatCard
                label="AI Tokens"
                value={formatNumber(aiTotalTokens)}
                sub={`${formatNumber(aiTokens?.promptTokens || 0)} in / ${formatNumber(aiTokens?.completionTokens || 0)} out`}
              />
              <StatCard
                label="Cache Hit"
                value={aiPromptTokens > 0 ? `${aiCacheHitPct.toFixed(1)}%` : "—"}
                sub={`${formatNumber(aiCachedTokens)} cached · saved ~${formatCost(aiCachedSavingsUsd)}`}
                accent={aiCacheHitPct >= 40 ? "green" : aiCacheHitPct >= 20 ? "amber" : aiPromptTokens > 0 ? "red" : undefined}
              />
              <StatCard
                label="Messages Sent"
                value={formatNumber(stats.message_sent?.total || 0)}
                sub={`${stats.message_sent?.count || 0} events`}
              />
              <StatCard
                label="Tool Calls"
                value={formatNumber(stats.tool_call?.total || 0)}
                sub={`${stats.tool_call?.count || 0} events`}
              />
              <StatCard
                label="Automations"
                value={formatNumber(stats.automation_run?.total || 0)}
                sub={`${stats.automation_run?.count || 0} events`}
              />
            </div>

            {/* AI Tokens by Feature */}
            {aiTokens && aiTokens.byFeature.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
                <h3 className="font-semibold text-gray-900 mb-4">AI Tokens by Feature</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase tracking-wider text-gray-400">
                        <th className="text-start py-2 px-3">Feature</th>
                        <th className="text-end py-2 px-3">Calls</th>
                        <th className="text-end py-2 px-3">Prompt</th>
                        <th className="text-end py-2 px-3" title="Subset of prompt tokens that hit OpenAI's prefix cache (billed 50% off)">Cached</th>
                        <th className="text-end py-2 px-3">Hit %</th>
                        <th className="text-end py-2 px-3">Completion</th>
                        <th className="text-end py-2 px-3">Total</th>
                        <th className="text-end py-2 px-3">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {aiTokens.byFeature
                        .sort((a, b) => b.totalTokens - a.totalTokens)
                        .map((row) => {
                          const cached = row.cachedPromptTokens ?? 0;
                          const hitPct = row.promptTokens > 0 ? (cached / row.promptTokens) * 100 : 0;
                          return (
                        <tr key={row.feature} className="hover:bg-gray-50/50">
                          <td className="py-2 px-3">
                            <span className="inline-flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-violet-400" />
                              <span className="font-medium text-gray-900">{row.feature}</span>
                            </span>
                          </td>
                          <td className="py-2 px-3 text-end text-gray-500 font-mono text-xs">{row.calls.toLocaleString()}</td>
                          <td className="py-2 px-3 text-end text-gray-500 font-mono text-xs">{formatNumber(row.promptTokens)}</td>
                          <td className="py-2 px-3 text-end text-gray-500 font-mono text-xs">{cached > 0 ? formatNumber(cached) : "—"}</td>
                          <td className={clsx(
                            "py-2 px-3 text-end font-mono text-xs font-semibold",
                            row.promptTokens === 0
                              ? "text-gray-300"
                              : hitPct >= 40
                                ? "text-emerald-600"
                                : hitPct >= 20
                                  ? "text-amber-600"
                                  : "text-rose-600",
                          )}>
                            {row.promptTokens > 0 ? `${hitPct.toFixed(0)}%` : "—"}
                          </td>
                          <td className="py-2 px-3 text-end text-gray-500 font-mono text-xs">{formatNumber(row.completionTokens)}</td>
                          <td className="py-2 px-3 text-end font-semibold text-gray-900 font-mono text-xs">{formatNumber(row.totalTokens)}</td>
                          <td className="py-2 px-3 text-end font-semibold text-green-600 font-mono text-xs">{formatCost(row.costUsd)}</td>
                        </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* AI Tokens by Model */}
            {aiTokens && aiTokens.byModel.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
                <h3 className="font-semibold text-gray-900 mb-4">AI Tokens by Model</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase tracking-wider text-gray-400">
                        <th className="text-start py-2 px-3">Model</th>
                        <th className="text-end py-2 px-3">Calls</th>
                        <th className="text-end py-2 px-3">Total Tokens</th>
                        <th className="text-end py-2 px-3" title="Subset of prompt tokens that hit OpenAI's prefix cache">Cached</th>
                        <th className="text-end py-2 px-3">Hit %</th>
                        <th className="text-end py-2 px-3">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {aiTokens.byModel
                        .sort((a, b) => b.costUsd - a.costUsd)
                        .map((row) => {
                          const cached = row.cachedPromptTokens ?? 0;
                          const hitPct = row.promptTokens > 0 ? (cached / row.promptTokens) * 100 : 0;
                          return (
                        <tr key={row.model} className="hover:bg-gray-50/50">
                          <td className="py-2 px-3 font-mono text-xs text-gray-700">{row.model}</td>
                          <td className="py-2 px-3 text-end text-gray-500 font-mono text-xs">{row.calls.toLocaleString()}</td>
                          <td className="py-2 px-3 text-end font-semibold text-gray-900 font-mono text-xs">{formatNumber(row.totalTokens)}</td>
                          <td className="py-2 px-3 text-end text-gray-500 font-mono text-xs">{cached > 0 ? formatNumber(cached) : "—"}</td>
                          <td className={clsx(
                            "py-2 px-3 text-end font-mono text-xs font-semibold",
                            row.promptTokens === 0
                              ? "text-gray-300"
                              : hitPct >= 40
                                ? "text-emerald-600"
                                : hitPct >= 20
                                  ? "text-amber-600"
                                  : "text-rose-600",
                          )}>
                            {row.promptTokens > 0 ? `${hitPct.toFixed(0)}%` : "—"}
                          </td>
                          <td className="py-2 px-3 text-end font-semibold text-green-600 font-mono text-xs">{formatCost(row.costUsd)}</td>
                        </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Usage by Tenant (click to expand feature breakdown) */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">Usage by Tenant</h3>
              {byTenant.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No usage data yet</p>
              ) : (
                <div className="space-y-3">
                  {byTenant.map((entry) => {
                    const tenantTotal = Object.values(entry.usage).reduce((sum, u) => sum + u.total, 0);
                    const isExpanded = expandedTenantId === entry.tenant.id;
                    return (
                      <div
                        key={entry.tenant.id}
                        className="p-4 rounded-xl border border-gray-100 hover:bg-gray-50/50 transition cursor-pointer"
                        onClick={() => setExpandedTenantId(isExpanded ? null : entry.tenant.id)}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-gradient-to-br from-violet-400 to-violet-600 rounded-lg flex items-center justify-center text-white font-bold text-xs">
                              {entry.tenant.name?.charAt(0)?.toUpperCase() || "?"}
                            </div>
                            <div>
                              <p className="font-medium text-sm text-gray-900">{entry.tenant.name}</p>
                              <p className="text-xs text-gray-400">{entry.tenant.slug}</p>
                            </div>
                          </div>
                          <div className="text-end">
                            <p className="text-sm font-semibold text-gray-700">{tenantTotal.toLocaleString()}</p>
                            <p className="text-xs text-green-600 font-semibold">{formatCost(entry.aiCostUsd)}</p>
                            {(entry.aiPromptTokens ?? 0) > 0 && (
                              <p
                                className={clsx(
                                  "text-[10px] font-mono font-semibold",
                                  (entry.aiCachedPromptTokens ?? 0) / (entry.aiPromptTokens ?? 1) >= 0.4
                                    ? "text-emerald-600"
                                    : (entry.aiCachedPromptTokens ?? 0) / (entry.aiPromptTokens ?? 1) >= 0.2
                                      ? "text-amber-600"
                                      : "text-rose-600",
                                )}
                                title={`${(entry.aiCachedPromptTokens ?? 0).toLocaleString()} cached / ${(entry.aiPromptTokens ?? 0).toLocaleString()} prompt`}
                              >
                                cache {(((entry.aiCachedPromptTokens ?? 0) / (entry.aiPromptTokens ?? 1)) * 100).toFixed(0)}%
                              </p>
                            )}
                          </div>
                        </div>
                        {/* Stacked bar */}
                        <div className="h-3 bg-gray-100 rounded-full overflow-hidden flex">
                          {Object.entries(entry.usage).map(([type, u]) => (
                            <div
                              key={type}
                              className={clsx("h-full transition-all", TYPE_COLORS[type] || "bg-gray-300")}
                              style={{ width: `${(u.total / maxTenantUsage) * 100}%` }}
                              title={`${TYPE_LABELS[type] || type}: ${u.total.toLocaleString()}`}
                            />
                          ))}
                        </div>
                        {/* Breakdown badges */}
                        <div className="flex flex-wrap gap-2 mt-2">
                          {Object.entries(entry.usage).map(([type, u]) => (
                            <span key={type} className={clsx("text-[10px] px-2 py-0.5 rounded-full border font-medium", TYPE_BG[type] || "bg-gray-50 text-gray-500 border-gray-200")}>
                              {TYPE_LABELS[type] || type}: {u.total.toLocaleString()}
                            </span>
                          ))}
                        </div>

                        {/* Expanded: AI-by-feature for this tenant */}
                        {isExpanded && entry.aiByFeature.length > 0 && (
                          <div className="mt-4 pt-4 border-t border-gray-100">
                            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">AI Tokens by Feature</p>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-[10px] uppercase tracking-wider text-gray-400">
                                  <th className="text-start py-1">Feature</th>
                                  <th className="text-end py-1">Calls</th>
                                  <th className="text-end py-1">Tokens</th>
                                  <th className="text-end py-1">Cost</th>
                                </tr>
                              </thead>
                              <tbody>
                                {entry.aiByFeature
                                  .sort((a, b) => b.totalTokens - a.totalTokens)
                                  .map((row) => (
                                    <tr key={row.feature}>
                                      <td className="py-1 text-gray-700 font-medium">{row.feature}</td>
                                      <td className="py-1 text-end font-mono text-gray-500">{row.calls.toLocaleString()}</td>
                                      <td className="py-1 text-end font-mono text-gray-900">{formatNumber(row.totalTokens)}</td>
                                      <td className="py-1 text-end font-mono text-green-600">{formatCost(row.costUsd)}</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 px-2">
              {Object.entries(TYPE_COLORS).map(([type, color]) => (
                <div key={type} className="flex items-center gap-1.5">
                  <div className={clsx("w-2.5 h-2.5 rounded-full", color)} />
                  <span className="text-xs text-gray-500">{TYPE_LABELS[type]}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </SystemLayout>
  );
}

function StatCard({
  label,
  value,
  sub,
  highlight,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  /** Color-coded accent for at-a-glance health (cache hit, etc). */
  accent?: "green" | "amber" | "red";
}) {
  // `accent` styles are mutually exclusive with `highlight`; if both are set,
  // accent wins so signal-driven cards (Cache Hit) override the static green
  // treatment used for cost.
  const accentCls = accent === "green"
    ? "bg-emerald-50 border-emerald-200 text-emerald-700"
    : accent === "amber"
      ? "bg-amber-50 border-amber-200 text-amber-700"
      : accent === "red"
        ? "bg-rose-50 border-rose-200 text-rose-700"
        : null;
  return (
    <div className={clsx(
      "rounded-2xl border p-5",
      accentCls ?? (highlight ? "bg-green-50 border-green-200" : "bg-white border-gray-200"),
    )}>
      <p className={clsx(
        "text-xs font-medium uppercase tracking-wider",
        accent ? accentCls?.split(" ")[2] : highlight ? "text-green-600" : "text-gray-500",
      )}>{label}</p>
      <p className={clsx(
        "text-2xl font-bold mt-1",
        accent === "green" ? "text-emerald-700"
          : accent === "amber" ? "text-amber-700"
          : accent === "red" ? "text-rose-700"
          : highlight ? "text-green-700" : "text-gray-900",
      )}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
