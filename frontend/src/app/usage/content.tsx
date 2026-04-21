"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getUsageStats, getUsageDaily, getUsageLogs } from "@/lib/api";
import clsx from "clsx";

type Period = 7 | 30 | 90 | 365;

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

export function UsageContent() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>(30);
  const [stats, setStats] = useState<Record<string, { total: number; count: number }>>({});
  const [daily, setDaily] = useState<Array<{ date: string; type: string; total: number }>>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [statsRes, dailyRes, logsRes] = await Promise.all([
        getUsageStats(token, period),
        getUsageDaily(token, period),
        getUsageLogs(token, { limit: 20 }),
      ]);
      setStats(statsRes.data?.stats || {});
      setDaily(dailyRes.data || []);
      setLogs(logsRes.data || []);
    } catch (err) {
      console.error("Usage fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [token, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const statCards = [
    { key: "ai_tokens", icon: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" },
    { key: "message_sent", icon: "M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" },
    { key: "tool_call", icon: "M11.42 15.17l-5.66 5.66a2.25 2.25 0 01-3.182-3.182l5.66-5.66m3.182 3.182l5.66-5.66a2.25 2.25 0 00-3.182-3.182l-5.66 5.66m3.182 3.182L12 21m-3.182-3.182L3 12" },
    { key: "automation_run", icon: "M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" },
  ];

  // Compute max for bar chart
  const dailyByDate = daily.reduce<Record<string, Record<string, number>>>((acc, d) => {
    if (!acc[d.date]) acc[d.date] = {};
    acc[d.date][d.type] = (acc[d.date][d.type] || 0) + d.total;
    return acc;
  }, {});
  const dates = Object.keys(dailyByDate).sort();
  const maxDaily = Math.max(1, ...dates.map((d) => Object.values(dailyByDate[d]).reduce((a, b) => a + b, 0)));

  return (
      <div className="p-3 md:p-6 overflow-y-auto h-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("usage.title")}</h1>
            <p className="text-sm text-gray-400 mt-0.5">{t("usage.subtitle")}</p>
          </div>
          <select
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value) as Period)}
            className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none"
          >
            <option value={7}>{t("usage.last7days")}</option>
            <option value={30}>{t("usage.last30days")}</option>
            <option value={90}>{t("usage.last90days")}</option>
            <option value={365}>{t("usage.allTime")}</option>
          </select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="max-w-5xl space-y-6">
            {/* Stat Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {statCards.map(({ key, icon }) => (
                <div key={key} className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={clsx("w-9 h-9 rounded-xl flex items-center justify-center", TYPE_BG[key])}>
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                      </svg>
                    </div>
                  </div>
                  <p className="text-2xl font-bold text-gray-900">
                    {(stats[key]?.total || 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{t(`usage.${key}`)}</p>
                  <p className="text-[10px] text-gray-300 mt-0.5">{stats[key]?.count || 0} events</p>
                </div>
              ))}
            </div>

            {/* Daily Chart */}
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">{t("usage.usageOverTime")}</h3>
              {dates.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">{t("usage.noUsage")}</p>
              ) : (
                <div className="space-y-1.5">
                  {dates.slice(-14).map((date) => {
                    const dayTotal = Object.values(dailyByDate[date]).reduce((a, b) => a + b, 0);
                    const pct = (dayTotal / maxDaily) * 100;
                    return (
                      <div key={date} className="flex items-center gap-3">
                        <span className="text-xs text-gray-400 w-20 shrink-0">{new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                        <div className="flex-1 h-6 bg-gray-50 rounded-lg overflow-hidden flex">
                          {Object.entries(dailyByDate[date]).map(([type, val]) => (
                            <div
                              key={type}
                              className={clsx("h-full transition-all", TYPE_COLORS[type] || "bg-gray-300")}
                              style={{ width: `${(val / maxDaily) * 100}%` }}
                              title={`${t(`usage.${type}`)}: ${val.toLocaleString()}`}
                            />
                          ))}
                        </div>
                        <span className="text-xs text-gray-500 w-16 text-end">{dayTotal.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Legend */}
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-gray-100">
                {Object.entries(TYPE_COLORS).map(([type, color]) => (
                  <div key={type} className="flex items-center gap-1.5">
                    <div className={clsx("w-2.5 h-2.5 rounded-full", color)} />
                    <span className="text-xs text-gray-500">{t(`usage.${type}`)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent Activity */}
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4">{t("usage.recentActivity")}</h3>
              {logs.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">{t("usage.noUsage")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-400 text-xs border-b border-gray-100">
                        <th className="text-start pb-2 font-medium">{t("usage.type")}</th>
                        <th className="text-end pb-2 font-medium">{t("usage.quantity")}</th>
                        <th className="text-end pb-2 font-medium">{t("usage.date")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log: any) => (
                        <tr key={log.id} className="border-b border-gray-50">
                          <td className="py-2.5">
                            <span className={clsx("text-xs px-2 py-0.5 rounded-full border font-medium", TYPE_BG[log.type] || "bg-gray-50 text-gray-500 border-gray-200")}>
                              {t(`usage.${log.type}`)}
                            </span>
                          </td>
                          <td className="text-end text-gray-700 font-medium">{log.quantity.toLocaleString()}</td>
                          <td className="text-end text-gray-400 text-xs">{new Date(log.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
  );
}
