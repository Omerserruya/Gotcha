"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { getTokenUsage, getTokenUsageByTenants } from "@/lib/api";
import { SystemLayout } from "@/components/SystemLayout";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import clsx from "clsx";

type Period = "7d" | "30d" | "90d";

interface TenantRow {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  count: number;
}

function getDateRange(period: Period): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  if (period === "7d") from.setDate(from.getDate() - 7);
  else if (period === "30d") from.setDate(from.getDate() - 30);
  else from.setDate(from.getDate() - 90);
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

// OpenAI pricing per 1M tokens (USD)
const MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o-mini":              { prompt: 0.15,  completion: 0.60  },
  "gpt-4o":                   { prompt: 2.50,  completion: 10.00 },
  "gpt-4-turbo":              { prompt: 10.00, completion: 30.00 },
  "gpt-3.5-turbo":            { prompt: 0.50,  completion: 1.50  },
  "text-embedding-3-small":   { prompt: 0.02,  completion: 0     },
  "text-embedding-3-large":   { prompt: 0.13,  completion: 0     },
};
const DEFAULT_PRICING = { prompt: 0.15, completion: 0.60 }; // fallback to gpt-4o-mini rates

function estimateCost(promptTokens: number, completionTokens: number, model?: string): number {
  const pricing = (model && MODEL_PRICING[model]) || DEFAULT_PRICING;
  return (promptTokens / 1_000_000) * pricing.prompt + (completionTokens / 1_000_000) * pricing.completion;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

export default function TokenUsagePage() {
  const { token } = useAuth();
  const [period, setPeriod] = useState<Period>("30d");
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [totals, setTotals] = useState({ promptTokens: 0, completionTokens: 0, totalTokens: 0, count: 0 });
  const [byType, setByType] = useState<any[]>([]);
  const [byModel, setByModel] = useState<any[]>([]);
  const [dailyData, setDailyData] = useState<any[]>([]);
  const [tenantData, setTenantData] = useState<TenantRow[]>([]);
  const [allTotals, setAllTotals] = useState({ promptTokens: 0, completionTokens: 0, totalTokens: 0, count: 0 });
  const [totalCost, setTotalCost] = useState(0);

  const selectedTenant = tenantData.find((t) => t.tenantId === selectedTenantId) || null;

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const range = getDateRange(period);
      const params: Record<string, string> = { ...range };
      if (selectedTenantId) params.tenantId = selectedTenantId;

      const [totalsRes, typeRes, modelRes, dailyRes, tenantsRes] = await Promise.all([
        getTokenUsage(token, params),
        getTokenUsage(token, { ...params, groupBy: "type" }),
        getTokenUsage(token, { ...params, groupBy: "model" }),
        getTokenUsage(token, { ...params, groupBy: "day" }),
        getTokenUsageByTenants(token, range),
      ]);

      setTotals(totalsRes.totals);
      setByType(typeRes.breakdown);
      setByModel(modelRes.breakdown);

      // Compute cost from per-model breakdown
      const cost = (modelRes.breakdown as any[]).reduce((sum, row) => {
        return sum + estimateCost(
          row._sum?.promptTokens || 0,
          row._sum?.completionTokens || 0,
          row.model,
        );
      }, 0);
      setTotalCost(cost);

      const daily = (dailyRes.breakdown as any[])
        .map((row) => ({
          date: new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          rawDate: row.date,
          prompt: row.promptTokens || 0,
          completion: row.completionTokens || 0,
          total: row.totalTokens || 0,
          calls: row.count || 0,
        }))
        .reverse();
      setDailyData(daily);

      const sorted = tenantsRes.data.sort((a: any, b: any) => (b.totalTokens || 0) - (a.totalTokens || 0));
      setTenantData(sorted);

      // Store global totals (sum of all tenants)
      if (!selectedTenantId) {
        setAllTotals(totalsRes.totals);
      }
    } catch (err) {
      console.error("Failed to load token usage:", err);
    } finally {
      setLoading(false);
    }
  }, [token, period, selectedTenantId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleTenantClick = (tenantId: string) => {
    setSelectedTenantId(selectedTenantId === tenantId ? null : tenantId);
  };

  return (
    <SystemLayout>
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Token Usage</h1>
            <p className="text-sm text-gray-500 mt-1">
              AI token consumption
              {selectedTenant ? ` — ${selectedTenant.tenantName}` : " across all tenants"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Tenant filter */}
            {tenantData.length > 1 && (
              <select
                value={selectedTenantId || ""}
                onChange={(e) => setSelectedTenantId(e.target.value || null)}
                className="text-xs border border-gray-200 rounded-xl px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400"
              >
                <option value="">All Tenants</option>
                {tenantData.map((t) => (
                  <option key={t.tenantId} value={t.tenantId}>
                    {t.tenantName}
                  </option>
                ))}
              </select>
            )}
            {/* Period selector */}
            <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
              {(["7d", "30d", "90d"] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={clsx(
                    "text-xs font-medium px-3 py-1.5 rounded-lg transition",
                    period === p
                      ? "bg-white text-orange-600 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "90 Days"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Active filter pill */}
        {selectedTenant && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-2 text-sm bg-orange-50 text-orange-700 rounded-full px-4 py-1.5 border border-orange-200">
              <span className="font-medium">{selectedTenant.tenantName}</span>
              <button
                onClick={() => setSelectedTenantId(null)}
                className="hover:text-orange-900 transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              <SummaryCard label="Est. Cost" value={formatCost(totalCost)} highlight />
              <SummaryCard label="Total Tokens" value={formatNumber(totals.totalTokens)} />
              <SummaryCard label="Prompt Tokens" value={formatNumber(totals.promptTokens)} />
              <SummaryCard label="Completion Tokens" value={formatNumber(totals.completionTokens)} />
              <SummaryCard label="API Calls" value={formatNumber(totals.count)} />
            </div>

            {/* Usage by Type */}
            {byType.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <h2 className="font-semibold text-gray-900 mb-4">Usage by Type</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {byType.map((row: any) => (
                    <div key={row.type} className="bg-gray-50 rounded-xl p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{row.type}</p>
                      <p className="text-lg font-bold text-gray-900 mt-1">{formatNumber(row._sum?.totalTokens || 0)}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">{(row._count?.id || 0).toLocaleString()} calls</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Daily Chart */}
            {dailyData.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <h2 className="font-semibold text-gray-900 mb-4">Daily Token Usage</h2>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dailyData} barCategoryGap="20%">
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                        tickLine={false}
                        axisLine={{ stroke: "#e5e7eb" }}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={formatNumber}
                      />
                      <Tooltip
                        contentStyle={{
                          borderRadius: "12px",
                          border: "1px solid #e5e7eb",
                          boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                          fontSize: "12px",
                        }}
                        formatter={(value: number, name: string) => [
                          value.toLocaleString(),
                          name === "prompt" ? "Prompt Tokens" : "Completion Tokens",
                        ]}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: "12px" }}
                        formatter={(value: string) =>
                          value === "prompt" ? "Prompt Tokens" : "Completion Tokens"
                        }
                      />
                      <Bar dataKey="prompt" stackId="tokens" fill="#fb923c" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="completion" stackId="tokens" fill="#fdba74" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Per-Tenant Table */}
            {tenantData.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-gray-900">Usage by Tenant</h2>
                  {selectedTenantId && (
                    <button
                      onClick={() => setSelectedTenantId(null)}
                      className="text-xs text-orange-500 hover:text-orange-600 font-medium"
                    >
                      Show All
                    </button>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-start py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                        <th className="text-end py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">Prompt</th>
                        <th className="text-end py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">Completion</th>
                        <th className="text-end py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                        <th className="text-end py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">Est. Cost</th>
                        <th className="text-end py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">Calls</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {tenantData.map((row) => {
                        const globalTotal = allTotals.totalTokens || totals.totalTokens;
                        const pct = globalTotal > 0
                          ? Math.round((row.totalTokens / globalTotal) * 100)
                          : 0;
                        const isSelected = row.tenantId === selectedTenantId;
                        return (
                          <tr
                            key={row.tenantId}
                            onClick={() => handleTenantClick(row.tenantId)}
                            className={clsx(
                              "cursor-pointer transition",
                              isSelected
                                ? "bg-orange-50 hover:bg-orange-100/70"
                                : "hover:bg-gray-50"
                            )}
                          >
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-3">
                                <div className="flex-1 min-w-0">
                                  <p className={clsx("font-medium truncate", isSelected ? "text-orange-700" : "text-gray-900")}>{row.tenantName}</p>
                                  <p className="text-xs text-gray-400 truncate">{row.tenantSlug}</p>
                                </div>
                                <span className={clsx(
                                  "text-[10px] font-medium rounded-full px-2 py-0.5 shrink-0",
                                  isSelected ? "text-orange-600 bg-orange-100" : "text-orange-500 bg-orange-50"
                                )}>
                                  {pct}%
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-4 text-end text-gray-600 font-mono text-xs">{formatNumber(row.promptTokens)}</td>
                            <td className="py-3 px-4 text-end text-gray-600 font-mono text-xs">{formatNumber(row.completionTokens)}</td>
                            <td className="py-3 px-4 text-end font-medium text-gray-900 font-mono text-xs">{formatNumber(row.totalTokens)}</td>
                            <td className="py-3 px-4 text-end font-medium text-green-600 font-mono text-xs">{formatCost(estimateCost(row.promptTokens, row.completionTokens))}</td>
                            <td className="py-3 px-4 text-end text-gray-600 font-mono text-xs">{row.count.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {tenantData.length > 1 && !selectedTenantId && (
                      <tfoot>
                        <tr className="border-t border-gray-200 bg-gray-50/50">
                          <td className="py-3 px-4 font-semibold text-gray-900">Total</td>
                          <td className="py-3 px-4 text-end font-medium text-gray-900 font-mono text-xs">{formatNumber(totals.promptTokens)}</td>
                          <td className="py-3 px-4 text-end font-medium text-gray-900 font-mono text-xs">{formatNumber(totals.completionTokens)}</td>
                          <td className="py-3 px-4 text-end font-bold text-gray-900 font-mono text-xs">{formatNumber(totals.totalTokens)}</td>
                          <td className="py-3 px-4 text-end font-bold text-green-600 font-mono text-xs">{formatCost(totalCost)}</td>
                          <td className="py-3 px-4 text-end font-medium text-gray-900 font-mono text-xs">{totals.count.toLocaleString()}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            )}

            {/* Empty state */}
            {totals.totalTokens === 0 && !selectedTenantId && (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
                <div className="w-16 h-16 mx-auto mb-4 bg-orange-100 rounded-2xl flex items-center justify-center">
                  <svg className="w-8 h-8 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">No Token Usage Yet</h3>
                <p className="text-sm text-gray-500 max-w-md mx-auto">
                  Token usage data will appear here once AI features are used — chat, suggestions, embeddings, and more.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </SystemLayout>
  );
}

function SummaryCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={clsx(
      "rounded-2xl border p-5",
      highlight ? "bg-green-50 border-green-200" : "bg-white border-gray-200"
    )}>
      <p className={clsx("text-xs font-medium uppercase tracking-wider", highlight ? "text-green-600" : "text-gray-500")}>{label}</p>
      <p className={clsx("text-2xl font-bold mt-1", highlight ? "text-green-700" : "text-gray-900")}>{value}</p>
    </div>
  );
}
