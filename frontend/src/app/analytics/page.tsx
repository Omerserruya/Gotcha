"use client";

import { useState, useEffect } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import clsx from "clsx";
import {
  getAnalyticsOverview,
  getAIPerformance,
  getTopQuestions,
  getToolUsageStats,
  getChannelPerformance,
  getDepartmentPerformance,
  getAIInsights,
  getAgentStats,
  getDailyVolume,
} from "@/lib/api";

// Every number on this page comes from /api/analytics/* - no demo data.
// A fresh tenant sees honest zeros/empty states, never fabricated metrics.

const CHANNEL_COLORS: Record<string, string> = {
  WHATSAPP: "#25D366",
  MESSENGER: "#0084FF",
  INSTAGRAM: "#E4405F",
  GMAIL: "#EA4335",
  EMAIL: "#EA4335",
  SLACK: "#4A154B",
  OUTLOOK: "#0078D4",
  WEB: "#7c5cfc",
};
const FALLBACK_COLORS = ["#7c5cfc", "#22c55e", "#f59e0b", "#3b82f6", "#ef4444", "#14b8a6"];

const RANGE_DAYS: Record<string, number> = { today: 1, "7days": 7, "30days": 30, "90days": 90 };

function rangeParams(range: string): Record<string, string> {
  const days = RANGE_DAYS[range] ?? 30;
  const to = new Date();
  const from = new Date(Date.now() - days * 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "-";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function DeltaBadge({ value }: { value: number | null | undefined }) {
  if (value == null) return null;
  const isPositive = value > 0;
  return (
    <span className={clsx(
      "inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
      isPositive ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"
    )}>
      <svg className="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
        {isPositive
          ? <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
          : <path fillRule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clipRule="evenodd" />
        }
      </svg>
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-400 py-6 text-center">{children}</p>;
}

export default function AnalyticsPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [dateRange, setDateRange] = useState("30days");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<any>(null);
  const [aiPerf, setAiPerf] = useState<any>(null);
  const [topQuestions, setTopQuestions] = useState<any[]>([]);
  const [toolUsage, setToolUsage] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [daily, setDaily] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = rangeParams(dateRange);
    const days = RANGE_DAYS[dateRange] ?? 30;
    Promise.allSettled([
      getAnalyticsOverview(token, params),
      getAIPerformance(token, params),
      getTopQuestions(token, params),
      getToolUsageStats(token, params),
      getChannelPerformance(token, params),
      getDepartmentPerformance(token, params),
      getAIInsights(token),
      getAgentStats(token),
      getDailyVolume(token, Math.min(days, 30)),
    ]).then((results) => {
      if (cancelled) return;
      const [ov, ai, tq, tu, ch, dp, ins, ag, dv] = results;
      if (ov.status === "fulfilled") setOverview(ov.value.data); else setError("analytics_unavailable");
      if (ai.status === "fulfilled") setAiPerf(ai.value.data);
      if (tq.status === "fulfilled") setTopQuestions(tq.value.data ?? []);
      if (tu.status === "fulfilled") setToolUsage(tu.value.data ?? []);
      if (ch.status === "fulfilled") setChannels(ch.value.data ?? []);
      if (dp.status === "fulfilled") setDepartments(dp.value.data ?? []);
      if (ins.status === "fulfilled") setInsights(Array.isArray(ins.value.data) ? ins.value.data : []);
      if (ag.status === "fulfilled") setAgents(ag.value.data ?? []);
      if (dv.status === "fulfilled") setDaily(dv.value.data ?? []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [token, dateRange]);

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  const approvals = aiPerf?.approvals;
  const trendData = daily.map((d: any) => ({
    date: new Date(d.date ?? d.day ?? Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    inbound: d.inbound ?? 0,
    outbound: d.outbound ?? 0,
  }));
  const channelData = channels.map((c: any, i: number) => ({
    channel: c.channel,
    conversations: c.conversationCount ?? 0,
    color: CHANNEL_COLORS[String(c.channel).toUpperCase()] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length],
  })).filter((c: any) => c.conversations > 0);
  const maxQuestionCount = topQuestions.length ? Math.max(...topQuestions.map((q: any) => q.count ?? 0)) : 0;
  const maxToolUsage = toolUsage.length ? Math.max(...toolUsage.map((u: any) => u.executionCount ?? 0)) : 0;

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen space-y-4 md:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("analytics.title")}</h1>
            <p className="text-xs text-gray-400 mt-0.5">{t("analytics.subtitle")}</p>
          </div>
          <div className="flex bg-gray-100 rounded-xl p-1 gap-0.5">
            {(["today", "7days", "30days", "90days"] as const).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={clsx(
                  "px-3 py-1.5 rounded-lg text-xs font-medium transition",
                  dateRange === range ? "bg-white text-primary-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                )}
              >
                {t(`analytics.dateRange.${range}`)}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
            {t("analytics.partialData")}
          </div>
        )}

        {/* KPI Overview - real numbers only */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 md:gap-3">
          <KpiCard label={t("analytics.overview.totalConversations")} value={(overview?.totalConversations ?? 0).toLocaleString()} delta={overview?.deltas?.totalConversationsPct} icon="chat" />
          <KpiCard label={t("analytics.overview.resolutionRate")} value={`${overview?.resolutionRate ?? 0}%`} delta={overview?.deltas?.resolvedConversationsPct} icon="check" />
          <KpiCard label={t("analytics.overview.avgResponseTime")} value={formatMs(overview?.avgResponseTimeMs)} delta={null} icon="bolt" />
          <KpiCard label={t("analytics.overview.avgResolutionTime")} value={formatMs(overview?.avgResolutionTimeMs)} delta={null} icon="timer" />
          <KpiCard label={t("analytics.overview.aiHandledShare")} value={`${overview?.aiHandledPct ?? 0}%`} delta={null} icon="sparkle" />
          <KpiCard label={t("analytics.overview.approvalRate")} value={approvals?.approvalRate != null ? `${approvals.approvalRate}%` : "-"} delta={null} icon="sparkle" />
        </div>

        {/* Message volume trend (real daily volumes) */}
        <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-1">{t("analytics.trend.title")}</h3>
          <p className="text-xs text-gray-400 mb-4">{t("analytics.trend.subtitle")}</p>
          {trendData.length === 0 ? (
            <EmptyNote>{t("analytics.noDataYet")}</EmptyNote>
          ) : (
            <div className="h-[200px] md:h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trendData} barGap={0}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0", fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="inbound" fill="#7c5cfc" name={t("analytics.trend.inbound")} radius={[4, 4, 0, 0]} stackId="a" />
                  <Bar dataKey="outbound" fill="#c4b5fd" name={t("analytics.trend.outbound")} radius={[4, 4, 0, 0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* AI vs Human Performance */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          {/* AI Performance - governance metrics included */}
          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <h3 className="font-bold text-gray-900">{t("analytics.aiPerformance.title")}</h3>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="bg-violet-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-violet-600">{aiPerf?.totalAIMessages ?? 0}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{t("analytics.aiPerformance.aiMessages")}</p>
              </div>
              <div className="bg-violet-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-violet-600">{aiPerf?.aiResolutionRate ?? 0}%</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{t("analytics.aiPerformance.resolved")}</p>
              </div>
              <div className="bg-violet-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-violet-600">{aiPerf?.escalationRate ?? 0}%</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{t("analytics.aiPerformance.escalated")}</p>
              </div>
            </div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">{t("analytics.aiPerformance.governance")}</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-700">{approvals?.approvalRate != null ? `${approvals.approvalRate}%` : "-"}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{t("analytics.aiPerformance.approvalRate")}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-700">{approvals?.overrideRate != null ? `${approvals.overrideRate}%` : "-"}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{t("analytics.aiPerformance.overrideRate")}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-700">{approvals?.pending ?? 0}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{t("analytics.aiPerformance.pendingApprovals")}</p>
              </div>
            </div>
            {approvals?.avgDecisionMinutes != null && (
              <p className="text-[10px] text-gray-400 mt-2">{t("analytics.aiPerformance.avgDecision", { minutes: String(approvals.avgDecisionMinutes) })}</p>
            )}
          </div>

          {/* Human Performance - real agent stats */}
          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-primary-400 to-primary-600 rounded-xl flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
              </div>
              <h3 className="font-bold text-gray-900">{t("analytics.humanPerformance.title")}</h3>
            </div>
            {agents.length === 0 ? (
              <EmptyNote>{t("analytics.noAgentsYet")}</EmptyNote>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-start py-1.5 text-gray-400 font-medium">{t("analytics.humanPerformance.agent")}</th>
                    <th className="text-end py-1.5 text-gray-400 font-medium">{t("analytics.humanPerformance.active")}</th>
                    <th className="text-end py-1.5 text-gray-400 font-medium">{t("analytics.humanPerformance.claimedToday")}</th>
                    <th className="text-end py-1.5 text-gray-400 font-medium">{t("analytics.humanPerformance.avgResponse")}</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.slice(0, 8).map((agent: any) => (
                    <tr key={agent.agentId ?? agent.name} className="border-b border-gray-50">
                      <td className="py-2 text-gray-700 font-medium">{agent.name}</td>
                      <td className="py-2 text-end text-gray-500">{agent.activeConversations ?? 0}</td>
                      <td className="py-2 text-end text-gray-500">{agent.claimedToday ?? 0}</td>
                      <td className="py-2 text-end text-gray-500">{formatMs(agent.avgResponseTimeMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Top Questions */}
        <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-1">{t("analytics.topQuestions.title")}</h3>
          <p className="text-xs text-gray-400 mb-4">{t("analytics.topQuestions.subtitle")}</p>
          {topQuestions.length === 0 ? (
            <EmptyNote>{t("analytics.noDataYet")}</EmptyNote>
          ) : (
            <div className="space-y-2">
              {topQuestions.map((q: any, i: number) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-gray-50/50 rounded-xl hover:bg-gray-50 transition">
                  <div className="w-8 h-8 bg-primary-50 rounded-lg flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-primary-500">#{i + 1}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{q.question}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-gray-400">{t("analytics.topQuestions.times", { count: String(q.count ?? 0) })}</span>
                    </div>
                  </div>
                  {q.automatable && (
                    <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg bg-amber-50 text-amber-600 ring-1 ring-amber-200">
                      {t("analytics.topQuestions.automate")}
                    </span>
                  )}
                  <div className="hidden sm:block w-24">
                    <div className="bg-gray-200 rounded-full h-1.5">
                      <div className="bg-gradient-to-r from-primary-400 to-violet-500 h-1.5 rounded-full" style={{ width: `${maxQuestionCount ? ((q.count ?? 0) / maxQuestionCount) * 100 : 0}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tool Usage + Channel Performance */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-1">{t("analytics.toolUsage.title")}</h3>
            <p className="text-xs text-gray-400 mb-4">{t("analytics.toolUsage.subtitle")}</p>
            {toolUsage.length === 0 ? (
              <EmptyNote>{t("analytics.noToolUsageYet")}</EmptyNote>
            ) : (
              <div className="space-y-3">
                {toolUsage.slice(0, 8).map((tool: any) => (
                  <div key={tool.toolId ?? tool.toolName} className="flex items-center gap-3">
                    <div className="w-7 h-7 bg-violet-50 rounded-lg flex items-center justify-center shrink-0">
                      <svg className="w-3.5 h-3.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.19A1.5 1.5 0 015.276 9.5h13.448a1.5 1.5 0 01.76 2.48l-5.384 3.19a1.5 1.5 0 01-1.52 0z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-700 truncate">{tool.toolName ?? tool.toolId}</span>
                        <span className="text-[10px] text-gray-400">{t("analytics.toolUsage.uses", { count: String(tool.executionCount ?? 0) })}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                          <div className="bg-gradient-to-r from-violet-400 to-purple-500 h-1.5 rounded-full" style={{ width: `${maxToolUsage ? ((tool.executionCount ?? 0) / maxToolUsage) * 100 : 0}%` }} />
                        </div>
                        <span className={clsx("text-[10px] font-medium px-1.5 py-0.5 rounded-full", (tool.successRate ?? 0) >= 95 ? "bg-green-50 text-green-600" : "bg-amber-50 text-amber-600")}>
                          {tool.successRate ?? 0}%
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-1">{t("analytics.channelPerformance.title")}</h3>
            <p className="text-xs text-gray-400 mb-4">{t("analytics.channelPerformance.subtitle")}</p>
            {channelData.length === 0 ? (
              <EmptyNote>{t("analytics.noDataYet")}</EmptyNote>
            ) : (
              <>
                <div className="h-[200px] mb-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={channelData} dataKey="conversations" nameKey="channel" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} strokeWidth={0}>
                        {channelData.map((entry: any, i: number) => (<Cell key={i} fill={entry.color} />))}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0", fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {channelData.map((ch: any) => (
                    <div key={ch.channel} className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ch.color }} />
                      <span className="text-[11px] text-gray-600 truncate">{ch.channel}</span>
                      <span className="text-[10px] text-gray-400 ml-auto">{ch.conversations}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Department Performance */}
        <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-3">{t("analytics.departmentPerformance.title")}</h3>
          {departments.length === 0 ? (
            <EmptyNote>{t("analytics.noDataYet")}</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[500px]">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-start py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">{t("analytics.departmentPerformance.department")}</th>
                    <th className="text-end py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">{t("analytics.departmentPerformance.conversations")}</th>
                    <th className="text-end py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">{t("analytics.departmentPerformance.agents")}</th>
                    <th className="text-end py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">{t("analytics.departmentPerformance.resolution")}</th>
                  </tr>
                </thead>
                <tbody>
                  {departments.map((dept: any) => (
                    <tr key={dept.departmentId} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                      <td className="py-2.5 px-3 font-medium text-gray-900">{dept.departmentName}</td>
                      <td className="py-2.5 px-3 text-end text-gray-600">{dept.conversationCount ?? 0}</td>
                      <td className="py-2.5 px-3 text-end text-gray-600">{dept.agentCount ?? 0}</td>
                      <td className="py-2.5 px-3 text-end">
                        <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", (dept.resolutionRate ?? 0) >= 90 ? "bg-green-50 text-green-600" : (dept.resolutionRate ?? 0) >= 80 ? "bg-amber-50 text-amber-600" : "bg-red-50 text-red-500")}>
                          {dept.resolutionRate ?? 0}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* AI Insights (generated from real data by the analytics service) */}
        <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-gradient-to-br from-amber-400 to-orange-500 rounded-xl flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-gray-900">{t("analytics.insights.title")}</h3>
              <p className="text-xs text-gray-400">{t("analytics.insights.subtitle")}</p>
            </div>
          </div>
          {insights.length === 0 ? (
            <EmptyNote>{t("analytics.noInsightsYet")}</EmptyNote>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {insights.map((insight: any) => (
                <div key={insight.id} className={clsx("rounded-xl p-4 border transition hover:shadow-subtle", insight.impact === "high" ? "border-amber-200 bg-amber-50/30" : "border-gray-200 bg-gray-50/30")}>
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="text-sm font-semibold text-gray-900">{insight.title}</h4>
                    {insight.impact === "high" && <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full uppercase">{t("analytics.insights.highImpact")}</span>}
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">{insight.description}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="h-20 md:h-4" />
      </div>
    </AppLayout>
  );
}

function KpiCard({ label, value, delta, icon }: { label: string; value: string; delta: number | null | undefined; icon: string }) {
  return (
    <div className="bg-white rounded-2xl p-3 md:p-4 shadow-card border border-gray-100 hover:shadow-float transition-shadow">
      <div className="flex items-center justify-between mb-2">
        <div className={clsx("w-7 h-7 rounded-lg flex items-center justify-center", icon === "sparkle" ? "bg-violet-100" : "bg-primary-50")}>
          <svg className={clsx("w-3.5 h-3.5", icon === "sparkle" ? "text-violet-500" : "text-primary-500")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {icon === "chat" && <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />}
            {icon === "check" && <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />}
            {icon === "bolt" && <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />}
            {icon === "timer" && <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />}
            {icon === "sparkle" && <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />}
          </svg>
        </div>
        <DeltaBadge value={delta} />
      </div>
      <p className="text-lg md:text-xl font-bold text-gray-900">{value}</p>
      <p className="text-[10px] text-gray-400 mt-0.5 leading-tight line-clamp-2">{label}</p>
    </div>
  );
}
