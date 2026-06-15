"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getMarketplaceIntegrations,
  connectIntegration,
  testIntegration,
  getIntegrationTools,
  toggleIntegrationTool,
  toggleAgentTool,
} from "@/lib/api";
import clsx from "clsx";

// ─── Constants ─────────────────────────────────────────────
const RISK_BADGE: Record<string, string> = {
  LOW: "bg-green-100 text-green-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
};

const CATEGORY_BADGE: Record<string, string> = {
  READ: "bg-blue-100 text-blue-700",
  WRITE: "bg-violet-100 text-violet-700",
  DELETE: "bg-red-100 text-red-700",
  ACTION: "bg-orange-100 text-orange-700",
};

const INTEGRATION_LOGOS: Record<string, string> = {
  shopify: "https://cdn.worldvectorlogo.com/logos/shopify.svg",
  woocommerce: "https://cdn.worldvectorlogo.com/logos/woocommerce.svg",
  stripe: "https://cdn.worldvectorlogo.com/logos/stripe-4.svg",
  paypal: "https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png",
  hubspot: "https://cdn.worldvectorlogo.com/logos/hubspot.svg",
  salesforce: "https://cdn.worldvectorlogo.com/logos/salesforce-2.svg",
  zendesk: "https://cdn.worldvectorlogo.com/logos/zendesk.svg",
  google_calendar: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v13/192px.svg",
};

const MARKETPLACE_CATEGORIES = [
  { label: "All", value: "All" },
  { label: "E-Commerce", value: "ECOMMERCE" },
  { label: "CRM", value: "CRM" },
  { label: "Payments", value: "PAYMENTS" },
  { label: "Helpdesk", value: "HELPDESK" },
  { label: "Communication", value: "COMMUNICATION" },
  { label: "Analytics", value: "ANALYTICS" },
];

// ─── Types ─────────────────────────────────────────────────
interface IntegrationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onIntegrationConnected?: (integration: any) => void;
  onToolsChanged?: (tools: any[]) => void;
  /**
   * When set, tool toggles also persist a per-agent permission
   * (`AgentToolPermission`) for this AI agent - required for the agent's
   * bot to actually see the tool. Without this, toggles only flip the
   * tenant-level `TenantTool.isEnabled` and the bot's tool surface stays
   * unchanged for this specific agent.
   */
  aiAgentId?: string;
}

type DrawerView = "list" | "detail";

// ─── Component ─────────────────────────────────────────────
export default function IntegrationDrawer({ isOpen, onClose, onIntegrationConnected, onToolsChanged, aiAgentId }: IntegrationDrawerProps) {
  const { token } = useAuth();
  const { t } = useI18n();

  // List view state
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  // Detail view state
  const [view, setView] = useState<DrawerView>("list");
  const [selected, setSelected] = useState<any>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [credError, setCredError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tools, setTools] = useState<any[]>([]);

  useEffect(() => {
    if (!isOpen || !token) return;
    setLoading(true);
    getMarketplaceIntegrations(token)
      .then((res) => setIntegrations(res.data || []))
      .catch(() => setIntegrations([]))
      .finally(() => setLoading(false));
  }, [isOpen, token]);

  function openDetail(intg: any) {
    setSelected(intg);
    setView("detail");
    setCredentials({});
    setCredError(null);
    setTestResult(null);
    setTools([]);
    // Load tools if already connected. In agent context, ask the backend
    // to also include each tool's per-agent permission state - so the
    // toggle reflects what THIS agent can use, not what the tenant has
    // installed.
    const ti = intg.tenantConnection;
    if (ti?.status === "CONNECTED" && token) {
      getIntegrationTools(token, intg.slug, aiAgentId ? { aiAgentId } : undefined)
        .then((res) => setTools(res.data || []))
        .catch(() => {});
    }
  }

  function backToList() {
    setView("list");
    setSelected(null);
    setCredentials({});
    setCredError(null);
    setTestResult(null);
    // Reload integrations to get updated status
    if (token) {
      getMarketplaceIntegrations(token)
        .then((res) => setIntegrations(res.data || []))
        .catch(() => {});
    }
  }

  async function handleConnect() {
    if (!token || !selected) return;
    setCredError(null);
    const authSchema = selected.authSchema || {};
    const credFields = authSchema.fields || (selected.authType === "API_KEY" ? [{ key: "apiKey", label: "API Key", required: true }] : []);
    for (const f of credFields) {
      if (f.required && !credentials[f.key]) {
        setCredError(`${f.label} is required`);
        return;
      }
    }
    setConnecting(true);
    try {
      await connectIntegration(token, selected.slug, credentials);
      setCredentials({});
      // Reload integration detail
      const res = await getMarketplaceIntegrations(token);
      const updated = (res.data || []).find((i: any) => i.slug === selected.slug);
      setIntegrations(res.data || []);
      if (updated) {
        setSelected(updated);
        // Load tools (with per-agent permission overlay if in agent context)
        const toolsRes = await getIntegrationTools(token, selected.slug, aiAgentId ? { aiAgentId } : undefined);
        setTools(toolsRes.data || []);
      }
      onIntegrationConnected?.(updated || selected);
    } catch (e: any) {
      setCredError(e.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  }

  async function handleTest() {
    if (!token || !selected) return;
    setTesting(true);
    setTestResult(null);
    try {
      await testIntegration(token, selected.slug);
      setTestResult({ ok: true, msg: t("marketplace.connectionSuccess") });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.message || t("marketplace.connectionFailed") });
    } finally {
      setTesting(false);
    }
  }

  async function handleToggleTool(toolSlug: string, currentlyEnabled: boolean) {
    if (!token || !selected) return;
    const target = !currentlyEnabled;

    // Optimistic update - flip whichever layer the toggle reflects in this
    // mode (agent permission in agent mode, tenant tool in marketplace).
    const updatedTools = tools.map((t) => {
      if (t.slug !== toolSlug) return t;
      if (aiAgentId) {
        return {
          ...t,
          agentPermission: { ...(t.agentPermission || {}), isAllowed: target },
        };
      }
      return { ...t, tenantTool: { ...t.tenantTool, isEnabled: target } };
    });
    setTools(updatedTools);
    onToolsChanged?.(updatedTools);

    try {
      if (aiAgentId) {
        // Agent mode. Toggle ON: ensure tenant tool exists/enabled (so the
        // bot's join through tenantTool.isEnabled passes) AND grant the
        // per-agent permission. Toggle OFF: revoke the agent permission
        // only - leave tenant state alone so other agents aren't affected.
        const targetTool = updatedTools.find((t) => t.slug === toolSlug);
        let tenantToolId: string | undefined = targetTool?.tenantTool?.id;

        if (target) {
          // Make sure the underlying TenantTool is enabled.
          const tenantAlreadyEnabled = !!targetTool?.tenantTool?.isEnabled;
          if (!tenantToolId || !tenantAlreadyEnabled) {
            const tenantRes: any = await toggleIntegrationTool(token, selected.slug, toolSlug, true);
            tenantToolId = tenantRes?.data?.id || tenantToolId;
            // Reflect tenant state in local list so OFF later doesn't think it needs to enable again.
            const synced = updatedTools.map((t) =>
              t.slug === toolSlug
                ? { ...t, tenantTool: { ...(t.tenantTool || {}), id: tenantToolId, isEnabled: true } }
                : t,
            );
            setTools(synced);
          }
          if (!tenantToolId) throw new Error("could not resolve tenantTool id");
          await toggleAgentTool(token, aiAgentId, tenantToolId, true);
        } else {
          if (!tenantToolId) {
            // Nothing to revoke - agent never had a permission row.
            return;
          }
          await toggleAgentTool(token, aiAgentId, tenantToolId, false);
        }
      } else {
        // Marketplace mode - original behaviour: flip tenant tool.
        await toggleIntegrationTool(token, selected.slug, toolSlug, target);
      }
    } catch {
      // Revert on failure
      const reverted = tools.map((t) => {
        if (t.slug !== toolSlug) return t;
        if (aiAgentId) {
          return {
            ...t,
            agentPermission: { ...(t.agentPermission || {}), isAllowed: currentlyEnabled },
          };
        }
        return { ...t, tenantTool: { ...t.tenantTool, isEnabled: currentlyEnabled } };
      });
      setTools(reverted);
      onToolsChanged?.(reverted);
    }
  }

  const filtered = integrations.filter((intg) => {
    const matchSearch = !search || intg.name?.toLowerCase().includes(search.toLowerCase()) || intg.description?.toLowerCase().includes(search.toLowerCase());
    const matchCat = activeCategory === "All" || intg.category === activeCategory;
    return matchSearch && matchCat;
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ms-auto w-full max-w-[520px] bg-white h-full flex flex-col shadow-2xl animate-slide-in-right">

        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
          {view === "detail" && (
            <button onClick={backToList} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-gray-900">
              {view === "list" ? t("aiStudio.tools.connectNew") : selected?.name}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {view === "list" ? t("aiStudio.tools.connectNewSub") : selected?.description?.slice(0, 80)}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {view === "list" ? (
            <ListView
              integrations={filtered}
              loading={loading}
              search={search}
              setSearch={setSearch}
              activeCategory={activeCategory}
              setActiveCategory={setActiveCategory}
              onSelect={openDetail}
              t={t}
            />
          ) : (
            <DetailView
              integration={selected}
              credentials={credentials}
              setCredentials={setCredentials}
              credError={credError}
              connecting={connecting}
              testing={testing}
              testResult={testResult}
              tools={tools}
              onConnect={handleConnect}
              onTest={handleTest}
              onToggleTool={handleToggleTool}
              onDone={() => { backToList(); onClose(); }}
              t={t}
              aiAgentId={aiAgentId}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── List View ─────────────────────────────────────────────
function ListView({
  integrations, loading, search, setSearch, activeCategory, setActiveCategory, onSelect, t,
}: {
  integrations: any[]; loading: boolean; search: string; setSearch: (s: string) => void;
  activeCategory: string; setActiveCategory: (c: string) => void; onSelect: (intg: any) => void;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("marketplace.search")}
          className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
        />
      </div>

      {/* Categories */}
      <div className="flex gap-1.5 flex-wrap">
        {MARKETPLACE_CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            onClick={() => setActiveCategory(cat.value)}
            className={clsx(
              "px-3 py-1 rounded-full text-xs font-medium transition",
              activeCategory === cat.value ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      ) : integrations.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">{t("common.noResults")}</p>
      ) : (
        <div className="space-y-2">
          {integrations.map((intg) => {
            const ti = intg.tenantConnection;
            const isConnected = ti?.status === "CONNECTED";
            const totalTools = intg.catalogTools?.length || 0;
            const logoSrc = intg.logoUrl || INTEGRATION_LOGOS[intg.slug] || null;
            return (
              <button
                key={intg.id || intg.slug}
                onClick={() => onSelect(intg)}
                className="w-full text-start p-4 rounded-xl border border-gray-100 hover:border-violet-200 hover:bg-violet-50/30 transition flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-xl bg-white border border-gray-200 flex items-center justify-center overflow-hidden shrink-0">
                  {logoSrc ? (
                    <img src={logoSrc} alt={intg.name} className="w-7 h-7 object-contain" />
                  ) : (
                    <span className="text-sm font-bold text-gray-500">{(intg.name || "?").charAt(0)}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{intg.name}</span>
                    {isConnected && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700">Connected</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 truncate mt-0.5">{intg.description}</p>
                </div>
                <div className="text-xs text-gray-400 shrink-0">
                  {totalTools} {t("aiStudio.team.skills").toLowerCase()}
                </div>
                <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Detail View ───────────────────────────────────────────
function DetailView({
  integration, credentials, setCredentials, credError, connecting, testing, testResult, tools,
  onConnect, onTest, onToggleTool, onDone, t, aiAgentId,
}: {
  integration: any; credentials: Record<string, string>; setCredentials: (c: Record<string, string>) => void;
  credError: string | null; connecting: boolean; testing: boolean; testResult: { ok: boolean; msg: string } | null;
  tools: any[]; onConnect: () => void; onTest: () => void; onToggleTool: (slug: string, enabled: boolean) => void;
  onDone: () => void; t: (key: string) => string; aiAgentId?: string;
}) {
  const ti = integration?.tenantConnection;
  const isConnected = ti?.status === "CONNECTED";
  const authSchema = integration?.authSchema || {};
  const credFields = authSchema.fields || (integration?.authType === "API_KEY" ? [{ key: "apiKey", label: t("marketplace.apiKey"), type: "password", required: true }] : []);
  const logoSrc = integration?.logoUrl || INTEGRATION_LOGOS[integration?.slug] || null;

  return (
    <div className="space-y-5">
      {/* Integration header */}
      <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl">
        <div className="w-12 h-12 rounded-xl bg-white border border-gray-200 flex items-center justify-center overflow-hidden shrink-0">
          {logoSrc ? (
            <img src={logoSrc} alt={integration.name} className="w-8 h-8 object-contain" />
          ) : (
            <span className="text-lg font-bold text-gray-500">{(integration.name || "?").charAt(0)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-semibold text-gray-900">{integration.name}</h4>
            <span className={clsx(
              "px-2 py-0.5 rounded-full text-[10px] font-semibold",
              isConnected ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
            )}>
              {isConnected ? "Connected" : "Not connected"}
            </span>
          </div>
          {integration.category && (
            <span className="text-xs text-gray-400">{integration.category}</span>
          )}
        </div>
      </div>

      {/* Credential form (if not connected) */}
      {!isConnected && (
        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-gray-700">{t("marketplace.credentials")}</h4>

          {integration.authType === "OAUTH2" ? (
            <div className="p-4 bg-blue-50 rounded-xl">
              <p className="text-sm text-blue-700">This integration uses OAuth 2.0. Click below to authorize.</p>
              <button className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition">
                Connect with OAuth
              </button>
            </div>
          ) : (
            <>
              {credFields.map((field: any) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  <input
                    type={field.type === "password" ? "password" : "text"}
                    value={credentials[field.key] || ""}
                    onChange={(e) => setCredentials({ ...credentials, [field.key]: e.target.value })}
                    placeholder={field.type === "password" ? "••••••••••••" : `Enter ${field.label}`}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                  />
                </div>
              ))}

              {credError && <p className="text-xs text-red-500">{credError}</p>}

              <div className="flex items-center gap-3">
                <button
                  onClick={onConnect}
                  disabled={connecting}
                  className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50"
                >
                  {connecting && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {t("marketplace.saveConnect")}
                </button>
                <button
                  onClick={onTest}
                  disabled={testing}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
                >
                  {testing ? t("marketplace.testing") : t("marketplace.testConnection")}
                </button>
              </div>

              {testResult && (
                <p className={clsx("text-xs font-medium", testResult.ok ? "text-green-600" : "text-red-500")}>
                  {testResult.msg}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Tools section (when connected) */}
      {isConnected && tools.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-700">{t("marketplace.availableTools")}</h4>
          {tools.map((tool) => {
            // In agent mode, the toggle reflects whether THIS agent has
            // permission for the tool - not whether the tenant has it
            // installed. Falls back to tenant state when not in agent mode.
            const enabled = aiAgentId
              ? (tool.agentPermission?.isAllowed ?? false)
              : (tool.tenantTool?.isEnabled ?? false);
            return (
              <div
                key={tool.id || tool.slug}
                className={clsx(
                  "flex items-start gap-3 p-3 rounded-xl border transition",
                  enabled ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50/50 opacity-70"
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-gray-900">{tool.name}</span>
                    {tool.category && (
                      <span className={clsx("px-1.5 py-0.5 rounded-full text-[10px] font-medium", CATEGORY_BADGE[tool.category] || "bg-gray-100 text-gray-600")}>
                        {tool.category}
                      </span>
                    )}
                    {tool.riskLevel && (
                      <span className={clsx("px-1.5 py-0.5 rounded-full text-[10px] font-medium", RISK_BADGE[tool.riskLevel] || "bg-gray-100 text-gray-600")}>
                        {tool.riskLevel}
                      </span>
                    )}
                  </div>
                  {tool.description && <p className="text-xs text-gray-400 mt-0.5">{tool.description}</p>}
                </div>
                <button
                  onClick={() => onToggleTool(tool.slug, enabled)}
                  className={clsx("relative w-9 h-5 rounded-full transition-colors shrink-0", enabled ? "bg-violet-600" : "bg-gray-300")}
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
                    style={{ transform: enabled ? "translateX(16px)" : "translateX(0)" }}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Done button when connected */}
      {isConnected && (
        <button
          onClick={onDone}
          className="w-full py-3 bg-violet-600 text-white text-sm font-semibold rounded-xl hover:bg-violet-700 transition shadow-sm"
        >
          {t("common.done")}
        </button>
      )}
    </div>
  );
}
