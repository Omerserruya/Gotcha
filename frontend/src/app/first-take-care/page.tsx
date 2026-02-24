"use client";

import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { getFirstTakeCareSettings, updateFirstTakeCareSettings } from "@/lib/api";
import clsx from "clsx";

interface ToolConfig {
  id: string;
  name: string;
  enabled: boolean;
  config?: Record<string, any>;
}

const DEFAULT_TOOLS: ToolConfig[] = [
  { id: "kb_search", name: "Knowledge Base Search", enabled: true, config: {} },
  { id: "conversation_history", name: "Conversation History", enabled: true, config: {} },
  { id: "customer_lookup", name: "Customer Lookup", enabled: false, config: {} },
  { id: "order_status", name: "Order Status", enabled: false, config: {} },
];

export default function FirstTakeCarePage() {
  const { token } = useAuth();

  const [featureEnabled, setFeatureEnabled] = useState<boolean | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);

  // Settings state
  const [isActive, setIsActive] = useState(true);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [rules, setRules] = useState<string[]>([]);
  const [tools, setTools] = useState<ToolConfig[]>(DEFAULT_TOOLS);
  const [model, setModel] = useState("gpt-4o-mini");
  const [provider, setProvider] = useState("openai");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);

  // Autonomous behavior
  const [maxAutonomousMessages, setMaxAutonomousMessages] = useState(5);
  const [maxAutonomousMinutes, setMaxAutonomousMinutes] = useState(15);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.75);
  const [escalationMessage, setEscalationMessage] = useState("");

  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadSettings = useCallback(async () => {
    if (!token) return;
    setLoadingSettings(true);
    try {
      const res = await getFirstTakeCareSettings(token);
      setFeatureEnabled(res.enabled);
      if (res.enabled && res.data) {
        const d = res.data;
        setIsActive(d.isActive ?? true);
        setSystemPrompt(d.systemPrompt || "");
        setRules(Array.isArray(d.rules) ? d.rules : []);
        setTools(Array.isArray(d.tools) && d.tools.length > 0 ? d.tools : DEFAULT_TOOLS);
        setModel(d.model || "gpt-4o-mini");
        setProvider(d.provider || "openai");
        setTemperature(d.temperature ?? 0.7);
        setMaxTokens(d.maxTokens ?? 1024);
        setMaxAutonomousMessages(d.maxAutonomousMessages ?? 5);
        setMaxAutonomousMinutes(d.maxAutonomousMinutes ?? 15);
        setConfidenceThreshold(d.confidenceThreshold ?? 0.75);
        setEscalationMessage(d.escalationMessage || "");
      }
    } catch (err) {
      console.error(err);
      setFeatureEnabled(false);
    } finally {
      setLoadingSettings(false);
    }
  }, [token]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  async function handleSave() {
    if (!token) return;
    setLoading(true);
    try {
      await updateFirstTakeCareSettings(token, {
        isActive,
        systemPrompt,
        rules,
        tools,
        model,
        provider,
        temperature,
        maxTokens,
        maxAutonomousMessages,
        maxAutonomousMinutes,
        confidenceThreshold,
        escalationMessage,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function handleAddRule() { setRules([...rules, ""]); }
  function handleUpdateRule(index: number, value: string) { const u = [...rules]; u[index] = value; setRules(u); }
  function handleRemoveRule(index: number) { setRules(rules.filter((_, i) => i !== index)); }
  function handleToggleTool(toolId: string) {
    setTools(tools.map((tool) => tool.id === toolId ? { ...tool, enabled: !tool.enabled } : tool));
  }

  if (loadingSettings) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-6 h-6 border-2 border-emerald-200 border-t-emerald-500 rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">First-Take-Care AI Agent</h1>
        </div>

        <div className="max-w-3xl space-y-6">
          {/* Header Card */}
          <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-5 text-white shadow-lg">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-lg">First-Take-Care AI Agent</h3>
                <p className="text-white/80 text-sm">Configure the autonomous AI agent that handles initial customer conversations</p>
              </div>
            </div>
          </div>

          {/* Feature disabled state */}
          {featureEnabled === false && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
              <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </div>
              <h4 className="font-semibold text-gray-900 mb-2">Feature Not Enabled</h4>
              <p className="text-sm text-gray-500 max-w-sm mx-auto">
                This premium feature is not enabled for your organization. Contact your system administrator to activate it.
              </p>
            </div>
          )}

          {/* Config sections - only shown when feature is enabled */}
          {featureEnabled === true && (
            <>
              {/* Active Toggle */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-gray-900">Active</h4>
                    <p className="text-sm text-gray-400 mt-0.5">Enable or disable the First-Take-Care agent for your organization</p>
                  </div>
                  <button
                    onClick={() => setIsActive(!isActive)}
                    className={clsx(
                      "relative w-12 h-7 rounded-full transition-colors",
                      isActive ? "bg-green-500" : "bg-gray-300"
                    )}
                  >
                    <div className={clsx(
                      "absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform",
                      isActive ? "translate-x-5.5 left-auto right-0.5" : "left-0.5"
                    )} />
                  </button>
                </div>
              </div>

              {/* System Prompt */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <h4 className="font-semibold text-gray-900 mb-1">System Prompt</h4>
                <p className="text-sm text-gray-400 mb-3">Define the base instructions and persona for the AI agent</p>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="You are a helpful customer support agent. Your goal is to resolve customer issues efficiently and escalate to a human agent when needed..."
                  rows={6}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition resize-none font-mono"
                />
              </div>

              {/* Autonomous Behavior Settings */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <h4 className="font-semibold text-gray-900 mb-1">Autonomous Behavior</h4>
                <p className="text-sm text-gray-400 mb-4">Configure how long the agent operates autonomously before escalating to a human</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Max Autonomous Messages
                    </label>
                    <input
                      type="number"
                      value={maxAutonomousMessages}
                      onChange={(e) => setMaxAutonomousMessages(Math.min(50, Math.max(1, parseInt(e.target.value) || 1)))}
                      min={1}
                      max={50}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">Max messages before escalating (1–50)</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Max Autonomous Minutes
                    </label>
                    <input
                      type="number"
                      value={maxAutonomousMinutes}
                      onChange={(e) => setMaxAutonomousMinutes(Math.min(60, Math.max(1, parseInt(e.target.value) || 1)))}
                      min={1}
                      max={60}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">Max minutes before escalating (1–60)</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Confidence Threshold: {confidenceThreshold.toFixed(2)}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={confidenceThreshold}
                      onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">Minimum confidence required before responding autonomously</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Escalation Message
                    </label>
                    <textarea
                      value={escalationMessage}
                      onChange={(e) => setEscalationMessage(e.target.value)}
                      placeholder="I'm connecting you with a human agent who can better assist you..."
                      rows={3}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition resize-none"
                    />
                  </div>
                </div>
              </div>

              {/* Rules */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="font-semibold text-gray-900">Rules</h4>
                  <button
                    onClick={handleAddRule}
                    className="text-xs px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 font-medium transition flex items-center gap-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    Add Rule
                  </button>
                </div>
                <p className="text-sm text-gray-400 mb-3">Define behavioral constraints and guidelines for the agent</p>
                <div className="space-y-2">
                  {rules.length === 0 ? (
                    <p className="text-sm text-gray-300 italic py-3 text-center">No rules defined</p>
                  ) : (
                    rules.map((rule, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 font-mono w-5 shrink-0 text-end">{i + 1}</span>
                        <input
                          type="text"
                          value={rule}
                          onChange={(e) => handleUpdateRule(i, e.target.value)}
                          placeholder="e.g. Always greet the customer by name"
                          className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                        />
                        <button
                          onClick={() => handleRemoveRule(i)}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition shrink-0"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Tools */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <h4 className="font-semibold text-gray-900 mb-1">Tools</h4>
                <p className="text-sm text-gray-400 mb-3">Enable capabilities the agent can use during conversations</p>
                <div className="space-y-2">
                  {tools.map((tool) => (
                    <div key={tool.id} className={clsx(
                      "flex items-center justify-between p-3 rounded-xl border transition",
                      tool.enabled ? "bg-emerald-50/50 border-emerald-100" : "bg-gray-50 border-gray-100"
                    )}>
                      <div className="flex items-center gap-3">
                        <div className={clsx(
                          "w-8 h-8 rounded-lg flex items-center justify-center",
                          tool.enabled ? "bg-emerald-100" : "bg-gray-200"
                        )}>
                          {tool.id === "kb_search" ? (
                            <svg className={clsx("w-4 h-4", tool.enabled ? "text-emerald-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                            </svg>
                          ) : tool.id === "conversation_history" ? (
                            <svg className={clsx("w-4 h-4", tool.enabled ? "text-emerald-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          ) : tool.id === "customer_lookup" ? (
                            <svg className={clsx("w-4 h-4", tool.enabled ? "text-emerald-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                            </svg>
                          ) : (
                            <svg className={clsx("w-4 h-4", tool.enabled ? "text-emerald-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.1-5.1m0 0L11.42 4.97m-5.1 5.1h14.18" />
                            </svg>
                          )}
                        </div>
                        <span className={clsx("text-sm font-medium", tool.enabled ? "text-gray-900" : "text-gray-400")}>{tool.name}</span>
                      </div>
                      <button
                        onClick={() => handleToggleTool(tool.id)}
                        className={clsx(
                          "relative w-10 h-6 rounded-full transition-colors",
                          tool.enabled ? "bg-emerald-500" : "bg-gray-300"
                        )}
                      >
                        <div className={clsx(
                          "absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all",
                          tool.enabled ? "left-[18px]" : "left-0.5"
                        )} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Model Settings */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                <h4 className="font-semibold text-gray-900 mb-3">Model Settings</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                    <select
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="google">Google AI</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                    >
                      {provider === "openai" && (
                        <>
                          <option value="gpt-4o-mini">GPT-4o Mini</option>
                          <option value="gpt-4o">GPT-4o</option>
                          <option value="gpt-4-turbo">GPT-4 Turbo</option>
                        </>
                      )}
                      {provider === "anthropic" && (
                        <>
                          <option value="claude-sonnet-4-5-20250929">Claude 4.5 Sonnet</option>
                          <option value="claude-haiku-4-5-20251001">Claude 4.5 Haiku</option>
                        </>
                      )}
                      {provider === "google" && (
                        <>
                          <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                          <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                        </>
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Temperature: {temperature.toFixed(1)}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={temperature}
                      onChange={(e) => setTemperature(parseFloat(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">Controls randomness (0 = deterministic, 2 = very random)</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Max Tokens</label>
                    <input
                      type="number"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
                      min={1}
                      max={8192}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                    />
                  </div>
                </div>
              </div>

              {/* Save Button */}
              <div className="flex items-center gap-3 pb-6">
                <button
                  onClick={handleSave}
                  disabled={loading}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {loading ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  )}
                  {loading ? "Saving..." : "Save Settings"}
                </button>
                {saved && (
                  <span className="text-sm text-green-600 flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Settings saved
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
