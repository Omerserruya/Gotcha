"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import {
  getSystemTenantFeatures,
  updateSystemTenantFeature,
  type TenantFeatureView,
} from "@/lib/api";

interface Props {
  tenantId: string;
  onMessage: (msg: string, type?: "success" | "error") => void;
}

const CATEGORY_LABEL: Record<TenantFeatureView["category"], string> = {
  messaging: "Messaging",
  voice: "Voice",
  ai: "AI",
  knowledge: "Knowledge",
  crm: "CRM",
  automation: "Automation",
  commerce: "Commerce",
  integrations: "Integrations",
  analytics: "Analytics",
  notifications: "Notifications",
  admin: "Admin",
};

const CATEGORY_TONE: Record<TenantFeatureView["category"], string> = {
  messaging: "bg-blue-50 text-blue-600 ring-blue-200",
  voice: "bg-purple-50 text-purple-600 ring-purple-200",
  ai: "bg-orange-50 text-orange-600 ring-orange-200",
  knowledge: "bg-amber-50 text-amber-600 ring-amber-200",
  crm: "bg-cyan-50 text-cyan-600 ring-cyan-200",
  automation: "bg-indigo-50 text-indigo-600 ring-indigo-200",
  commerce: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  integrations: "bg-pink-50 text-pink-600 ring-pink-200",
  analytics: "bg-teal-50 text-teal-600 ring-teal-200",
  notifications: "bg-yellow-50 text-yellow-700 ring-yellow-200",
  admin: "bg-slate-100 text-slate-700 ring-slate-300",
};

export function FeaturesSection({ tenantId, onMessage }: Props) {
  const { token } = useAuth();
  const [features, setFeatures] = useState<TenantFeatureView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const fetchFeatures = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getSystemTenantFeatures(token, tenantId);
      setFeatures(res.data);
    } catch (err) {
      console.error("Failed to load features:", err);
      onMessage("Failed to load features", "error");
    } finally {
      setLoading(false);
    }
  }, [token, tenantId, onMessage]);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  async function handleToggle(feature: TenantFeatureView) {
    if (!token) return;
    setPendingKey(feature.feature);
    // Optimistic update
    setFeatures((prev) =>
      prev
        ? prev.map((f) =>
            f.feature === feature.feature ? { ...f, enabled: !f.enabled, configured: true } : f,
          )
        : prev,
    );
    try {
      await updateSystemTenantFeature(token, tenantId, feature.feature, {
        enabled: !feature.enabled,
      });
      onMessage(
        !feature.enabled
          ? `Enabled "${feature.displayName}"`
          : `Disabled "${feature.displayName}"`,
      );
    } catch (err: unknown) {
      // Revert on failure
      setFeatures((prev) =>
        prev
          ? prev.map((f) =>
              f.feature === feature.feature
                ? { ...f, enabled: feature.enabled, configured: feature.configured }
                : f,
            )
          : prev,
      );
      const msg = err instanceof Error ? err.message : "Failed to update feature";
      onMessage(msg, "error");
    } finally {
      setPendingKey(null);
    }
  }

  const grouped = useMemo(() => {
    if (!features) return [];
    const map = new Map<TenantFeatureView["category"], TenantFeatureView[]>();
    for (const f of features) {
      const arr = map.get(f.category) || [];
      arr.push(f);
      map.set(f.category, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [features]);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-emerald-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z"
            />
          </svg>
        </div>
        <div className="flex-1">
          <h2 className="font-semibold text-gray-900">Features</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Enable or disable platform features for this tenant
          </p>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
          {features ? `${features.filter((f) => f.enabled).length}/${features.length} on` : "…"}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-emerald-200 border-t-emerald-500 rounded-full animate-spin" />
        </div>
      ) : !features || features.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">No features configured</p>
      ) : (
        <div className="space-y-5">
          {grouped.map(([category, items]) => (
            <div key={category}>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={clsx(
                    "text-[10px] px-2 py-0.5 rounded-full font-medium ring-1",
                    CATEGORY_TONE[category],
                  )}
                >
                  {CATEGORY_LABEL[category]}
                </span>
                <span className="text-[10px] text-gray-400">
                  {items.filter((i) => i.enabled).length}/{items.length} enabled
                </span>
              </div>
              <div className="space-y-2">
                {items.map((f) => (
                  <div
                    key={f.feature}
                    className="flex items-center justify-between gap-4 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {f.displayName}
                        </p>
                        {!f.configured && (
                          <span
                            className="text-[10px] text-gray-400"
                            title="Inheriting metadata default - no DB row yet"
                          >
                            (default)
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                        {f.description}
                      </p>
                      <code className="text-[10px] text-gray-400 mt-0.5 inline-block">
                        {f.feature}
                      </code>
                    </div>
                    <button
                      onClick={() => handleToggle(f)}
                      disabled={pendingKey === f.feature}
                      className={clsx(
                        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50",
                        f.enabled ? "bg-emerald-500" : "bg-gray-200",
                      )}
                      role="switch"
                      aria-checked={f.enabled}
                      aria-label={`Toggle ${f.displayName}`}
                    >
                      <span
                        className={clsx(
                          "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition duration-200 ease-in-out",
                          f.enabled ? "translate-x-5" : "translate-x-0",
                        )}
                      />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
