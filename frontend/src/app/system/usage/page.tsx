"use client";

import { useState, useEffect, useCallback } from "react";
import { SystemLayout } from "@/components/SystemLayout";
import { useAuth } from "@/context/AuthContext";
import { getSystemUsageStats, getSystemUsageByTenant } from "@/lib/api";
import clsx from "clsx";

type Period = 7 | 30 | 90 | 365;

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

export default function SystemUsagePage() {
  const { token } = useAuth();
  const [period, setPeriod] = useState<Period>(30);
  const [stats, setStats] = useState<Record<string, { total: number; count: number }>>({});
  const [totalEvents, setTotalEvents] = useState(0);
  const [byTenant, setByTenant] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [statsRes, tenantRes] = await Promise.all([
        getSystemUsageStats(token, period),
        getSystemUsageByTenant(token, period),
      ]);
      setStats(statsRes.data?.stats || {});
      setTotalEvents(statsRes.data?.totalEvents || 0);
      setByTenant(tenantRes.data || []);
    } catch (err) {
      console.error("System usage fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const statCards = [
    { key: "ai_tokens", label: "AI Tokens", icon: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" },
    { key: "message_sent", label: "Messages Sent", icon: "M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" },
    { key: "tool_call", label: "Tool Calls", icon: "M11.42 15.17l-5.66 5.66a2.25 2.25 0 01-3.182-3.182l5.66-5.66m3.182 3.182l5.66-5.66a2.25 2.25 0 00-3.182-3.182l-5.66 5.66m3.182 3.182L12 21m-3.182-3.182L3 12" },
    { key: "automation_run", label: "Automations", icon: "M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" },
  ];

  // Calculate max for bar sizing
  const maxTenantUsage = Math.max(1, ...byTenant.map((t) =>
    Object.values(t.usage as Record<string, { total: number }>).reduce((sum, u) => sum + u.total, 0)
  ));

  return (
    <SystemLayout>
      <div className="p-6 overflow-y-auto h-screen">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Platform Usage</h1>
            <p className="text-sm text-gray-400 mt-0.5">Usage across all tenants &middot; {totalEvents.toLocaleString()} total events</p>
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
            {/* Global Stat Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {statCards.map(({ key, label, icon }) => (
                <div key={key} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={clsx("w-9 h-9 rounded-xl flex items-center justify-center", TYPE_BG[key])}>
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                      </svg>
                    </div>
                  </div>
                  <p className="text-2xl font-bold text-gray-900">{(stats[key]?.total || 0).toLocaleString()}</p>
                  <p className="text-xs text-gray-400 mt-1">{label}</p>
                  <p className="text-[10px] text-gray-300 mt-0.5">{stats[key]?.count || 0} events</p>
                </div>
              ))}
            </div>

            {/* Usage by Tenant */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">Usage by Tenant</h3>
              {byTenant.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No usage data yet</p>
              ) : (
                <div className="space-y-3">
                  {byTenant.map((entry: any) => {
                    const tenantTotal = Object.values(entry.usage as Record<string, { total: number }>).reduce((sum, u) => sum + u.total, 0);
                    return (
                      <div key={entry.tenant.id} className="p-4 rounded-xl border border-gray-100 hover:bg-gray-50/50 transition">
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
                          <span className="text-sm font-semibold text-gray-700">{tenantTotal.toLocaleString()}</span>
                        </div>
                        {/* Stacked bar */}
                        <div className="h-3 bg-gray-100 rounded-full overflow-hidden flex">
                          {Object.entries(entry.usage as Record<string, { total: number }>).map(([type, u]) => (
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
                          {Object.entries(entry.usage as Record<string, { total: number; count: number }>).map(([type, u]) => (
                            <span key={type} className={clsx("text-[10px] px-2 py-0.5 rounded-full border font-medium", TYPE_BG[type] || "bg-gray-50 text-gray-500 border-gray-200")}>
                              {TYPE_LABELS[type] || type}: {u.total.toLocaleString()}
                            </span>
                          ))}
                        </div>
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
