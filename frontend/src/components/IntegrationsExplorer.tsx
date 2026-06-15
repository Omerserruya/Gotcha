"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getMarketplaceIntegrations } from "@/lib/api";
import { INTEGRATION_LOGOS } from "@/lib/integration-logos";
import clsx from "clsx";

/**
 * Tenant-scoped integrations explorer. Layout-agnostic — render inside
 * AppLayout (top-level marketplace) or SettingsLayout (Settings →
 * Integrations). Both surfaces hit the SAME `/api/integrations` endpoint
 * and reflect the SAME `tenant_integrations` rows: connecting from one
 * place shows up immediately in the other.
 */

const CATEGORIES = [
  { label: "All", value: "All" },
  { label: "E-Commerce", value: "ECOMMERCE" },
  { label: "CRM", value: "CRM" },
  { label: "Payments", value: "PAYMENTS" },
  { label: "Project Management", value: "PROJECT_MANAGEMENT" },
  { label: "Database", value: "DATABASE" },
  { label: "Custom", value: "CUSTOM" },
];

const CATEGORY_COLORS: Record<string, string> = {
  ECOMMERCE: "bg-blue-100 text-blue-700",
  CRM: "bg-purple-100 text-purple-700",
  PAYMENTS: "bg-green-100 text-green-700",
  PROJECT_MANAGEMENT: "bg-indigo-100 text-indigo-700",
  DATABASE: "bg-slate-100 text-slate-700",
  CUSTOM: "bg-violet-100 text-violet-700",
};

const AUTH_TYPE_STYLES: Record<string, string> = {
  OAUTH2: "bg-blue-50 text-blue-600 border-blue-200",
  API_KEY: "bg-amber-50 text-amber-600 border-amber-200",
  BASIC_AUTH: "bg-gray-50 text-gray-600 border-gray-200",
};

const LOGO_COLORS = [
  "bg-blue-500", "bg-purple-500", "bg-green-500", "bg-orange-500",
  "bg-pink-500", "bg-yellow-500", "bg-teal-500", "bg-red-500",
];

function getLogoColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return LOGO_COLORS[Math.abs(hash) % LOGO_COLORS.length];
}

export interface IntegrationsExplorerProps {
  /** Header subtitle line. Lets the host page tailor the framing
   *  (e.g. AI Studio: "power your AI agents"; Settings: "for the whole platform"). */
  subtitle?: string;
  /** Header title. Default uses the existing i18n key. */
  title?: string;
  /** Optional category prefilter (e.g. "CRM" to show only CRMs). */
  initialCategory?: string;
  /** When set, lock the explorer to a single category — the category
   *  filter chips are hidden and the underlying list is filtered server-
   *  side at the rendering layer. Used by Settings → Integrations to
   *  show only CRM integrations and avoid surfacing the full marketplace
   *  surface there. */
  restrictToCategory?: string;
}

export default function IntegrationsExplorer({ subtitle, title, initialCategory, restrictToCategory }: IntegrationsExplorerProps) {
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [integrations, setIntegrations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState(restrictToCategory || initialCategory || "All");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    getMarketplaceIntegrations(token)
      .then((res) => {
        const list = res.data || [];
        if (!list.some((i: any) => i.slug === "custom_api")) {
          list.push({
            id: "virtual_custom_api",
            slug: "custom_api",
            name: "Custom API",
            description: "Define your own HTTP tools — Postman-style request builder. Each tool exposes one API call to the AI as custom.<slug>.",
            category: "CUSTOM",
            authType: "CUSTOM",
            isPublished: true,
          });
        }
        setIntegrations(list);
      })
      .catch(() => setIntegrations([]))
      .finally(() => setLoading(false));
  }, [token]);

  const filtered = integrations.filter((intg) => {
    const matchSearch =
      !search ||
      intg.name?.toLowerCase().includes(search.toLowerCase()) ||
      intg.description?.toLowerCase().includes(search.toLowerCase());
    // When the page is locked to a single category, ignore the local
    // activeCategory state entirely — only that category's items pass.
    const effectiveCat = restrictToCategory ?? activeCategory;
    // An integration flagged `canActAsCrm` (e.g. Shopify, natively ECOMMERCE)
    // may be elected as the tenant's CRM source of truth, so it also passes the
    // CRM filter even though its native category differs.
    const actsAsCrm = effectiveCat === "CRM" && intg.canActAsCrm === true;
    const matchCat = effectiveCat === "All" || intg.category === effectiveCat || intg.category?.toUpperCase() === effectiveCat || actsAsCrm;
    return matchSearch && matchCat;
  });

  function getStatusInfo(intg: any) {
    const ti = intg.tenantConnection;
    const isConnected = ti && ti.status === "CONNECTED";
    const totalTools = intg.catalogTools?.length || 0;
    const enabledTools = intg.catalogTools?.filter((t: any) => t.tenantTool?.isEnabled).length || 0;
    return { isConnected, totalTools, enabledTools };
  }

  return (
    <div className="p-3 md:p-6 overflow-y-auto h-screen">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{title ?? t("marketplace.title")}</h1>
        <p className="text-sm text-gray-400 mt-1">
          {subtitle ?? "Connect external services to power your AI agents"}
        </p>
      </div>

      {/* Search + filters */}
      <div className="mb-5 flex flex-col gap-3">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("marketplace.search")}
            className="w-full pl-9 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none transition"
          />
        </div>
        {!restrictToCategory && (
          <div className="flex gap-2 flex-wrap">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                onClick={() => setActiveCategory(cat.value)}
                className={clsx(
                  "px-4 py-1.5 rounded-full text-sm font-medium transition",
                  activeCategory === cat.value
                    ? "bg-violet-600 text-white shadow-sm"
                    : "bg-white text-gray-600 border border-gray-200 hover:border-violet-300 hover:text-violet-600"
                )}
              >
                {cat.value === "All" ? t("marketplace.allCategories") : cat.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-gray-400">
          <svg className="w-12 h-12 mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z" />
          </svg>
          <p className="text-sm">No integrations found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((intg) => {
            const { isConnected, totalTools, enabledTools } = getStatusInfo(intg);
            const logoSrc = intg.logoUrl || INTEGRATION_LOGOS[intg.slug] || null;
            const logoColor = getLogoColor(intg.name || "");
            const authLabel = intg.authType === "OAUTH2" ? "OAuth" : intg.authType === "BASIC_AUTH" ? "Basic Auth" : "API Key";
            return (
              <div
                key={intg.id || intg.slug}
                className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 flex flex-col gap-3 hover:shadow-md hover:border-violet-200 transition cursor-pointer"
                onClick={() => router.push(`/integrations/${intg.slug}`)}
              >
                <div className="flex items-start justify-between">
                  <div className={clsx("w-12 h-12 rounded-xl flex items-center justify-center shrink-0", logoSrc ? "bg-white border border-gray-100 p-1.5" : `${logoColor} text-white font-bold text-lg`)}>
                    {logoSrc ? (
                      <img src={logoSrc} alt={intg.name} className="w-full h-full object-contain" />
                    ) : (
                      (intg.name || "?").charAt(0).toUpperCase()
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={clsx("w-2 h-2 rounded-full", isConnected ? "bg-green-500" : "bg-gray-300")} />
                      <span className={clsx("text-xs font-medium", isConnected ? "text-green-600" : "text-gray-400")}>
                        {isConnected ? t("marketplace.connected") : t("marketplace.notConnected")}
                      </span>
                    </div>
                    {intg.authType && (
                      <span className={clsx("px-2 py-0.5 rounded-full text-[10px] font-medium border", AUTH_TYPE_STYLES[intg.authType] || AUTH_TYPE_STYLES.API_KEY)}>
                        {authLabel}
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">{intg.name}</h3>
                  {intg.category && (
                    <span className={clsx("inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium", CATEGORY_COLORS[intg.category] || "bg-gray-100 text-gray-600")}>
                      {intg.category}
                    </span>
                  )}
                </div>

                {intg.description && (
                  <p className="text-xs text-gray-500 line-clamp-2 flex-1">{intg.description}</p>
                )}

                <p className="text-xs text-gray-400">
                  {isConnected && totalTools > 0
                    ? `${enabledTools}/${totalTools} ${t("marketplace.toolsEnabled")}`
                    : `${totalTools} ${t("marketplace.toolsAvailable")}`}
                </p>

                <button
                  className={clsx(
                    "w-full py-2 rounded-xl text-sm font-medium transition",
                    isConnected
                      ? "bg-violet-50 text-violet-700 hover:bg-violet-100"
                      : "bg-violet-600 text-white hover:bg-violet-700 shadow-sm"
                  )}
                  onClick={(e) => { e.stopPropagation(); router.push(`/integrations/${intg.slug}`); }}
                >
                  {isConnected ? t("marketplace.manage") : t("marketplace.connect")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
