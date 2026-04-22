"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getMarketplaceIntegration,
  connectIntegration,
  testIntegration,
  disconnectIntegration,
  updateIntegrationCredentials,
  getIntegrationTools,
  toggleIntegrationTool,
  initIntegrationOAuth,
} from "@/lib/api";
import clsx from "clsx";

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

const STATUS_BADGE: Record<string, string> = {
  CONNECTED: "bg-green-100 text-green-700",
  PENDING: "bg-yellow-100 text-yellow-700",
  TESTING: "bg-blue-100 text-blue-700",
  ERROR: "bg-red-100 text-red-700",
  DISCONNECTED: "bg-gray-100 text-gray-600",
};

const INTEGRATION_LOGOS: Record<string, string> = {
  shopify: "https://cdn.worldvectorlogo.com/logos/shopify.svg",
  woocommerce: "https://cdn.worldvectorlogo.com/logos/woocommerce.svg",
  bigcommerce: "https://cdn.worldvectorlogo.com/logos/bigcommerce-1.svg",
  magento: "https://cdn.worldvectorlogo.com/logos/magento.svg",
  wix: "https://cdn.worldvectorlogo.com/logos/wix.svg",
  shippo: "https://cdn.prod.website-files.com/64700b7f349828a5b8dc81ab/6720117f8561f9ad587b820e_AD_4nXewExxEHFrSDaVcyUsSBCZxMRLDfuZ3SYABIbGEikcH_3jFJsGRLXAAkPSeRsqBtlQ-tY89qW1qtX3rzZQ_qmt7hzOrNLQHdu2BOyIeEjIYliByLM5FwYgB0IMD-K46n9wKX6NFbKRsmT845rfmGYcGhQ5X.gif",
  easyship: "https://cdn.shopify.com/app-store/listing_images/7857972f1c70c4384cd3d0e61c5284c1/icon/CLPUja--4IMDEAE=.png",
  shipstation: "https://www.shipstation.com/wp-content/uploads/2024/10/ShipStation-BlogLaunch-Logo-2-1024x427.png",
  aftership: "https://aftership.ghost.io/content/images/2023/01/YouTube-avatar-2.png",
  stripe: "https://cdn.worldvectorlogo.com/logos/stripe-4.svg",
  paypal: "https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png",
  square: "https://messenger-assets.qualified.com/uploads/7ujZqmvzoStw2DuEbeUvSkS2tNDMnum1bcHPM/c55336256d47abdd4b160b28e0535a57ccebff58605da5199d39e3af3b55fe3d.png",
  hubspot: "https://cdn.worldvectorlogo.com/logos/hubspot.svg",
  salesforce: "https://cdn.worldvectorlogo.com/logos/salesforce-2.svg",
  pipedrive: "https://cdn.worldvectorlogo.com/logos/pipedrive.svg",
  zoho_crm: "https://cdn.worldvectorlogo.com/logos/zoho-1.svg",
  zendesk: "https://cdn.worldvectorlogo.com/logos/zendesk.svg",
  intercom: "https://cdn.worldvectorlogo.com/logos/intercom-2.svg",
  monday: "https://cdn.worldvectorlogo.com/logos/monday-1.svg",
  google_calendar: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v13/192px.svg",
  calendly: "https://calendly.com/media/favicon/icon-144x144.png",
  slack: "https://cdn.worldvectorlogo.com/logos/slack-new-logo.svg",
  google_analytics: "https://cdn.worldvectorlogo.com/logos/google-analytics-4.svg",
  postgresql: "https://cdn.worldvectorlogo.com/logos/postgresql.svg",
  mongodb: "https://cdn.worldvectorlogo.com/logos/mongodb-icon-1.svg",
  aws_rds: "https://cdn.worldvectorlogo.com/logos/aws-rds.svg",
  mongo_atlas: "https://cdn.worldvectorlogo.com/logos/mongodb-icon-1.svg",
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

export default function IntegrationDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { token } = useAuth();
  const { t } = useI18n();

  const [integration, setIntegration] = useState<any>(null);
  const [tools, setTools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [editingCreds, setEditingCreds] = useState(false);

  // Credential form state
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [credError, setCredError] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const [intgRes, toolsRes] = await Promise.all([
        getMarketplaceIntegration(token, slug),
        getIntegrationTools(token, slug),
      ]);
      setIntegration(intgRes.data);
      setTools(toolsRes.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [token, slug]);

  const ti = integration?.tenantConnection;
  const isConnected = ti?.status === "CONNECTED";
  const status = ti?.status || "DISCONNECTED";

  // Build credential fields from authSchema
  const authSchema = integration?.authSchema || {};
  const credFields: Array<{ key: string; label: string; type: string; required: boolean }> =
    authSchema.fields || (integration?.authType === "API_KEY" ? [{ key: "apiKey", label: t("marketplace.apiKey"), type: "password", required: true }] : []);

  async function handleConnect() {
    if (!token) return;
    setCredError(null);
    // Validate required fields
    for (const f of credFields) {
      if (f.required && !credentials[f.key]) {
        setCredError(`${f.label} is required`);
        return;
      }
    }
    setConnecting(true);
    try {
      await connectIntegration(token, slug, credentials);
      setCredentials({});
      await load();
    } catch (e: any) {
      setCredError(e.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  }

  async function handleUpdateCredentials() {
    if (!token) return;
    setCredError(null);
    setConnecting(true);
    try {
      await updateIntegrationCredentials(token, slug, credentials);
      setEditingCreds(false);
      setCredentials({});
      await load();
    } catch (e: any) {
      setCredError(e.message || "Failed to update credentials");
    } finally {
      setConnecting(false);
    }
  }

  async function handleTest() {
    if (!token) return;
    setTesting(true);
    setTestResult(null);
    try {
      await testIntegration(token, slug);
      setTestResult({ ok: true, msg: t("marketplace.connectionSuccess") });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.message || t("marketplace.connectionFailed") });
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    if (!token) return;
    setDisconnecting(true);
    try {
      await disconnectIntegration(token, slug);
      await load();
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleToggleTool(toolSlug: string, current: boolean) {
    if (!token) return;
    const next = !current;
    setTools((prev) =>
      prev.map((t) =>
        t.slug === toolSlug
          ? { ...t, tenantTool: { ...(t.tenantTool || {}), isEnabled: next } }
          : t
      )
    );
    try {
      await toggleIntegrationTool(token, slug, toolSlug, next);
    } catch {
      // revert
      setTools((prev) =>
        prev.map((t) =>
          t.slug === toolSlug
            ? { ...t, tenantTool: { ...(t.tenantTool || {}), isEnabled: current } }
            : t
        )
      );
    }
  }

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-8 h-8 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  if (!integration) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen text-gray-400">Integration not found.</div>
      </AppLayout>
    );
  }

  const logoSrc = integration.logoUrl || INTEGRATION_LOGOS[slug] || null;
  const logoColor = getLogoColor(integration.name || "");
  const usedByDepts = integration._count?.agentToolPermissions || 0;

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Back */}
        <button
          onClick={() => router.push("/integrations")}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm mb-5 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {t("common.back")}
        </button>

        <div className="max-w-3xl space-y-5">
          {/* Header card */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <div className="flex items-start gap-4">
              <div className={clsx("w-16 h-16 rounded-2xl flex items-center justify-center shrink-0", logoSrc ? "bg-white border border-gray-100 p-2" : `${logoColor} text-white font-bold text-2xl`)}>
                {logoSrc ? (
                  <img src={logoSrc} alt={integration.name} className="w-full h-full object-contain" />
                ) : (
                  (integration.name || "?").charAt(0).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h1 className="text-xl font-bold text-gray-900">{integration.name}</h1>
                    {integration.category && (
                      <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                        {integration.category}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {integration.authType && (
                      <span className={clsx("px-2.5 py-1 rounded-full text-xs font-medium border",
                        integration.authType === "OAUTH2" ? "bg-blue-50 text-blue-600 border-blue-200" :
                        integration.authType === "BASIC_AUTH" ? "bg-gray-50 text-gray-600 border-gray-200" :
                        "bg-amber-50 text-amber-600 border-amber-200"
                      )}>
                        {integration.authType === "OAUTH2" ? "OAuth" : integration.authType === "BASIC_AUTH" ? "Basic Auth" : "API Key"}
                      </span>
                    )}
                    <span className={clsx("px-3 py-1 rounded-full text-xs font-semibold", STATUS_BADGE[status] || STATUS_BADGE.DISCONNECTED)}>
                      {status}
                    </span>
                  </div>
                </div>
                {integration.description && (
                  <p className="text-sm text-gray-500 mt-2">{integration.description}</p>
                )}
              </div>
            </div>

            {/* Actions */}
            {isConnected && (
              <div className="flex items-center gap-3 mt-4 pt-4 border-t border-gray-100 flex-wrap">
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
                >
                  {testing ? (
                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                    </svg>
                  )}
                  {testing ? t("marketplace.testing") : t("marketplace.testConnection")}
                </button>
                <button
                  onClick={() => setEditingCreds(!editingCreds)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                  </svg>
                  {t("common.edit")} {t("marketplace.credentials")}
                </button>
                <button
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 transition disabled:opacity-50 ml-auto"
                >
                  {disconnecting ? (
                    <div className="w-4 h-4 border-2 border-red-200 border-t-red-500 rounded-full animate-spin" />
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  )}
                  {t("marketplace.disconnect")}
                </button>
                {testResult && (
                  <p className={clsx("text-xs font-medium", testResult.ok ? "text-green-600" : "text-red-500")}>
                    {testResult.msg}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Connect / Edit Credentials */}
          {(!isConnected || editingCreds) && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h2 className="font-semibold text-gray-900 mb-4">
                {editingCreds ? `${t("common.edit")} ${t("marketplace.credentials")}` : t("marketplace.connect")}
              </h2>

              {/* OAUTH2 branch */}
              {integration.authType === "OAUTH2" && !editingCreds ? (
                <div className="space-y-3">
                  <p className="text-sm text-gray-500">
                    This integration uses OAuth 2.0. Click below to authorize access.
                  </p>
                  <button
                    onClick={async () => {
                      if (!token) return;
                      try {
                        const { url } = await initIntegrationOAuth(token, slug);
                        window.location.href = url;
                      } catch (err: any) {
                        setTestResult({ ok: false, msg: err?.message || "OAuth init failed — check ZOHO_CLIENT_ID/SECRET/REDIRECT_URI on the server." });
                      }
                    }}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                    Connect with OAuth
                  </button>
                  {testResult && (
                    <p className={clsx("text-xs font-medium", testResult.ok ? "text-green-600" : "text-amber-600")}>
                      {testResult.msg}
                    </p>
                  )}
                </div>
              ) : (
                /* API_KEY / BASIC_AUTH dynamic form */
                <div className="space-y-4">
                  {credFields.length > 0 ? (
                    credFields.map((field) => (
                      <div key={field.key}>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-1">*</span>}
                        </label>
                        <input
                          type={field.type === "password" ? "password" : field.type || "text"}
                          value={credentials[field.key] || ""}
                          onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.type === "password" ? "••••••••••••" : `Enter ${field.label}`}
                          className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                        />
                      </div>
                    ))
                  ) : (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("marketplace.apiKey")} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="password"
                        value={credentials["apiKey"] || ""}
                        onChange={(e) => setCredentials({ apiKey: e.target.value })}
                        placeholder="••••••••••••"
                        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                      />
                    </div>
                  )}

                  {credError && (
                    <p className="text-xs text-red-500">{credError}</p>
                  )}

                  <div className="flex items-center gap-3">
                    {!editingCreds && (
                      <button
                        onClick={handleTest}
                        disabled={testing}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
                      >
                        {testing ? (
                          <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                        ) : null}
                        {testing ? t("marketplace.testing") : t("marketplace.testConnection")}
                      </button>
                    )}
                    <button
                      onClick={editingCreds ? handleUpdateCredentials : handleConnect}
                      disabled={connecting}
                      className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50"
                    >
                      {connecting && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                      {editingCreds ? t("marketplace.saveCredentials") : t("marketplace.saveConnect")}
                    </button>
                    {editingCreds && (
                      <button
                        onClick={() => { setEditingCreds(false); setCredentials({}); setCredError(null); }}
                        className="px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm transition"
                      >
                        {t("common.cancel")}
                      </button>
                    )}
                  </div>
                  {testResult && !editingCreds && (
                    <p className={clsx("text-xs font-medium", testResult.ok ? "text-green-600" : "text-red-500")}>
                      {testResult.msg}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tools section */}
          {isConnected && tools.length > 0 && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h2 className="font-semibold text-gray-900 mb-4">{t("marketplace.availableTools")}</h2>
              <div className="space-y-3">
                {tools.map((tool) => {
                  const enabled = tool.tenantTool?.isEnabled ?? false;
                  return (
                    <div
                      key={tool.id || tool.slug}
                      className={clsx(
                        "flex items-start gap-4 p-4 rounded-xl border transition",
                        enabled ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50/50 opacity-70"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm text-gray-900">{tool.name}</span>
                          {tool.category && (
                            <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", CATEGORY_BADGE[tool.category] || "bg-gray-100 text-gray-600")}>
                              {t(`marketplace.category${tool.category.charAt(0) + tool.category.slice(1).toLowerCase()}`)}
                            </span>
                          )}
                          {tool.riskLevel && (
                            <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", RISK_BADGE[tool.riskLevel] || "bg-gray-100 text-gray-600")}>
                              {t(`marketplace.risk${tool.riskLevel.charAt(0) + tool.riskLevel.slice(1).toLowerCase()}`)}
                            </span>
                          )}
                        </div>
                        {tool.description && (
                          <p className="text-xs text-gray-500 mt-1">{tool.description}</p>
                        )}
                      </div>
                      {/* Toggle */}
                      <button
                        onClick={() => handleToggleTool(tool.slug, enabled)}
                        className={clsx("relative w-10 h-6 rounded-full transition-colors shrink-0 mt-0.5", enabled ? "bg-violet-600" : "bg-gray-200")}
                      >
                        <div className={clsx("absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform", enabled ? "left-auto right-0.5" : "left-0.5")} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Footer */}
          {usedByDepts > 0 && (
            <p className="text-xs text-gray-400 text-center pb-4">
              {t("marketplace.usedByDepartments").replace("{count}", String(usedByDepts))}
            </p>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
