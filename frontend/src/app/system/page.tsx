"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getSystemStats } from "@/lib/api";
import { SystemLayout } from "@/components/SystemLayout";

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function SystemDashboardPage() {
  const { token } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getSystemStats(token);
      setStats(res.data);
    } catch (err) {
      console.error("Failed to load system stats:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  return (
    <SystemLayout>
      <div className="max-w-5xl mx-auto p-6 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Overview of all tenants and system health</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : stats ? (
          <>
            {/* Stats Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              <StatCard label="Tenants" value={stats.tenants?.total || 0} sub={`${stats.tenants?.active || 0} active`} />
              <StatCard label="Users" value={stats.users || 0} />
              <StatCard label="Conversations" value={stats.conversations || 0} />
              <StatCard label="Messages" value={stats.messages || 0} />
              <StatCard label="Channels" value={stats.connectedChannels || 0} sub="connected" />
            </div>

            {/* Recent Tenants */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-900">Recent Tenants</h2>
                <Link href="/system/tenants" className="text-xs text-orange-500 hover:text-orange-600 font-medium">
                  View All
                </Link>
              </div>
              <div className="space-y-2">
                {(stats.recentTenants || []).map((t: any) => (
                  <Link
                    key={t.id}
                    href={`/system/tenants/${t.id}`}
                    className="flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">{t.name}</p>
                      <p className="text-xs text-gray-400">{t.slug}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 ${
                        t.isActive
                          ? "bg-green-50 text-green-600 ring-green-200"
                          : "bg-red-50 text-red-600 ring-red-200"
                      }`}>
                        {t.isActive ? "Active" : "Disabled"}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(t.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </>
        ) : (
          <p className="text-gray-400 text-center py-8">Failed to load stats</p>
        )}
      </div>
    </SystemLayout>
  );
}
