"use client";

import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getBotConfig, getChatbotFlows, createChatbotFlow, getChannelConfig, getFirstTakeCareSettings, updateFirstTakeCareSettings } from "@/lib/api";
import { FlowEditor } from "@/components/chatbot/FlowEditor";
import clsx from "clsx";

// ─── AI Bot Settings (AUTONOMOUS_AI mode) ────────────────────

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

function AIBotSettings({ token }: { token: string }) {
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [featureEnabled, setFeatureEnabled] = useState<boolean | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [rules, setRules] = useState<string[]>([]);
  const [tools, setTools] = useState<ToolConfig[]>(DEFAULT_TOOLS);
  const [model, setModel] = useState("gpt-4o-mini");
  const [provider, setProvider] = useState("openai");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [maxAutonomousMessages, setMaxAutonomousMessages] = useState(5);
  const [maxAutonomousMinutes, setMaxAutonomousMinutes] = useState(15);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.75);
  const [escalationMessage, setEscalationMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadSettings = useCallback(async () => {
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
    setLoading(true);
    try {
      await updateFirstTakeCareSettings(token, {
        isActive, systemPrompt, rules, tools, model, provider, temperature, maxTokens,
        maxAutonomousMessages, maxAutonomousMinutes, confidenceThreshold, escalationMessage,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  if (loadingSettings) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 border-emerald-200 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (featureEnabled === false) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
          <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <h4 className="font-semibold text-gray-900 mb-2">AI Bot Not Configured</h4>
          <p className="text-sm text-gray-500 max-w-sm mx-auto">
            The autonomous AI bot needs to be enabled by your system administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header Card */}
      <div className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-5 text-white shadow-lg">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-lg">AI Bot Settings</h3>
            <p className="text-white/80 text-sm">Configure the autonomous AI agent that handles customer conversations</p>
          </div>
        </div>
      </div>

      {/* Active Toggle */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-semibold text-gray-900">Active</h4>
            <p className="text-sm text-gray-400 mt-0.5">Enable or disable the AI bot</p>
          </div>
          <button
            onClick={() => setIsActive(!isActive)}
            className={clsx("relative w-12 h-7 rounded-full transition-colors", isActive ? "bg-green-500" : "bg-gray-300")}
          >
            <div className={clsx("absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform", isActive ? "translate-x-5.5 left-auto right-0.5" : "left-0.5")} />
          </button>
        </div>
      </div>

      {/* System Prompt */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
        <h4 className="font-semibold text-gray-900 mb-1">System Prompt</h4>
        <p className="text-sm text-gray-400 mb-3">Define the base instructions and persona for the AI bot</p>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are a helpful customer support agent..."
          rows={6}
          className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition resize-none font-mono"
        />
      </div>

      {/* Autonomous Behavior Settings */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
        <h4 className="font-semibold text-gray-900 mb-1">Autonomous Behavior</h4>
        <p className="text-sm text-gray-400 mb-4">Configure escalation thresholds</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Autonomous Messages</label>
            <input type="number" value={maxAutonomousMessages} onChange={(e) => setMaxAutonomousMessages(Math.min(50, Math.max(1, parseInt(e.target.value) || 1)))} min={1} max={50}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition" />
            <p className="text-[11px] text-gray-400 mt-1">Max messages before escalating (1-50)</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Autonomous Minutes</label>
            <input type="number" value={maxAutonomousMinutes} onChange={(e) => setMaxAutonomousMinutes(Math.min(60, Math.max(1, parseInt(e.target.value) || 1)))} min={1} max={60}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition" />
            <p className="text-[11px] text-gray-400 mt-1">Max minutes before escalating (1-60)</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Confidence Threshold: {confidenceThreshold.toFixed(2)}</label>
            <input type="range" min="0" max="1" step="0.05" value={confidenceThreshold} onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))} className="w-full accent-emerald-500" />
            <p className="text-[11px] text-gray-400 mt-1">Minimum confidence before responding</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Escalation Message</label>
            <textarea value={escalationMessage} onChange={(e) => setEscalationMessage(e.target.value)} placeholder="I'm connecting you with a human agent..." rows={3}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition resize-none" />
          </div>
        </div>
      </div>

      {/* Rules */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-semibold text-gray-900">Rules</h4>
          <button onClick={() => setRules([...rules, ""])} className="text-xs px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 font-medium transition flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            Add Rule
          </button>
        </div>
        <p className="text-sm text-gray-400 mb-3">Behavioral constraints and guidelines</p>
        <div className="space-y-2">
          {rules.length === 0 ? (
            <p className="text-sm text-gray-300 italic py-3 text-center">No rules defined</p>
          ) : rules.map((rule, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-gray-400 font-mono w-5 shrink-0 text-end">{i + 1}</span>
              <input type="text" value={rule} onChange={(e) => { const u = [...rules]; u[i] = e.target.value; setRules(u); }} placeholder="e.g. Always greet the customer by name"
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition" />
              <button onClick={() => setRules(rules.filter((_, idx) => idx !== i))} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
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
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google AI</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition">
              {provider === "openai" && (<><option value="gpt-4o-mini">GPT-4o Mini</option><option value="gpt-4o">GPT-4o</option><option value="gpt-4-turbo">GPT-4 Turbo</option></>)}
              {provider === "anthropic" && (<><option value="claude-sonnet-4-5-20250929">Claude 4.5 Sonnet</option><option value="claude-haiku-4-5-20251001">Claude 4.5 Haiku</option></>)}
              {provider === "google" && (<><option value="gemini-2.5-flash">Gemini 2.5 Flash</option><option value="gemini-2.5-pro">Gemini 2.5 Pro</option></>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Temperature: {temperature.toFixed(1)}</label>
            <input type="range" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} className="w-full accent-emerald-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Tokens</label>
            <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)} min={1} max={8192}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition" />
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 pb-6">
        <button onClick={handleSave} disabled={loading}
          className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50 flex items-center gap-2">
          {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> :
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
          {loading ? "Saving..." : "Save Settings"}
        </button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            Settings saved
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Chatbot Flow Editor (CHATBOT_FLOW mode) ─────────────────

function ChatbotFlowView({ token }: { token: string }) {
  const { t } = useI18n();
  const [flowId, setFlowId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [botFlowMode, setBotFlowMode] = useState<string>("UNIFIED");
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const loadFlowForChannel = useCallback(async (channel: string | null) => {
    setLoading(true);
    setFlowId(null);
    try {
      const flows = await getChatbotFlows(token, channel);
      if (flows.length > 0) {
        setFlowId(flows[0].id);
      } else {
        const name = channel ? `${channel} Flow` : "Chatbot Flow";
        const flow = await createChatbotFlow(token, {
          name, description: "", channel,
          nodes: [{ id: "start-1", type: "start", data: {} }],
          edges: [],
        });
        setFlowId(flow.id);
      }
    } catch (err) { console.error("Failed to load chatbot flow:", err); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => {
    async function loadConfig() {
      try {
        const configRes = await getChannelConfig(token);
        setBotFlowMode(configRes.data?.botFlowMode || "UNIFIED");
      } catch { /* default UNIFIED */ }
    }
    loadConfig();
  }, [token]);

  useEffect(() => {
    if (botFlowMode === "UNIFIED") {
      loadFlowForChannel(null);
    } else {
      loadFlowForChannel(activeTab);
    }
  }, [botFlowMode, activeTab, loadFlowForChannel]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-120px)]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-400">{t("common.loading")}</span>
        </div>
      </div>
    );
  }

  return flowId ? <FlowEditor flowId={flowId} key={flowId} /> : (
    <div className="flex items-center justify-center h-[calc(100vh-120px)]">
      <p className="text-sm text-gray-400">{t("common.error")}</p>
    </div>
  );
}

// ─── Main Bot Page ───────────────────────────────────────────

export default function BotPage() {
  const { token } = useAuth();
  const [botEnabled, setBotEnabled] = useState<boolean | null>(null);
  const [botType, setBotType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    getBotConfig(token)
      .then((res) => {
        setBotEnabled(res.data.botEnabled);
        setBotType(res.data.botType);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  if (!botEnabled) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">Bot Not Enabled</h2>
            <p className="text-sm text-gray-500">
              The bot feature is not enabled for your organization. Contact your system administrator to activate it.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (botType === "CHATBOT_FLOW") {
    return (
      <AppLayout>
        {token && <ChatbotFlowView token={token} />}
      </AppLayout>
    );
  }

  if (botType === "AUTONOMOUS_AI") {
    return (
      <AppLayout>
        <div className="p-3 md:p-6 overflow-y-auto h-screen">
          <div className="flex items-center justify-between mb-4 md:mb-6">
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">AI Bot</h1>
          </div>
          {token && <AIBotSettings token={token} />}
        </div>
      </AppLayout>
    );
  }

  // botType not set yet
  return (
    <AppLayout>
      <div className="flex items-center justify-center h-screen">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Bot Type Not Configured</h2>
          <p className="text-sm text-gray-500">
            Your system administrator needs to select a bot type (Chatbot Flow or Autonomous AI) for your organization.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
