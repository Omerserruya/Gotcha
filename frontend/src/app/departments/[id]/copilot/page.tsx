"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getDepartmentCopilot, updateDepartmentCopilot, getDepartmentToolPermissions, updateDepartmentToolPermissions } from "@/lib/api";
import clsx from "clsx";

interface DeptToolPermission {
  tenantToolId: string;
  isAllowed: boolean;
  requireApproval: boolean;
  tenantTool?: {
    id: string;
    isEnabled: boolean;
    catalogTool?: {
      name: string;
      description?: string;
      category: string;
      riskLevel: string;
      integration?: { name: string; slug: string; status?: string };
    };
  };
}

export default function DepartmentCopilotPage() {
  const params = useParams();
  const router = useRouter();
  const { token } = useAuth();
  const { t } = useI18n();
  const departmentId = params.id as string;

  const [source, setSource] = useState<string>("tenant");
  const [copilotMode, setCopilotMode] = useState<string>("READY_MESSAGE");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [rules, setRules] = useState<string[]>([]);
  const [model, setModel] = useState("gpt-4o-mini");
  const [provider, setProvider] = useState("openai");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  // Tool permissions
  const [toolPermissions, setToolPermissions] = useState<DeptToolPermission[]>([]);
  const [savingPerms, setSavingPerms] = useState(false);
  const [permsSaved, setPermsSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    getDepartmentToolPermissions(token, departmentId)
      .then((res) => setToolPermissions(res.data || []))
      .catch(() => {});
  }, [token, departmentId]);

  useEffect(() => {
    if (!token) return;
    async function fetchConfig() {
      try {
        const res = await getDepartmentCopilot(token!, departmentId);
        setSource(res.source);
        if (res.data) {
          setCopilotMode(res.data.copilotMode || "READY_MESSAGE");
          setSystemPrompt(res.data.systemPrompt || "");
          setRules(Array.isArray(res.data.rules) ? res.data.rules : []);
          setModel(res.data.model || "gpt-4o-mini");
          setProvider(res.data.provider || "openai");
          setTemperature(res.data.temperature ?? 0.7);
          setMaxTokens(res.data.maxTokens ?? 1024);
          setIsActive(res.data.isActive ?? true);
        }
      } catch (err) { console.error(err); }
    }
    fetchConfig();
  }, [token, departmentId]);

  async function handleSave() {
    if (!token) return;
    setLoading(true);
    try {
      await updateDepartmentCopilot(token, departmentId, {
        copilotMode, systemPrompt, rules, model, provider, temperature, maxTokens, isActive,
      });
      setSource("department");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  async function handleSavePermissions() {
    if (!token) return;
    setSavingPerms(true);
    try {
      await updateDepartmentToolPermissions(token, departmentId, toolPermissions.map((p) => ({
        tenantToolId: p.tenantToolId,
        isAllowed: p.isAllowed,
        requireApproval: p.requireApproval,
      })));
      setPermsSaved(true);
      setTimeout(() => setPermsSaved(false), 3000);
    } catch (err) { console.error(err); }
    finally { setSavingPerms(false); }
  }

  function togglePermAllowed(tenantToolId: string) {
    setToolPermissions((prev) =>
      prev.map((p) => p.tenantToolId === tenantToolId ? { ...p, isAllowed: !p.isAllowed } : p)
    );
  }

  function togglePermApproval(tenantToolId: string, requireApproval: boolean) {
    setToolPermissions((prev) =>
      prev.map((p) => p.tenantToolId === tenantToolId ? { ...p, requireApproval } : p)
    );
  }

  // Group tool permissions by integration name
  const permsByIntegration = toolPermissions.reduce<Record<string, DeptToolPermission[]>>((acc, perm) => {
    const intgName = perm.tenantTool?.catalogTool?.integration?.name || "Other";
    if (!acc[intgName]) acc[intgName] = [];
    acc[intgName].push(perm);
    return acc;
  }, {});

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        <div className="flex items-center gap-3 mb-4 md:mb-6">
          <button onClick={() => router.push("/departments")} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("departments.copilotConfig")}</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {source === "department" ? t("departments.copilotCustom") : t("departments.copilotInherited")}
            </p>
          </div>
        </div>

        <div className="max-w-3xl space-y-6">
          {/* Copilot Mode Toggle */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <h4 className="font-semibold text-gray-900 mb-1">{t("copilotMode.label")}</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <button
                onClick={() => setCopilotMode("READY_MESSAGE")}
                className={clsx(
                  "p-4 rounded-xl border-2 text-start transition",
                  copilotMode === "READY_MESSAGE" ? "border-violet-500 bg-violet-50" : "border-gray-200 hover:border-gray-300"
                )}
              >
                <p className="font-medium text-sm text-gray-900">{t("copilotMode.readyMessage")}</p>
                <p className="text-xs text-gray-500 mt-1">{t("copilotMode.readyMessageDesc")}</p>
              </button>
              <button
                onClick={() => setCopilotMode("CONTEXT_ONLY")}
                className={clsx(
                  "p-4 rounded-xl border-2 text-start transition",
                  copilotMode === "CONTEXT_ONLY" ? "border-violet-500 bg-violet-50" : "border-gray-200 hover:border-gray-300"
                )}
              >
                <p className="font-medium text-sm text-gray-900">{t("copilotMode.contextOnly")}</p>
                <p className="text-xs text-gray-500 mt-1">{t("copilotMode.contextOnlyDesc")}</p>
              </button>
            </div>
          </div>

          {/* Active Toggle */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-semibold text-gray-900">{t("copilot.active")}</h4>
                <p className="text-sm text-gray-400 mt-0.5">{t("copilot.activeDesc")}</p>
              </div>
              <button onClick={() => setIsActive(!isActive)} className={clsx("relative w-12 h-7 rounded-full transition-colors", isActive ? "bg-green-500" : "bg-gray-300")}>
                <div className={clsx("absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform", isActive ? "translate-x-5.5 left-auto right-0.5" : "left-0.5")} />
              </button>
            </div>
          </div>

          {/* System Prompt */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <h4 className="font-semibold text-gray-900 mb-1">{t("copilot.systemPrompt")}</h4>
            <p className="text-sm text-gray-400 mb-3">{t("copilot.systemPromptDesc")}</p>
            <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder={t("copilot.systemPromptPlaceholder")} rows={6} className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none font-mono" />
          </div>

          {/* Rules */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-1">
              <h4 className="font-semibold text-gray-900">{t("copilot.rules")}</h4>
              <button onClick={() => setRules([...rules, ""])} className="text-xs px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 font-medium transition flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                {t("copilot.addRule")}
              </button>
            </div>
            <div className="space-y-2 mt-3">
              {rules.map((rule, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 font-mono w-5 shrink-0 text-end">{i + 1}</span>
                  <input type="text" value={rule} onChange={(e) => { const u = [...rules]; u[i] = e.target.value; setRules(u); }} placeholder={t("copilot.rulePlaceholder")} className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition" />
                  <button onClick={() => setRules(rules.filter((_, j) => j !== i))} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition shrink-0">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Tool Permissions */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <h4 className="font-semibold text-gray-900 mb-1">{t("marketplace.toolPermissions")}</h4>
            {toolPermissions.length === 0 ? (
              <div className="mt-3 text-sm text-gray-400">
                {t("marketplace.noToolsConnected")}{" "}
                <a href="/integrations" className="text-violet-600 hover:underline">
                  {t("marketplace.connectInMarketplace")} →
                </a>
              </div>
            ) : (
              <div className="mt-3 space-y-5">
                {Object.entries(permsByIntegration).map(([intgName, perms]) => {
                  const intgSlug = perms[0]?.tenantTool?.catalogTool?.integration?.slug;
                  return (
                    <div key={intgName}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{intgName}</span>
                        {intgSlug && (
                          <a href={`/integrations/${intgSlug}`} className="text-xs text-violet-600 hover:underline">
                            {t("marketplace.connectInMarketplace")} →
                          </a>
                        )}
                      </div>
                      <div className="space-y-2">
                        {perms.map((perm) => {
                          const tool = perm.tenantTool?.catalogTool;
                          return (
                            <div key={perm.tenantToolId} className={clsx("flex items-center gap-3 p-3 rounded-xl border transition", perm.isAllowed ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50/50")}>
                              <button
                                onClick={() => togglePermAllowed(perm.tenantToolId)}
                                className={clsx("relative w-9 h-5 rounded-full transition-colors shrink-0", perm.isAllowed ? "bg-violet-600" : "bg-gray-200")}
                              >
                                <div className={clsx("absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform", perm.isAllowed ? "left-auto right-0.5" : "left-0.5")} />
                              </button>
                              <div className="flex-1 min-w-0">
                                <span className={clsx("text-sm font-medium", perm.isAllowed ? "text-gray-900" : "text-gray-400")}>
                                  {tool?.name || perm.tenantToolId}
                                </span>
                                {tool?.description && (
                                  <p className="text-xs text-gray-400 truncate">{tool.description}</p>
                                )}
                              </div>
                              {perm.isAllowed && (
                                <select
                                  value={perm.requireApproval ? "approval" : "auto"}
                                  onChange={(e) => togglePermApproval(perm.tenantToolId, e.target.value === "approval")}
                                  className="text-xs px-2 py-1 bg-gray-50 border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-violet-200"
                                >
                                  <option value="auto">{t("marketplace.auto")}</option>
                                  <option value="approval">{t("marketplace.requiresApproval")}</option>
                                </select>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {toolPermissions.length > 0 && (
              <div className="flex items-center gap-3 mt-4">
                <button onClick={handleSavePermissions} disabled={savingPerms} className="bg-violet-600 hover:bg-violet-700 text-white px-5 py-2 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50 flex items-center gap-2">
                  {savingPerms && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                  {t("common.save")}
                </button>
                {permsSaved && <span className="text-sm text-green-600">{t("common.success")}</span>}
              </div>
            )}
          </div>

          {/* Model Settings */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <h4 className="font-semibold text-gray-900 mb-3">{t("copilot.modelSettings")}</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("copilot.provider")}</label>
                <select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition">
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google AI</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("copilot.model")}</label>
                <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition">
                  {provider === "openai" && (<><option value="gpt-4o-mini">GPT-4o Mini</option><option value="gpt-4o">GPT-4o</option></>)}
                  {provider === "anthropic" && (<><option value="claude-sonnet-4-5-20250929">Claude 4.5 Sonnet</option><option value="claude-haiku-4-5-20251001">Claude 4.5 Haiku</option></>)}
                  {provider === "google" && (<><option value="gemini-2.5-flash">Gemini 2.5 Flash</option><option value="gemini-2.5-pro">Gemini 2.5 Pro</option></>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("copilot.temperature")}: {temperature.toFixed(1)}</label>
                <input type="range" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} className="w-full accent-violet-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("copilot.maxTokens")}</label>
                <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)} min={1} max={8192} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition" />
              </div>
            </div>
          </div>

          {/* Save */}
          <div className="flex items-center gap-3 pb-6">
            <button onClick={handleSave} disabled={loading} className="bg-violet-600 hover:bg-violet-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50 flex items-center gap-2">
              {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
              )}
              {loading ? t("common.loading") : t("copilot.save")}
            </button>
            {saved && (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                {t("copilot.saved")}
              </span>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
