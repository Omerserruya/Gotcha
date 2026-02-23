"use client";

import { useState, useEffect } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getDashboardStats,
  getAgentStats,
  getHourlyVolume,
  getDailyVolume,
  getQueueStats,
} from "@/lib/api";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

function formatMs(ms: number | null): string {
  if (ms === null) return "--";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export default function DashboardPage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [stats, setStats] = useState<any>(null);
  const [agentStats, setAgentStats] = useState<any[]>([]);
  const [hourly, setHourly] = useState<any[]>([]);
  const [daily, setDaily] = useState<any[]>([]);
  const [queue, setQueue] = useState<any>(null);

  useEffect(() => {
    if (!token) return;
    getDashboardStats(token).then((r) => setStats(r.data)).catch(console.error);
    getAgentStats(token).then((r) => setAgentStats(r.data)).catch(console.error);
    getHourlyVolume(token).then((r) => setHourly(r.data)).catch(console.error);
    getDailyVolume(token).then((r) => setDaily(r.data)).catch(console.error);
    getQueueStats(token).then((r) => setQueue(r.data)).catch(console.error);
  }, [token]);

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        <h1 className="text-xl md:text-2xl font-bold text-gray-900 mb-4 md:mb-6 ">{t("dashboard.title")}</h1>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-6 md:mb-8">
          <KpiCard label={t("dashboard.activeConversations")} value={stats?.activeConversations ?? "--"} color="from-primary-400 to-primary-600" icon="chat" />
          <KpiCard label={t("dashboard.waitingConversations")} value={stats?.waitingConversations ?? "--"} color="from-amber-400 to-amber-600" icon="clock" />
          <KpiCard label={t("dashboard.closedToday")} value={stats?.closedToday ?? "--"} color="from-gray-400 to-gray-600" icon="check" />
          <KpiCard label={t("dashboard.totalMessages")} value={stats?.totalMessagesToday ?? "--"} color="from-blue-400 to-blue-600" icon="message" />
          <KpiCard label={t("dashboard.avgResponseTime")} value={formatMs(stats?.avgResponseTimeMs)} color="from-purple-400 to-purple-600" icon="bolt" />
          <KpiCard label={t("dashboard.avgResolutionTime")} value={formatMs(stats?.avgResolutionTimeMs)} color="from-indigo-400 to-indigo-600" icon="timer" />
          <KpiCard label={t("dashboard.queueDepth")} value={queue?.waiting ?? "--"} color="from-orange-400 to-orange-600" icon="queue" />
          <KpiCard label={t("dashboard.avgWaitTime")} value={formatMs(queue?.avgWaitTimeMs)} color="from-red-400 to-red-600" icon="wait" />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6 mb-6 md:mb-8">
          {/* Hourly Traffic */}
          <div className="bg-white rounded-2xl p-4 md:p-6 shadow-card border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-4">{t("dashboard.hourlyTraffic")}</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={hourly}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="hour" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0" }} />
                <Legend />
                <Bar dataKey="inbound" fill="#7c5cfc" name={t("dashboard.inbound")} radius={[4, 4, 0, 0]} />
                <Bar dataKey="outbound" fill="#a78bfa" name={t("dashboard.outbound")} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Daily Volume */}
          <div className="bg-white rounded-2xl p-4 md:p-6 shadow-card border border-gray-100">
            <h3 className="font-bold text-gray-900 mb-4">{t("dashboard.conversationVolume")}</h3>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0" }} />
                <Legend />
                <Line type="monotone" dataKey="total" stroke="#7c5cfc" name={t("dashboard.messages")} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="closed" stroke="#ef4444" name={t("dashboard.closed")} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Agent Workload Table */}
        <div className="bg-white rounded-2xl p-4 md:p-6 shadow-card border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-4">{t("dashboard.agentWorkload")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-start py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.name")}</th>
                  <th className="text-start py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("agents.activeConversations")}</th>
                  <th className="text-start py-3 px-4 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("dashboard.avgResponseTime")}</th>
                </tr>
              </thead>
              <tbody>
                {agentStats.map((agent) => (
                  <tr key={agent.agentId} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-primary-100 to-primary-200 rounded-lg flex items-center justify-center">
                          <span className="text-xs font-bold text-primary-600">{agent.name?.charAt(0).toUpperCase()}</span>
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{agent.name}</p>
                          <p className="text-xs text-gray-400">{agent.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="bg-primary-50 text-primary-600 px-2.5 py-1 rounded-full text-xs font-medium">
                        {agent.activeConversations}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {formatMs(agent.avgResponseTimeMs)}
                    </td>
                  </tr>
                ))}
                {agentStats.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-12 text-center text-gray-400">
                      {t("dashboard.noData")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function KpiCard({ label, value, color, icon }: { label: string; value: any; color: string; icon: string }) {
  return (
    <div className="bg-white rounded-2xl p-3 md:p-5 shadow-card border border-gray-100 hover:shadow-float transition-shadow">
      <div className={`w-8 h-8 bg-gradient-to-br ${color} rounded-xl flex items-center justify-center mb-3`}>
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {icon === "chat" && <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />}
          {icon === "clock" && <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />}
          {icon === "check" && <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />}
          {icon === "message" && <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />}
          {icon === "bolt" && <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />}
          {icon === "timer" && <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />}
          {icon === "queue" && <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />}
          {icon === "wait" && <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />}
        </svg>
      </div>
      <p className="text-lg md:text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-[10px] md:text-xs text-gray-400 mt-1">{label}</p>
    </div>
  );
}
