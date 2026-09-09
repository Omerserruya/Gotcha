"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { usePermissions } from "@/context/PermissionsContext";
import {
  getMarketplaceIntegration,
  connectIntegration,
  testIntegration,
  disconnectIntegration,
  updateIntegrationCredentials,
  getIntegrationTools,
  toggleIntegrationTool,
  initIntegrationOAuth,
  listPostgresTables,
  listMongoCollections,
  listRdsTables,
} from "@/lib/api";
import CustomApiToolsSection from "@/components/CustomApiToolsSection";
import CustomDbToolsSection from "@/components/CustomDbToolsSection";
import { AirtableMappingCard } from "@/components/integrations/AirtableMappingCard";
import clsx from "clsx";
import { beginConnect, connectHelpText, connectButtonLabel, connectErrorMessage } from "@/lib/shopify-connect";

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

// The provider connect/config surface, reusable across hosts. Settings →
// Business Systems renders it with a Settings backHref + the
// `settings_business_systems` OAuth flow so the ENTIRE connection round-trip
// (including the OAuth redirect) stays inside Settings and never bounces to the
// AI Studio marketplace. The AI Studio marketplace renders it with defaults.
export function IntegrationDetail({
  slug,
  backHref = "/integrations",
  oauthFlow,
  withLayout = true,
  connectPerm = "integrations:connections:connect",
  disconnectPerm = "integrations:connections:disconnect",
}: {
  slug: string;
  backHref?: string;
  oauthFlow?: string;
  withLayout?: boolean;
  /** Permission gating the connect/re-auth/credential actions. The host picks
   *  its domain: marketplace = integrations:*, Settings = business-systems:*.
   *  The backend routes enforce the same keys regardless of the UI. */
  connectPerm?: string;
  disconnectPerm?: string;
}) {
  const router = useRouter();
  const { token } = useAuth();
  const { t } = useI18n();
  const { can } = usePermissions();
  const canConnect = can(connectPerm);
  const canDisconnect = can(disconnectPerm);
  // Host-controlled chrome: the marketplace route wants AppLayout; a Settings
  // nested route already has the Settings shell, so it opts out.
  const Wrap: any = withLayout ? AppLayout : ({ children }: any) => <>{children}</>;

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
  const [config, setConfig] = useState<Record<string, any>>({});
  const [credError, setCredError] = useState<string | null>(null);

  // Read-only mirror of config.useAsCrm - the toggle itself lives in
  // Settings → Integrations; this page only reflects the resulting state.
  const [useAsCrm, setUseAsCrm] = useState(false);

  // DB schema introspection (postgres / mongodb / aws_rds)
  const [dbObjects, setDbObjects] = useState<Array<{ name: string; qualified: string }>>([]);
  const [dbObjectsLoading, setDbObjectsLoading] = useState(false);
  const [dbObjectsError, setDbObjectsError] = useState<string | null>(null);

  const DB_SLUGS = new Set(["postgresql", "mongodb", "aws_rds"]);
  const isDbProvider = DB_SLUGS.has(slug);

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const [intgRes, toolsRes] = await Promise.all([
        getMarketplaceIntegration(token, slug),
        getIntegrationTools(token, slug),
      ]);
      // Defensive fallback for `custom_api`: if the catalog row is missing
      // from the user's DB (e.g. marketplace migration not yet applied),
      // synthesize a virtual integration so the Custom API tool builder
      // is still reachable. The builder is fully tenant-defined and has
      // no catalog dependencies at runtime.
      let intg = intgRes.data;
      if (!intg && slug === "custom_api") {
        intg = {
          slug: "custom_api",
          name: "Custom API",
          description: "Define your own HTTP tools - Postman-style request builder. Each tool exposes one API call to the AI as custom.<slug>.",
          category: "CUSTOM",
          authType: "CUSTOM",
          authSchema: {},
          configSchema: {},
        };
      }
      setIntegration(intg);
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

  // Sync the CRM-source toggle from the loaded connection config.
  useEffect(() => {
    setUseAsCrm(((integration?.tenantConnection?.config as any)?.useAsCrm) === true);
  }, [integration]);

  const ti = integration?.tenantConnection;
  const isConnected = ti?.status === "CONNECTED";
  const status = ti?.status || "DISCONNECTED";

  // Build credential fields from authSchema. Per-provider fallbacks below
  // protect against stale catalog rows (e.g. an old marketplace migration
  // where Shopify is still API_KEY without the `shop` field) - without
  // them the OAuth init endpoint would 400 with shop_required.
  const authSchema = integration?.authSchema || {};
  let credFields: Array<{ key: string; label: string; type: string; required: boolean; placeholder?: string; helpText?: string }> =
    authSchema.fields || (integration?.authType === "API_KEY" ? [{ key: "apiKey", label: t("marketplace.apiKey"), type: "password", required: true }] : []);
  // Shopify takes NO pre-OAuth fields. It used to inject a "Shop domain" text
  // box here (and the catalog's authSchema may still carry one), because the
  // old init endpoint required a `shop` query parameter. Installation now
  // begins on a Shopify-owned page that identifies the store, so asking is
  // both unnecessary and forbidden by App Store requirement 2.3.1. The filter
  // is deliberately defensive: a stale catalog row must not be able to put the
  // field back.
  if (slug === "shopify") {
    credFields = credFields.filter((f) => f.key !== "shop" && f.key !== "apiKey");
  }
  // Shopify is OAuth-only - force the OAuth branch even if the catalog
  // still has the legacy API_KEY auth_type (older base migration).
  const effectiveAuthType: string = slug === "shopify" ? "OAUTH2" : (integration?.authType || "API_KEY");
  // Config fields (table allowlists, db name, default board, etc.) for providers that need post-connect setup.
  const configSchema = integration?.configSchema || {};
  const configFields: Array<{ key: string; label: string; type: string; required?: boolean; helpText?: string; options?: string[]; default?: any }> =
    configSchema.fields || [];

  async function handleConnect() {
    if (!token) return;
    setCredError(null);
    // Validate required fields (credentials + config)
    for (const f of credFields) {
      if (f.required && !credentials[f.key]) {
        setCredError(`${f.label} is required`);
        return;
      }
    }
    for (const f of configFields) {
      if (f.required && (config[f.key] === undefined || config[f.key] === "" || (Array.isArray(config[f.key]) && !config[f.key].length))) {
        setCredError(`${f.label} is required`);
        return;
      }
    }
    setConnecting(true);
    try {
      await connectIntegration(token, slug, credentials, config);
      setCredentials({});
      setConfig({});
      await load();
    } catch (e: any) {
      setCredError(e.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  }

  async function loadDbSchema() {
    if (!token || !isDbProvider) return;
    setDbObjectsError(null);
    setDbObjectsLoading(true);
    try {
      const connStr = credentials.connectionString || credentials.connection_string;
      if (slug === "postgresql") {
        const r = await listPostgresTables(token, { connectionString: connStr });
        setDbObjects((r.data || []).map((t) => ({ name: t.qualified, qualified: t.qualified })));
      } else if (slug === "mongodb") {
        const dbName = config.dbName || credentials.dbName;
        if (!dbName) { setDbObjectsError("Set Database Name first"); return; }
        const r = await listMongoCollections(token, { connectionString: connStr, dbName: String(dbName) });
        setDbObjects((r.data || []).map((c) => ({ name: c.name, qualified: c.name })));
      } else if (slug === "aws_rds") {
        const engine = (config.engine || "postgres") as "postgres" | "mysql" | "mariadb";
        const r = await listRdsTables(token, { connectionString: connStr, engine });
        setDbObjects((r.data || []).map((t) => ({ name: t.qualified, qualified: t.qualified })));
      }
    } catch (e: any) {
      setDbObjectsError(e?.message || "Failed to load schema");
      setDbObjects([]);
    } finally {
      setDbObjectsLoading(false);
    }
  }

  function toggleDbSelection(fieldKey: "allowReads" | "allowWrites", name: string) {
    setConfig((prev) => {
      const cur: string[] = Array.isArray(prev[fieldKey]) ? prev[fieldKey] : [];
      const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
      // Writes must be a subset of Reads - auto-add to reads when writing.
      if (fieldKey === "allowWrites" && !cur.includes(name)) {
        const reads: string[] = Array.isArray(prev.allowReads) ? prev.allowReads : [];
        if (!reads.includes(name)) {
          return { ...prev, allowWrites: next, allowReads: [...reads, name] };
        }
      }
      return { ...prev, [fieldKey]: next };
    });
  }

  async function handleUpdateCredentials() {
    if (!token) return;
    setCredError(null);
    setConnecting(true);
    try {
      await updateIntegrationCredentials(token, slug, credentials, Object.keys(config).length ? config : undefined);
      setEditingCreds(false);
      setCredentials({});
      setConfig({});
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
      <Wrap>
        <div className="flex items-center justify-center h-screen">
          <div className="w-8 h-8 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      </Wrap>
    );
  }

  if (!integration) {
    return (
      <Wrap>
        <div className="flex items-center justify-center h-screen text-gray-400">Integration not found.</div>
      </Wrap>
    );
  }

  const logoSrc = integration.logoUrl || INTEGRATION_LOGOS[slug] || null;
  const logoColor = getLogoColor(integration.name || "");
  const usedByDepts = integration._count?.agentToolPermissions || 0;

  return (
    <Wrap>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Back */}
        <button
          onClick={() => router.push(backHref)}
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
                        integration.authType === "CUSTOM" ? "bg-violet-50 text-violet-600 border-violet-200" :
                        "bg-amber-50 text-amber-600 border-amber-200"
                      )}>
                        {integration.authType === "OAUTH2" ? "OAuth" :
                          integration.authType === "BASIC_AUTH" ? "Basic Auth" :
                          integration.authType === "CUSTOM" ? "Per-tool" :
                          "API Key"}
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
                {canConnect && (
                <button
                  onClick={() => setEditingCreds(!editingCreds)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                  </svg>
                  {t("common.edit")} {t("marketplace.credentials")}
                </button>
                )}
                {canDisconnect && (
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
                )}
                {testResult && (
                  <p className={clsx("text-xs font-medium", testResult.ok ? "text-green-600" : "text-red-500")}>
                    {testResult.msg}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Connect / Edit Credentials - skipped for custom_api since each
              tenant-defined Custom API tool carries its own credentials,
              there is no central token to authorize against. */}
          {canConnect && slug !== "custom_api" && (!isConnected || editingCreds) && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <h2 className="font-semibold text-gray-900 mb-4">
                {editingCreds ? `${t("common.edit")} ${t("marketplace.credentials")}` : t("marketplace.connect")}
              </h2>

              {/* OAUTH2 branch - render for both first-time connect and
                  re-auth, otherwise providers like Shopify lose the
                  required `shop` field on the re-auth path and the
                  /oauth/init endpoint rejects the request as shop_required.
                  Uses effectiveAuthType so providers we KNOW are OAuth
                  (e.g. Shopify) still take this branch even when the
                  catalog row is stale. */}
              {effectiveAuthType === "OAUTH2" ? (
                <div className="space-y-3">
                  <p className="text-sm text-gray-500">
                    {connectHelpText(slug, Boolean(editingCreds) || isConnected)}
                  </p>
                  {/* Pre-OAuth fields - e.g. Shopify shop domain, Salesforce loginHost, Square environment */}
                  {credFields.length > 0 && (
                    <div className="space-y-3 pb-2">
                      {credFields.map((field) => (
                        <div key={field.key}>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            {field.label}
                            {field.required && <span className="text-red-500 ml-1">*</span>}
                          </label>
                          {(field as any).type === "select" && Array.isArray((field as any).options) ? (
                            <select
                              value={credentials[field.key] || (field as any).default || ""}
                              onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                            >
                              <option value="">Select…</option>
                              {(field as any).options.map((opt: string) => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={field.type === "password" ? "password" : (field as any).type === "url" ? "url" : "text"}
                              value={credentials[field.key] || ""}
                              onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                              placeholder={(field as any).placeholder || `Enter ${field.label}`}
                              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                            />
                          )}
                          {(field as any).helpText && (
                            <p className="text-xs text-gray-400 mt-1">{(field as any).helpText}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      if (!token) return;
                      // Validate required pre-OAuth fields
                      for (const f of credFields) {
                        if (f.required && !credentials[f.key]) {
                          setTestResult({ ok: false, msg: `${f.label} is required` });
                          return;
                        }
                      }
                      try {
                        // Carry the host's OAuth flow so the callback returns to
                        // the right place (e.g. Settings, not the marketplace).
                        // `beginConnect` decides install-vs-authorize; Shopify's
                        // first connect goes to Shopify, not to an authorize URL
                        // we built from a domain the merchant typed.
                        const url = await beginConnect({
                          token,
                          slug,
                          reauthorize: Boolean(editingCreds) || isConnected,
                          flow: oauthFlow || undefined,
                          params: credentials,
                        });
                        window.location.href = url;
                      } catch (err: any) {
                        setTestResult({ ok: false, msg: connectErrorMessage(slug, err) });
                      }
                    }}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                    {connectButtonLabel(slug, Boolean(editingCreds) || isConnected)}
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
                        {(field as any).type === "select" && Array.isArray((field as any).options) ? (
                          <select
                            value={credentials[field.key] || (field as any).default || ""}
                            onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                          >
                            <option value="">Select…</option>
                            {(field as any).options.map((opt: string) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={field.type === "password" ? "password" : field.type === "url" ? "url" : "text"}
                            value={credentials[field.key] || ""}
                            onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            placeholder={(field as any).placeholder || (field.type === "password" ? "••••••••••••" : `Enter ${field.label}`)}
                            className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                          />
                        )}
                        {(field as any).helpText && (
                          <p className="text-xs text-gray-400 mt-1">{(field as any).helpText}</p>
                        )}
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

                  {/* Config fields (table allowlists, db name, board, engine, etc.) */}
                  {configFields.length > 0 && (
                    <div className="pt-3 mt-3 border-t border-gray-100 space-y-3">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Configuration</h4>

                      {/* DB schema picker - for postgres / mongodb / aws_rds */}
                      {isDbProvider && (
                        <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium text-violet-900">Schema</p>
                              <p className="text-xs text-violet-700/80">Load tables from your database, then tick which ones the AI may read or write.</p>
                            </div>
                            <button
                              type="button"
                              onClick={loadDbSchema}
                              disabled={dbObjectsLoading || !(credentials.connectionString || credentials.connection_string)}
                              className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {dbObjectsLoading ? "Loading…" : dbObjects.length ? "Reload" : "Load tables"}
                            </button>
                          </div>
                          {dbObjectsError && <p className="text-xs text-red-600">{dbObjectsError}</p>}
                          {!dbObjects.length && !dbObjectsError && !dbObjectsLoading && (
                            <p className="text-xs text-violet-700/60">Paste a connection string above, then click <strong>Load tables</strong>.</p>
                          )}
                          {dbObjects.length > 0 && (() => {
                            const reads: string[] = Array.isArray(config.allowReads) ? config.allowReads : [];
                            const writes: string[] = Array.isArray(config.allowWrites) ? config.allowWrites : [];
                            const enabled = Array.from(new Set([...reads, ...writes]));
                            const tableNotes: Record<string, { description?: string; whenToUse?: string }> =
                              (config.tableNotes && typeof config.tableNotes === "object") ? config.tableNotes : {};
                            const setTableNote = (qualified: string, field: "description" | "whenToUse", v: string) => {
                              setConfig((prev) => ({
                                ...prev,
                                tableNotes: {
                                  ...((prev.tableNotes && typeof prev.tableNotes === "object") ? prev.tableNotes : {}),
                                  [qualified]: {
                                    ...(((prev.tableNotes || {}) as any)[qualified] || {}),
                                    [field]: v,
                                  },
                                },
                              }));
                            };
                            return (
                            <div className="space-y-3 pt-1">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {(["allowReads", "allowWrites"] as const).map((kind) => {
                                const selected: string[] = Array.isArray(config[kind]) ? config[kind] : [];
                                return (
                                  <div key={kind} className="rounded-lg border border-gray-200 bg-white p-2">
                                    <p className="text-xs font-semibold text-gray-700 mb-1.5 px-1">
                                      {kind === "allowReads" ? "AI may READ" : "AI may WRITE"}
                                      <span className="ml-2 text-gray-400 font-normal">{selected.length}/{dbObjects.length}</span>
                                    </p>
                                    <div className="max-h-48 overflow-y-auto space-y-0.5 pr-1">
                                      {dbObjects.map((obj) => (
                                        <label key={obj.qualified} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-gray-50 cursor-pointer text-xs">
                                          <input
                                            type="checkbox"
                                            checked={selected.includes(obj.qualified)}
                                            onChange={() => toggleDbSelection(kind, obj.qualified)}
                                            className="w-3.5 h-3.5 rounded text-violet-600 focus:ring-violet-200"
                                          />
                                          <span className="font-mono text-gray-700">{obj.qualified}</span>
                                        </label>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {enabled.length > 0 && (
                              <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
                                <p className="text-xs font-semibold text-gray-700">Per-table notes <span className="text-gray-400 font-normal">- help the AI pick the right table</span></p>
                                {enabled.map((qualified) => {
                                  const note = tableNotes[qualified] || {};
                                  return (
                                    <div key={qualified} className="space-y-1.5 pb-2 border-b border-gray-50 last:border-b-0 last:pb-0">
                                      <p className="text-xs font-mono text-violet-700">{qualified}</p>
                                      <input
                                        className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-md text-xs focus:ring-1 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none"
                                        value={note.description || ""}
                                        onChange={(e) => setTableNote(qualified, "description", e.target.value)}
                                        placeholder="Description - what this table holds (e.g. customer orders)"
                                      />
                                      <input
                                        className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-md text-xs focus:ring-1 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none"
                                        value={note.whenToUse || ""}
                                        onChange={(e) => setTableNote(qualified, "whenToUse", e.target.value)}
                                        placeholder="When to use - e.g. when the customer asks about an order"
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            </div>
                            );
                          })()}
                        </div>
                      )}

                      {configFields.map((field) => {
                        const ftype = (field as any).type || "text";
                        const value = config[field.key] ?? (field as any).default ?? (ftype === "text-list" ? [] : ftype === "number" ? "" : "");
                        // Suppress legacy text-list inputs for table allowlists when the DB picker is in use -
                        // those keys are already controlled by the checkbox grid above.
                        if (isDbProvider && (field.key === "allowReads" || field.key === "allowWrites") && dbObjects.length > 0) {
                          return null;
                        }
                        return (
                          <div key={field.key}>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {field.label}
                              {field.required && <span className="text-red-500 ml-1">*</span>}
                            </label>
                            {ftype === "select" && Array.isArray(field.options) ? (
                              <select
                                value={value}
                                onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                              >
                                <option value="">Select…</option>
                                {field.options.map((opt: string) => (<option key={opt} value={opt}>{opt}</option>))}
                              </select>
                            ) : ftype === "text-list" ? (
                              <input
                                type="text"
                                value={Array.isArray(value) ? value.join(", ") : String(value || "")}
                                onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))}
                                placeholder="comma-separated names"
                                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                              />
                            ) : ftype === "number" ? (
                              <input
                                type="number"
                                value={value}
                                onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.value === "" ? "" : Number(e.target.value) }))}
                                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                              />
                            ) : (
                              <input
                                type="text"
                                value={value}
                                onChange={(e) => setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                              />
                            )}
                            {(field as any).helpText && (
                              <p className="text-xs text-gray-400 mt-1">{(field as any).helpText}</p>
                            )}
                          </div>
                        );
                      })}
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

          {/* Airtable source-of-truth mapping - view, refresh the live field
              list, and edit which columns map to name/phone/email/stage.
              Before this card the mapping was write-once in onboarding. */}
          {slug === "airtable" && isConnected && <AirtableMappingCard />}

          {/* Custom API tool builder - always visible for the custom_api integration,
              regardless of connection state, since each tool is tenant-defined and
              self-contained (no central token to authorize). */}
          {slug === "custom_api" && <CustomApiToolsSection />}

          {/* Custom DB query tool builder - visible on Postgres / MongoDB / RDS
              integration pages (only after the underlying integration is CONNECTED,
              since the query runs through that integration's connection string). */}
          {isConnected && (slug === "postgresql" || slug === "mongodb" || slug === "aws_rds") && (
            <CustomDbToolsSection providerSlug={slug as "postgresql" | "mongodb" | "aws_rds"} />
          )}

          {/* The "use Shopify as my CRM" toggle used to live here. Electing the
              customer system of record is an account-level decision across all
              connected systems, not a property of this one vendor page, so it
              now lives in Settings → Integrations (CustomerSystemOfRecordCard).
              The marketplace stays about browsing and connecting. */}
          {slug === "shopify" && isConnected && useAsCrm && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <div className="flex items-center gap-3">
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200 shrink-0">
                  {t("marketplace.systemOfRecordActive")}
                </span>
                <Link href="/settings/business-systems" className="text-sm font-medium text-violet-600 hover:text-violet-700 ms-auto shrink-0">
                  {t("marketplace.manageInSettings")}
                </Link>
              </div>
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
    </Wrap>
  );
}
