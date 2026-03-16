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

// ─── Demo Data ──────────────────────────────────────────────

const DEMO_OVERVIEW = {
  totalConversations: 1284, totalConversationsDelta: 12.3,
  resolutionRate: 87.4, resolutionRateDelta: 3.2,
  avgResponseTime: 42000, avgResponseTimeDelta: -8.1,
  avgResolutionTime: 384000, avgResolutionTimeDelta: -5.4,
  customerSatisfaction: 4.6, customerSatisfactionDelta: 0.3,
  aiResolutionRate: 34.2, aiResolutionRateDelta: 7.8,
};

const DEMO_AI_PERFORMANCE = {
  conversationsHandled: 439, avgResolutionTime: 128000, escalationRate: 18.3,
  topCategories: [
    { name: "Order Status", count: 142, pct: 32 },
    { name: "FAQ / General", count: 98, pct: 22 },
    { name: "Pricing Questions", count: 87, pct: 20 },
    { name: "Account Help", count: 64, pct: 15 },
    { name: "Shipping Info", count: 48, pct: 11 },
  ],
};

const DEMO_HUMAN_PERFORMANCE = {
  conversationsHandled: 845, avgResolutionTime: 512000, satisfactionScore: 4.7,
  topAgents: [
    { name: "Sarah Cohen", conversations: 186, avgTime: 380000, satisfaction: 4.9 },
    { name: "David Levi", conversations: 164, avgTime: 420000, satisfaction: 4.8 },
    { name: "Maya Ben-Ari", conversations: 152, avgTime: 490000, satisfaction: 4.7 },
    { name: "Amit Shamir", conversations: 178, avgTime: 560000, satisfaction: 4.5 },
    { name: "Noa Peretz", conversations: 165, avgTime: 510000, satisfaction: 4.6 },
  ],
};

const DEMO_TOP_QUESTIONS = [
  { question: "Where is my order?", count: 312, category: "Orders", canAutomate: true, aiHandled: 78 },
  { question: "How do I get a refund?", count: 198, category: "Returns", canAutomate: true, aiHandled: 45 },
  { question: "What are your pricing plans?", count: 156, category: "Sales", canAutomate: true, aiHandled: 89 },
  { question: "My account is locked", count: 134, category: "Account", canAutomate: false, aiHandled: 12 },
  { question: "How to reset password?", count: 121, category: "Account", canAutomate: true, aiHandled: 95 },
  { question: "Shipping timeframes", count: 98, category: "Shipping", canAutomate: true, aiHandled: 82 },
  { question: "Product compatibility", count: 87, category: "Technical", canAutomate: false, aiHandled: 34 },
  { question: "Cancel subscription", count: 76, category: "Billing", canAutomate: true, aiHandled: 56 },
];

const DEMO_TOOL_USAGE = [
  { tool: "Knowledge Base Search", usage: 892, successRate: 94 },
  { tool: "Customer Lookup", usage: 634, successRate: 99 },
  { tool: "Order Status", usage: 456, successRate: 97 },
  { tool: "Conversation History", usage: 389, successRate: 100 },
  { tool: "Refund Processing", usage: 123, successRate: 91 },
];

const DEMO_CHANNEL_DATA = [
  { channel: "WhatsApp", conversations: 487, color: "#25D366" },
  { channel: "Messenger", conversations: 312, color: "#0084FF" },
  { channel: "Instagram", conversations: 198, color: "#E4405F" },
  { channel: "Gmail", conversations: 156, color: "#EA4335" },
  { channel: "Slack", conversations: 89, color: "#4A154B" },
  { channel: "Outlook", conversations: 42, color: "#0078D4" },
];

const DEMO_DEPARTMENT_DATA = [
  { department: "Customer Support", conversations: 542, responseTime: 38000, resolutionRate: 91, slaCompliance: 94 },
  { department: "Sales", conversations: 328, responseTime: 45000, resolutionRate: 85, slaCompliance: 89 },
  { department: "Billing", conversations: 214, responseTime: 52000, resolutionRate: 88, slaCompliance: 92 },
  { department: "Technical Support", conversations: 156, responseTime: 68000, resolutionRate: 82, slaCompliance: 86 },
  { department: "Operations", conversations: 44, responseTime: 95000, resolutionRate: 79, slaCompliance: 78 },
];

const DEMO_INSIGHTS = [
  { id: "1", title: "Order tracking queries are surging", description: "\"Where is my order?\" has been asked 312 times this period — 78% handled by AI. Creating an automated flow could reduce agent load by ~15%.", type: "automation", impact: "high", metric: "312 queries/period" },
  { id: "2", title: "Refund flow can be partially automated", description: "198 refund requests this period. 45% handled by AI. Adding a Shopify refund tool could automate simple refunds under $50.", type: "integration", impact: "high", metric: "198 requests/period" },
  { id: "3", title: "Password reset is fully automatable", description: "121 password reset requests — 95% already handled by AI. Converting to a self-service flow would eliminate agent involvement entirely.", type: "automation", impact: "medium", metric: "121 requests/period" },
  { id: "4", title: "Instagram response time below target", description: "Average response time on WhatsApp is 35s, well within SLA. But Instagram DMs average 55s — consider prioritizing Instagram queue.", type: "optimization", impact: "medium", metric: "55s avg on Instagram" },
];

const DEMO_TREND_DATA = Array.from({ length: 14 }, (_, i) => ({
  date: new Date(Date.now() - (13 - i) * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  aiHandled: Math.floor(20 + Math.random() * 15 + i * 1.5),
  humanHandled: Math.floor(40 + Math.random() * 25 + i * 0.5),
}));

function formatMs(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function DeltaBadge({ value }: { value: number }) {
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

export default function AnalyticsPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [dateRange, setDateRange] = useState("30days");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => setLoading(false), 600);
    return () => clearTimeout(timer);
  }, [dateRange]);

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

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

        {/* KPI Overview */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 md:gap-3">
          <KpiCard label={t("analytics.overview.totalConversations")} value={DEMO_OVERVIEW.totalConversations.toLocaleString()} delta={DEMO_OVERVIEW.totalConversationsDelta} icon="chat" />
          <KpiCard label={t("analytics.overview.resolutionRate")} value={`${DEMO_OVERVIEW.resolutionRate}%`} delta={DEMO_OVERVIEW.resolutionRateDelta} icon="check" />
          <KpiCard label={t("analytics.overview.avgResponseTime")} value={formatMs(DEMO_OVERVIEW.avgResponseTime)} delta={DEMO_OVERVIEW.avgResponseTimeDelta} icon="bolt" />
          <KpiCard label={t("analytics.overview.avgResolutionTime")} value={formatMs(DEMO_OVERVIEW.avgResolutionTime)} delta={DEMO_OVERVIEW.avgResolutionTimeDelta} icon="timer" />
          <KpiCard label={t("analytics.overview.customerSatisfaction")} value={`${DEMO_OVERVIEW.customerSatisfaction}/5`} delta={DEMO_OVERVIEW.customerSatisfactionDelta} icon="star" />
          <KpiCard label={t("analytics.overview.aiResolutionRate")} value={`${DEMO_OVERVIEW.aiResolutionRate}%`} delta={DEMO_OVERVIEW.aiResolutionRateDelta} icon="sparkle" />
        </div>

        {/* AI vs Human Trend */}
        <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-1">AI vs Human Resolution Trend</h3>
          <p className="text-xs text-gray-400 mb-4">Daily breakdown of conversations handled by AI and human agents</p>
          <div className="h-[200px] md:h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DEMO_TREND_DATA} barGap={0}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0", fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="aiHandled" fill="#7c5cfc" name="AI Handled" radius={[4, 4, 0, 0]} stackId="a" />
                <Bar dataKey="humanHandled" fill="#c4b5fd" name="Human Handled" radius={[4, 4, 0, 0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* AI vs Human Performance */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          {/* AI Performance */}
          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <h3 className="font-bold text-gray-900">{t("analytics.aiPerformance.title")}</h3>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-violet-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-violet-600">{DEMO_AI_PERFORMANCE.conversationsHandled}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Handled</p>
              </div>
              <div className="bg-violet-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-violet-600">{formatMs(DEMO_AI_PERFORMANCE.avgResolutionTime)}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Avg Time</p>
              </div>
              <div className="bg-violet-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-violet-600">{DEMO_AI_PERFORMANCE.escalationRate}%</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Escalated</p>
              </div>
            </div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Top Resolved Categories</p>
            <div className="space-y-2">
              {DEMO_AI_PERFORMANCE.topCategories.map((cat) => (
                <div key={cat.name} className="flex items-center gap-3">
                  <span className="text-xs text-gray-600 w-28 truncate">{cat.name}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2">
                    <div className="bg-gradient-to-r from-violet-400 to-purple-500 h-2 rounded-full" style={{ width: `${cat.pct}%` }} />
                  </div>
                  <span className="text-[10px] text-gray-400 w-8 text-end">{cat.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Human Performance */}
          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-primary-400 to-primary-600 rounded-xl flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
              </div>
              <h3 className="font-bold text-gray-900">{t("analytics.humanPerformance.title")}</h3>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-primary-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-primary-600">{DEMO_HUMAN_PERFORMANCE.conversationsHandled}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Handled</p>
              </div>
              <div className="bg-primary-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-primary-600">{formatMs(DEMO_HUMAN_PERFORMANCE.avgResolutionTime)}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Avg Time</p>
              </div>
              <div className="bg-primary-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-primary-600">{DEMO_HUMAN_PERFORMANCE.satisfactionScore}/5</p>
                <p className="text-[10px] text-gray-500 mt-0.5">CSAT</p>
              </div>
            </div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Top Agents</p>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-start py-1.5 text-gray-400 font-medium">Agent</th>
                  <th className="text-end py-1.5 text-gray-400 font-medium">Chats</th>
                  <th className="text-end py-1.5 text-gray-400 font-medium">Avg Time</th>
                  <th className="text-end py-1.5 text-gray-400 font-medium">CSAT</th>
                </tr>
              </thead>
              <tbody>
                {DEMO_HUMAN_PERFORMANCE.topAgents.map((agent) => (
                  <tr key={agent.name} className="border-b border-gray-50">
                    <td className="py-2 text-gray-700 font-medium">{agent.name}</td>
                    <td className="py-2 text-end text-gray-500">{agent.conversations}</td>
                    <td className="py-2 text-end text-gray-500">{formatMs(agent.avgTime)}</td>
                    <td className="py-2 text-end"><span className="text-amber-500 font-medium">{agent.satisfaction}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top Questions */}
        <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-1">{t("analytics.topQuestions.title")}</h3>
          <p className="text-xs text-gray-400 mb-4">{t("analytics.topQuestions.subtitle")}</p>
          <div className="space-y-2">
            {DEMO_TOP_QUESTIONS.map((q, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-gray-50/50 rounded-xl hover:bg-gray-50 transition">
                <div className="w-8 h-8 bg-primary-50 rounded-lg flex items-center justify-center shrink-0">
                  <span className="text-xs font-bold text-primary-500">#{i + 1}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{q.question}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{q.category}</span>
                    <span className="text-[10px] text-gray-400">{q.count} times</span>
                    <span className="text-[10px] text-gray-400">&middot;</span>
                    <span className="text-[10px] text-violet-500">{q.aiHandled}% AI handled</span>
                  </div>
                </div>
                {q.canAutomate && (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg bg-amber-50 text-amber-600 ring-1 ring-amber-200">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                    </svg>
                    <span className="hidden sm:inline">Automate</span>
                  </span>
                )}
                <div className="hidden sm:block w-24">
                  <div className="bg-gray-200 rounded-full h-1.5">
                    <div className="bg-gradient-to-r from-primary-400 to-violet-500 h-1.5 rounded-full" style={{ width: `${(q.count / DEMO_TOP_QUESTIONS[0].count) * 100}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Tool Usage + Channel Performance */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-1">{t("analytics.toolUsage.title")}</h3>
            <p className="text-xs text-gray-400 mb-4">{t("analytics.toolUsage.subtitle")}</p>
            <div className="space-y-3">
              {DEMO_TOOL_USAGE.map((tool) => (
                <div key={tool.tool} className="flex items-center gap-3">
                  <div className="w-7 h-7 bg-violet-50 rounded-lg flex items-center justify-center shrink-0">
                    <svg className="w-3.5 h-3.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.19A1.5 1.5 0 015.276 9.5h13.448a1.5 1.5 0 01.76 2.48l-5.384 3.19a1.5 1.5 0 01-1.52 0z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-700 truncate">{tool.tool}</span>
                      <span className="text-[10px] text-gray-400">{tool.usage} uses</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                        <div className="bg-gradient-to-r from-violet-400 to-purple-500 h-1.5 rounded-full" style={{ width: `${(tool.usage / DEMO_TOOL_USAGE[0].usage) * 100}%` }} />
                      </div>
                      <span className={clsx("text-[10px] font-medium px-1.5 py-0.5 rounded-full", tool.successRate >= 95 ? "bg-green-50 text-green-600" : "bg-amber-50 text-amber-600")}>
                        {tool.successRate}%
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-1">{t("analytics.channelPerformance.title")}</h3>
            <p className="text-xs text-gray-400 mb-4">{t("analytics.channelPerformance.subtitle")}</p>
            <div className="h-[200px] mb-4">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={DEMO_CHANNEL_DATA} dataKey="conversations" nameKey="channel" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} strokeWidth={0}>
                    {DEMO_CHANNEL_DATA.map((entry, i) => (<Cell key={i} fill={entry.color} />))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(value: number) => [`${value} conversations`, ""]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_CHANNEL_DATA.map((ch) => (
                <div key={ch.channel} className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ch.color }} />
                  <span className="text-[11px] text-gray-600 truncate">{ch.channel}</span>
                  <span className="text-[10px] text-gray-400 ml-auto">{ch.conversations}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Department Performance */}
        <div className="bg-white rounded-2xl p-3 md:p-6 shadow-card border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-3">{t("analytics.departmentPerformance.title")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-start py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">Department</th>
                  <th className="text-end py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">Conversations</th>
                  <th className="text-end py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">Response Time</th>
                  <th className="text-end py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">Resolution</th>
                  <th className="text-end py-2.5 px-3 text-gray-500 text-xs font-medium uppercase tracking-wide">SLA</th>
                </tr>
              </thead>
              <tbody>
                {DEMO_DEPARTMENT_DATA.map((dept) => (
                  <tr key={dept.department} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                    <td className="py-2.5 px-3 font-medium text-gray-900">{dept.department}</td>
                    <td className="py-2.5 px-3 text-end text-gray-600">{dept.conversations}</td>
                    <td className="py-2.5 px-3 text-end text-gray-600">{formatMs(dept.responseTime)}</td>
                    <td className="py-2.5 px-3 text-end">
                      <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", dept.resolutionRate >= 90 ? "bg-green-50 text-green-600" : dept.resolutionRate >= 80 ? "bg-amber-50 text-amber-600" : "bg-red-50 text-red-500")}>
                        {dept.resolutionRate}%
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-end">
                      <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", dept.slaCompliance >= 90 ? "bg-green-50 text-green-600" : dept.slaCompliance >= 80 ? "bg-amber-50 text-amber-600" : "bg-red-50 text-red-500")}>
                        {dept.slaCompliance}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* AI Insights */}
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {DEMO_INSIGHTS.map((insight) => (
              <div key={insight.id} className={clsx("rounded-xl p-4 border transition hover:shadow-subtle", insight.impact === "high" ? "border-amber-200 bg-amber-50/30" : "border-gray-200 bg-gray-50/30")}>
                <div className="flex items-start gap-3">
                  <div className={clsx("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5", insight.type === "automation" ? "bg-violet-100" : insight.type === "integration" ? "bg-blue-100" : "bg-green-100")}>
                    {insight.type === "automation" ? (
                      <svg className="w-3.5 h-3.5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
                    ) : insight.type === "integration" ? (
                      <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.07-9.07l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" /></svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-semibold text-gray-900">{insight.title}</h4>
                      {insight.impact === "high" && <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full uppercase">High Impact</span>}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed mb-2">{insight.description}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-medium">{insight.metric}</span>
                      <button className="text-[10px] font-medium text-primary-600 hover:text-primary-700 transition">
                        {insight.type === "automation" ? t("analytics.insights.createFlow") : t("analytics.insights.setupIntegration")} →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="h-20 md:h-4" />
      </div>
    </AppLayout>
  );
}

function KpiCard({ label, value, delta, icon }: { label: string; value: string; delta: number; icon: string }) {
  return (
    <div className="bg-white rounded-2xl p-3 md:p-4 shadow-card border border-gray-100 hover:shadow-float transition-shadow">
      <div className="flex items-center justify-between mb-2">
        <div className={clsx("w-7 h-7 rounded-lg flex items-center justify-center", icon === "sparkle" ? "bg-violet-100" : "bg-primary-50")}>
          <svg className={clsx("w-3.5 h-3.5", icon === "sparkle" ? "text-violet-500" : "text-primary-500")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {icon === "chat" && <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />}
            {icon === "check" && <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />}
            {icon === "bolt" && <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />}
            {icon === "timer" && <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />}
            {icon === "star" && <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />}
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
