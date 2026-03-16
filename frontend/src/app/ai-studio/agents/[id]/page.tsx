"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useI18n } from "@/context/I18nContext";
import clsx from "clsx";

// ─── Types ────────────────────────────────────────────────────
type Tone = "professional" | "friendly" | "casual" | "formal";
type AgentMode = "human_only" | "copilot" | "autonomous";
type AgentRole = "customer_support" | "sales" | "booking" | "billing" | "custom";

interface EscalationRule {
  id: string;
  label: string;
  enabled: boolean;
  type: "toggle" | "number" | "text";
  value?: string | number;
}

interface Tool {
  id: string;
  name: string;
  integration: string;
  risk: "low" | "medium" | "high";
  enabled: boolean;
}

interface KnowledgeSource {
  id: string;
  name: string;
  type: string;
  status: "synced" | "syncing" | "error";
  enabled: boolean;
}

interface InteractiveMessagesConfig {
  allowQuickReply: boolean;
  allowListMenu: boolean;
  allowCTA: boolean;
  autoSuggestMultipleOptions: boolean;
  autoSuggestYesNo: boolean;
  autoSuggestProductChoice: boolean;
  autoSuggestAlways: boolean;
}

interface AgentFormData {
  name: string;
  role: AgentRole;
  description: string;
  avatarColor: string;
  tone: Tone;
  languages: { english: boolean; hebrew: boolean; arabic: boolean };
  style: {
    useEmojis: boolean;
    concise: boolean;
    useFirstName: boolean;
    proactive: boolean;
  };
  tools: Tool[];
  knowledge: KnowledgeSource[];
  escalationRules: EscalationRule[];
  interactiveMessages: InteractiveMessagesConfig;
  channels: { whatsapp: boolean; instagram: boolean; webchat: boolean };
  mode: AgentMode;
  status: "active" | "draft" | "paused";
}

// ─── Demo data ─────────────────────────────────────────────────
const AVATAR_COLORS = [
  { value: "from-violet-400 to-violet-600", label: "Violet" },
  { value: "from-blue-400 to-blue-600", label: "Blue" },
  { value: "from-emerald-400 to-emerald-600", label: "Green" },
  { value: "from-rose-400 to-rose-600", label: "Rose" },
  { value: "from-amber-400 to-amber-600", label: "Amber" },
  { value: "from-cyan-400 to-cyan-600", label: "Cyan" },
];

const DEMO_AGENTS: Record<string, AgentFormData> = {
  "1": {
    name: "Maya",
    role: "customer_support",
    description: "Handles support queries and helps customers with their orders, returns, and general questions.",
    avatarColor: "from-violet-400 to-violet-600",
    tone: "friendly",
    languages: { english: true, hebrew: true, arabic: false },
    style: { useEmojis: true, concise: true, useFirstName: false, proactive: false },
    tools: [
      { id: "t1", name: "Order Lookup", integration: "Shopify", risk: "low", enabled: true },
      { id: "t2", name: "Track Shipment", integration: "Shopify", risk: "low", enabled: true },
      { id: "t3", name: "Process Refund", integration: "Shopify", risk: "high", enabled: false },
      { id: "t4", name: "Cancel Order", integration: "Shopify", risk: "high", enabled: false },
      { id: "t5", name: "Customer Lookup", integration: "HubSpot", risk: "low", enabled: true },
    ],
    knowledge: [
      { id: "k1", name: "FAQ — General Support", type: "FAQ", status: "synced", enabled: true },
      { id: "k2", name: "Return Policy", type: "Document", status: "synced", enabled: true },
      { id: "k3", name: "Product Catalog", type: "Website", status: "syncing", enabled: false },
      { id: "k4", name: "Shipping Rates", type: "File", status: "synced", enabled: false },
    ],
    escalationRules: [
      { id: "e1", label: "Customer asks to speak to a human", enabled: true, type: "toggle" },
      { id: "e2", label: "Customer is angry (AI detected)", enabled: true, type: "toggle" },
      { id: "e3", label: "After N failed attempts", enabled: true, type: "number", value: 3 },
      { id: "e4", label: "Specific keywords detected", enabled: false, type: "text", value: "refund, cancel, lawsuit" },
    ],
    interactiveMessages: {
      allowQuickReply: true,
      allowListMenu: false,
      allowCTA: false,
      autoSuggestMultipleOptions: true,
      autoSuggestYesNo: true,
      autoSuggestProductChoice: false,
      autoSuggestAlways: false,
    },
    channels: { whatsapp: true, instagram: true, webchat: false },
    mode: "copilot",
    status: "active",
  },
  "2": {
    name: "Sales Bot",
    role: "sales",
    description: "Engages with potential customers, qualifies leads, and helps close deals.",
    avatarColor: "from-emerald-400 to-emerald-600",
    tone: "professional",
    languages: { english: true, hebrew: false, arabic: false },
    style: { useEmojis: false, concise: false, useFirstName: true, proactive: true },
    tools: [
      { id: "t5", name: "Customer Lookup", integration: "HubSpot", risk: "low", enabled: true },
      { id: "t6", name: "Create Deal", integration: "HubSpot", risk: "medium", enabled: true },
    ],
    knowledge: [
      { id: "k3", name: "Product Catalog", type: "Website", status: "synced", enabled: true },
    ],
    escalationRules: [
      { id: "e1", label: "Customer asks to speak to a human", enabled: true, type: "toggle" },
      { id: "e2", label: "Customer is angry (AI detected)", enabled: false, type: "toggle" },
      { id: "e3", label: "After N failed attempts", enabled: false, type: "number", value: 5 },
      { id: "e4", label: "Specific keywords detected", enabled: false, type: "text", value: "" },
    ],
    interactiveMessages: {
      allowQuickReply: true,
      allowListMenu: true,
      allowCTA: true,
      autoSuggestMultipleOptions: true,
      autoSuggestYesNo: false,
      autoSuggestProductChoice: true,
      autoSuggestAlways: false,
    },
    channels: { whatsapp: true, instagram: false, webchat: true },
    mode: "autonomous",
    status: "active",
  },
  "3": {
    name: "Returns Handler",
    role: "billing",
    description: "Specialized agent for handling return requests and refund processing.",
    avatarColor: "from-rose-400 to-rose-600",
    tone: "professional",
    languages: { english: true, hebrew: false, arabic: false },
    style: { useEmojis: false, concise: true, useFirstName: false, proactive: false },
    tools: [
      { id: "t3", name: "Process Refund", integration: "Shopify", risk: "high", enabled: false },
      { id: "t4", name: "Cancel Order", integration: "Shopify", risk: "high", enabled: false },
    ],
    knowledge: [
      { id: "k2", name: "Return Policy", type: "Document", status: "synced", enabled: true },
    ],
    escalationRules: [
      { id: "e1", label: "Customer asks to speak to a human", enabled: true, type: "toggle" },
      { id: "e2", label: "Customer is angry (AI detected)", enabled: true, type: "toggle" },
      { id: "e3", label: "After N failed attempts", enabled: true, type: "number", value: 2 },
      { id: "e4", label: "Specific keywords detected", enabled: false, type: "text", value: "" },
    ],
    interactiveMessages: {
      allowQuickReply: false,
      allowListMenu: false,
      allowCTA: false,
      autoSuggestMultipleOptions: false,
      autoSuggestYesNo: false,
      autoSuggestProductChoice: false,
      autoSuggestAlways: false,
    },
    channels: { whatsapp: false, instagram: false, webchat: false },
    mode: "human_only",
    status: "draft",
  },
};

const NEW_AGENT_DEFAULT: AgentFormData = {
  name: "",
  role: "custom",
  description: "",
  avatarColor: "from-violet-400 to-violet-600",
  tone: "friendly",
  languages: { english: true, hebrew: false, arabic: false },
  style: { useEmojis: false, concise: true, useFirstName: false, proactive: false },
  tools: [
    { id: "t1", name: "Order Lookup", integration: "Shopify", risk: "low", enabled: false },
    { id: "t2", name: "Track Shipment", integration: "Shopify", risk: "low", enabled: false },
    { id: "t3", name: "Process Refund", integration: "Shopify", risk: "high", enabled: false },
    { id: "t5", name: "Customer Lookup", integration: "HubSpot", risk: "low", enabled: false },
    { id: "t6", name: "Create Deal", integration: "HubSpot", risk: "medium", enabled: false },
  ],
  knowledge: [
    { id: "k1", name: "FAQ — General Support", type: "FAQ", status: "synced", enabled: false },
    { id: "k2", name: "Return Policy", type: "Document", status: "synced", enabled: false },
    { id: "k3", name: "Product Catalog", type: "Website", status: "syncing", enabled: false },
  ],
  escalationRules: [
    { id: "e1", label: "Customer asks to speak to a human", enabled: true, type: "toggle" },
    { id: "e2", label: "Customer is angry (AI detected)", enabled: false, type: "toggle" },
    { id: "e3", label: "After N failed attempts", enabled: false, type: "number", value: 3 },
    { id: "e4", label: "Specific keywords detected", enabled: false, type: "text", value: "" },
  ],
  interactiveMessages: {
    allowQuickReply: true,
    allowListMenu: false,
    allowCTA: false,
    autoSuggestMultipleOptions: true,
    autoSuggestYesNo: true,
    autoSuggestProductChoice: false,
    autoSuggestAlways: false,
  },
  channels: { whatsapp: false, instagram: false, webchat: false },
  mode: "copilot",
  status: "draft",
};

// ─── Small shared components ───────────────────────────────────
function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <div className="mb-4">
        <h3 className="font-semibold text-gray-900 text-base">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative w-10 h-[22px] rounded-full transition-colors shrink-0",
        checked ? "bg-violet-500" : "bg-gray-200"
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform",
          checked && "translate-x-[18px]"
        )}
      />
    </button>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const map: Record<string, string> = {
    low: "bg-green-50 text-green-600 border-green-200",
    medium: "bg-yellow-50 text-yellow-600 border-yellow-200",
    high: "bg-red-50 text-red-600 border-red-200",
  };
  return (
    <span className={clsx("px-2 py-0.5 rounded-full text-[10px] font-medium border uppercase tracking-wide", map[risk] || "bg-gray-50 text-gray-500 border-gray-200")}>
      {risk} risk
    </span>
  );
}

function StatusDot({ status }: { status: "synced" | "syncing" | "error" }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 text-xs font-medium",
      status === "synced" && "text-green-600",
      status === "syncing" && "text-blue-500",
      status === "error" && "text-red-500"
    )}>
      <span className={clsx("w-1.5 h-1.5 rounded-full",
        status === "synced" && "bg-green-500",
        status === "syncing" && "bg-blue-400 animate-pulse",
        status === "error" && "bg-red-500"
      )} />
      {status}
    </span>
  );
}

// ─── Main page ─────────────────────────────────────────────────
export default function AgentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t } = useI18n();

  const isNew = id === "new";
  const initial = isNew ? NEW_AGENT_DEFAULT : (DEMO_AGENTS[id] ?? NEW_AGENT_DEFAULT);

  const [form, setForm] = useState<AgentFormData>(initial);
  const [saved, setSaved] = useState(false);
  const [customRuleInput, setCustomRuleInput] = useState("");
  const [showCustomRuleInput, setShowCustomRuleInput] = useState(false);

  function patch(partial: Partial<AgentFormData>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  function handleSave() {
    // Local-only: just show a brief confirmation
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function toggleTool(toolId: string) {
    patch({
      tools: form.tools.map((tool) =>
        tool.id === toolId ? { ...tool, enabled: !tool.enabled } : tool
      ),
    });
  }

  function toggleKnowledge(kId: string) {
    patch({
      knowledge: form.knowledge.map((k) =>
        k.id === kId ? { ...k, enabled: !k.enabled } : k
      ),
    });
  }

  function toggleEscalationRule(ruleId: string) {
    patch({
      escalationRules: form.escalationRules.map((r) =>
        r.id === ruleId ? { ...r, enabled: !r.enabled } : r
      ),
    });
  }

  function updateEscalationValue(ruleId: string, value: string | number) {
    patch({
      escalationRules: form.escalationRules.map((r) =>
        r.id === ruleId ? { ...r, value } : r
      ),
    });
  }

  function addCustomRule() {
    if (!customRuleInput.trim()) return;
    const newRule: EscalationRule = {
      id: `custom_${Date.now()}`,
      label: customRuleInput.trim(),
      enabled: true,
      type: "toggle",
    };
    patch({ escalationRules: [...form.escalationRules, newRule] });
    setCustomRuleInput("");
    setShowCustomRuleInput(false);
  }

  function removeEscalationRule(ruleId: string) {
    patch({ escalationRules: form.escalationRules.filter((r) => r.id !== ruleId) });
  }

  // Group tools by integration
  const toolsByIntegration = form.tools.reduce<Record<string, Tool[]>>((acc, tool) => {
    if (!acc[tool.integration]) acc[tool.integration] = [];
    acc[tool.integration].push(tool);
    return acc;
  }, {});

  const pageTitle = isNew
    ? t("aiStudio.agents.editor.newAgent")
    : (form.name || t("aiStudio.agents.editor.editAgent"));

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Back button */}
        <button
          onClick={() => router.push("/ai-studio")}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm mb-5 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {t("aiStudio.agents.editor.backToStudio")}
        </button>

        <div className="max-w-2xl space-y-5">
          {/* Page header */}
          <div className="flex items-center gap-3">
            <div className={clsx(
              "w-12 h-12 rounded-2xl bg-gradient-to-br flex items-center justify-center text-white font-bold text-xl shadow-sm shrink-0",
              form.avatarColor
            )}>
              {form.name ? form.name.charAt(0).toUpperCase() : "?"}
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">{pageTitle}</h1>
              <p className="text-sm text-gray-400">
                {isNew
                  ? t("aiStudio.agents.editor.newAgentSub")
                  : t("aiStudio.agents.editor.editAgentSub")}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* Status badge for existing agents */}
              {!isNew && (
                <select
                  value={form.status}
                  onChange={(e) => patch({ status: e.target.value as AgentFormData["status"] })}
                  className={clsx(
                    "px-3 py-1.5 rounded-xl text-xs font-medium border outline-none cursor-pointer",
                    form.status === "active" && "bg-green-50 text-green-700 border-green-200",
                    form.status === "draft" && "bg-gray-50 text-gray-600 border-gray-200",
                    form.status === "paused" && "bg-yellow-50 text-yellow-700 border-yellow-200"
                  )}
                >
                  <option value="active">{t("aiStudio.agents.editor.statusActive")}</option>
                  <option value="draft">{t("aiStudio.agents.editor.statusDraft")}</option>
                  <option value="paused">{t("aiStudio.agents.editor.statusPaused")}</option>
                </select>
              )}
            </div>
          </div>

          {/* ── Section 1: Agent Setup ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.setup.title")}
            subtitle={t("aiStudio.agents.editor.setup.subtitle")}
          >
            {/* Avatar color picker */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t("aiStudio.agents.editor.setup.avatar")}
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => patch({ avatarColor: c.value })}
                    className={clsx(
                      "w-9 h-9 rounded-xl bg-gradient-to-br transition-all",
                      c.value,
                      form.avatarColor === c.value
                        ? "ring-2 ring-offset-2 ring-violet-500 scale-110"
                        : "hover:scale-105"
                    )}
                  />
                ))}
                {/* Preview */}
                <div className={clsx(
                  "w-9 h-9 rounded-xl bg-gradient-to-br flex items-center justify-center text-white font-bold text-sm ml-2",
                  form.avatarColor
                )}>
                  {form.name ? form.name.charAt(0).toUpperCase() : "?"}
                </div>
              </div>
            </div>

            {/* Name */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("aiStudio.agents.editor.setup.name")}
                <span className="text-red-400 ml-1">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder={t("aiStudio.agents.editor.setup.namePlaceholder")}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
              />
            </div>

            {/* Role */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("aiStudio.agents.editor.setup.role")}
              </label>
              <select
                value={form.role}
                onChange={(e) => patch({ role: e.target.value as AgentRole })}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
              >
                <option value="customer_support">{t("aiStudio.agents.editor.setup.roleSupport")}</option>
                <option value="sales">{t("aiStudio.agents.editor.setup.roleSales")}</option>
                <option value="booking">{t("aiStudio.agents.editor.setup.roleBooking")}</option>
                <option value="billing">{t("aiStudio.agents.editor.setup.roleBilling")}</option>
                <option value="custom">{t("aiStudio.agents.editor.setup.roleCustom")}</option>
              </select>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("aiStudio.agents.editor.setup.description")}
              </label>
              <textarea
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder={t("aiStudio.agents.editor.setup.descriptionPlaceholder")}
                rows={3}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
              />
            </div>
          </SectionCard>

          {/* ── Section 2: Personality ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.personality.title")}
            subtitle={t("aiStudio.agents.editor.personality.subtitle")}
          >
            {/* Tone */}
            <div className="mb-5">
              <p className="text-sm font-medium text-gray-700 mb-2">
                {t("aiStudio.agents.editor.personality.tone")}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(["professional", "friendly", "casual", "formal"] as Tone[]).map((tone) => (
                  <button
                    key={tone}
                    type="button"
                    onClick={() => patch({ tone })}
                    className={clsx(
                      "py-2 px-3 rounded-xl text-sm font-medium border transition capitalize",
                      form.tone === tone
                        ? "bg-violet-50 border-violet-300 text-violet-700"
                        : "bg-gray-50 border-gray-200 text-gray-600 hover:border-gray-300"
                    )}
                  >
                    {t(`aiStudio.agents.editor.personality.tone_${tone}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Language */}
            <div className="mb-5">
              <p className="text-sm font-medium text-gray-700 mb-2">
                {t("aiStudio.agents.editor.personality.language")}
              </p>
              <div className="flex flex-wrap gap-3">
                {(["english", "hebrew", "arabic"] as const).map((lang) => (
                  <label key={lang} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.languages[lang]}
                      onChange={(e) =>
                        patch({ languages: { ...form.languages, [lang]: e.target.checked } })
                      }
                      className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                    />
                    <span className="text-sm text-gray-700 capitalize">
                      {t(`aiStudio.agents.editor.personality.lang_${lang}`)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Style toggles */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">
                {t("aiStudio.agents.editor.personality.style")}
              </p>
              <div className="space-y-3">
                {(
                  [
                    { key: "useEmojis", label: t("aiStudio.agents.editor.personality.styleEmojis") },
                    { key: "concise", label: t("aiStudio.agents.editor.personality.styleConcise") },
                    { key: "useFirstName", label: t("aiStudio.agents.editor.personality.styleFirstName") },
                    { key: "proactive", label: t("aiStudio.agents.editor.personality.styleProactive") },
                  ] as const
                ).map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-gray-700">{label}</span>
                    <Toggle
                      checked={form.style[key]}
                      onChange={(v) => patch({ style: { ...form.style, [key]: v } })}
                    />
                  </div>
                ))}
              </div>
            </div>
          </SectionCard>

          {/* ── Section 3: Skills (Tools) ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.skills.title")}
            subtitle={t("aiStudio.agents.editor.skills.subtitle")}
          >
            {Object.entries(toolsByIntegration).map(([integration, tools]) => (
              <div key={integration} className="mb-4 last:mb-0">
                {/* Integration header */}
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">
                    {integration.charAt(0)}
                  </div>
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {integration}
                  </span>
                </div>

                <div className="space-y-2">
                  {tools.map((tool) => (
                    <div
                      key={tool.id}
                      className={clsx(
                        "flex items-center gap-3 p-3 rounded-xl border transition",
                        tool.enabled
                          ? "border-gray-200 bg-white"
                          : "border-gray-100 bg-gray-50/50"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={tool.enabled}
                        onChange={() => toggleTool(tool.id)}
                        className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                      />
                      <span className="text-sm text-gray-800 flex-1">{tool.name}</span>
                      <RiskBadge risk={tool.risk} />
                      {tool.risk === "high" && tool.enabled && (
                        <svg className="w-4 h-4 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                        </svg>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={() => router.push("/integrations")}
              className="mt-3 flex items-center gap-2 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              {t("aiStudio.agents.editor.skills.addMore")}
            </button>
          </SectionCard>

          {/* ── Section 4: Knowledge ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.knowledge.title")}
            subtitle={t("aiStudio.agents.editor.knowledge.subtitle")}
          >
            <div className="space-y-2">
              {form.knowledge.map((src) => (
                <div
                  key={src.id}
                  className={clsx(
                    "flex items-center gap-3 p-3 rounded-xl border transition",
                    src.enabled ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50/50"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={src.enabled}
                    onChange={() => toggleKnowledge(src.id)}
                    className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800">{src.name}</p>
                    <p className="text-xs text-gray-400">{src.type}</p>
                  </div>
                  <StatusDot status={src.status} />
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => router.push("/ai-studio")}
              className="mt-3 flex items-center gap-2 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              {t("aiStudio.agents.editor.knowledge.addSource")}
            </button>
          </SectionCard>

          {/* ── Section 5: Escalation Rules ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.escalation.title")}
            subtitle={t("aiStudio.agents.editor.escalation.subtitle")}
          >
            <div className="space-y-3">
              {form.escalationRules.map((rule) => (
                <div key={rule.id} className="flex items-start gap-3 p-3 rounded-xl border border-gray-100 bg-gray-50/40">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{rule.label}</p>
                    {/* Inline value input for number/text type rules */}
                    {rule.enabled && rule.type === "number" && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={rule.value as number ?? 3}
                          onChange={(e) => updateEscalationValue(rule.id, parseInt(e.target.value) || 1)}
                          className="w-16 px-2 py-1 bg-white border border-gray-200 rounded-lg text-xs text-center focus:ring-1 focus:ring-violet-200 focus:border-violet-300 outline-none"
                        />
                        <span className="text-xs text-gray-400">{t("aiStudio.agents.editor.escalation.attempts")}</span>
                      </div>
                    )}
                    {rule.enabled && rule.type === "text" && (
                      <input
                        type="text"
                        value={rule.value as string ?? ""}
                        onChange={(e) => updateEscalationValue(rule.id, e.target.value)}
                        placeholder={t("aiStudio.agents.editor.escalation.keywordsPlaceholder")}
                        className="mt-2 w-full px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs focus:ring-1 focus:ring-violet-200 focus:border-violet-300 outline-none"
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Allow removing custom rules */}
                    {rule.id.startsWith("custom_") && (
                      <button
                        type="button"
                        onClick={() => removeEscalationRule(rule.id)}
                        className="p-1 rounded text-gray-300 hover:text-red-400 transition"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                    <Toggle checked={rule.enabled} onChange={() => toggleEscalationRule(rule.id)} />
                  </div>
                </div>
              ))}
            </div>

            {/* Add custom rule */}
            {showCustomRuleInput ? (
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="text"
                  value={customRuleInput}
                  onChange={(e) => setCustomRuleInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addCustomRule(); if (e.key === "Escape") setShowCustomRuleInput(false); }}
                  placeholder={t("aiStudio.agents.editor.escalation.customRulePlaceholder")}
                  autoFocus
                  className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none"
                />
                <button
                  type="button"
                  onClick={addCustomRule}
                  className="px-3 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition"
                >
                  {t("common.save")}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCustomRuleInput(false); setCustomRuleInput(""); }}
                  className="px-3 py-2 text-gray-500 hover:text-gray-700 text-sm transition"
                >
                  {t("common.cancel")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCustomRuleInput(true)}
                className="mt-3 flex items-center gap-2 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                {t("aiStudio.agents.editor.escalation.addCustomRule")}
              </button>
            )}
          </SectionCard>

          {/* ── Section 6: Interactive Messages ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.interactiveMessages.title")}
            subtitle={t("aiStudio.agents.editor.interactiveMessages.subtitle")}
          >
            {/* Allowed message types */}
            <div className="mb-5">
              <p className="text-sm font-medium text-gray-700 mb-3">
                {t("aiStudio.agents.editor.interactiveMessages.allowedTypes")}
              </p>
              <div className="space-y-3">
                {(
                  [
                    { key: "allowQuickReply" as const, label: t("aiStudio.agents.editor.interactiveMessages.quickReply") },
                    { key: "allowListMenu" as const, label: t("aiStudio.agents.editor.interactiveMessages.listMenu") },
                    { key: "allowCTA" as const, label: t("aiStudio.agents.editor.interactiveMessages.cta") },
                  ]
                ).map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-gray-700">{label}</span>
                    <Toggle
                      checked={form.interactiveMessages[key]}
                      onChange={(v) =>
                        patch({ interactiveMessages: { ...form.interactiveMessages, [key]: v } })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Auto-suggest settings */}
            <div className="mb-5">
              <p className="text-sm font-medium text-gray-700 mb-3">
                {t("aiStudio.agents.editor.interactiveMessages.autoSuggestLabel")}
              </p>
              <div className="space-y-2.5">
                {(
                  [
                    { key: "autoSuggestMultipleOptions" as const, label: t("aiStudio.agents.editor.interactiveMessages.autoSuggestMultiple") },
                    { key: "autoSuggestYesNo" as const, label: t("aiStudio.agents.editor.interactiveMessages.autoSuggestYesNo") },
                    { key: "autoSuggestProductChoice" as const, label: t("aiStudio.agents.editor.interactiveMessages.autoSuggestProduct") },
                    { key: "autoSuggestAlways" as const, label: t("aiStudio.agents.editor.interactiveMessages.autoSuggestAlways") },
                  ]
                ).map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.interactiveMessages[key]}
                      onChange={(e) =>
                        patch({ interactiveMessages: { ...form.interactiveMessages, [key]: e.target.checked } })
                      }
                      className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                    />
                    <span className="text-sm text-gray-700">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Quick Reply Preview */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">
                {t("aiStudio.agents.editor.interactiveMessages.previewTitle")}
              </p>
              <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
                <div className="flex flex-col items-start gap-3 max-w-xs">
                  {/* Chat bubble */}
                  <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm">
                    <p className="text-sm text-gray-800">
                      {t("aiStudio.agents.editor.interactiveMessages.previewMessage")}
                    </p>
                  </div>
                  {/* Quick reply buttons */}
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        t("aiStudio.agents.editor.interactiveMessages.previewBtn1"),
                        t("aiStudio.agents.editor.interactiveMessages.previewBtn2"),
                        t("aiStudio.agents.editor.interactiveMessages.previewBtn3"),
                      ]
                    ).map((btn) => (
                      <span
                        key={btn}
                        className="px-3 py-1.5 rounded-full border border-violet-300 bg-white text-violet-700 text-xs font-medium cursor-default"
                      >
                        {btn}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </SectionCard>

          {/* ── Section 7: Channels ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.channels.title")}
            subtitle={t("aiStudio.agents.editor.channels.subtitle")}
          >
            <div className="space-y-3">
              {(
                [
                  { key: "whatsapp", icon: "💬", label: t("aiStudio.agents.editor.channels.whatsapp") },
                  { key: "instagram", icon: "📸", label: t("aiStudio.agents.editor.channels.instagram") },
                  { key: "webchat", icon: "🌐", label: t("aiStudio.agents.editor.channels.webchat") },
                ] as const
              ).map(({ key, icon, label }) => (
                <label
                  key={key}
                  className={clsx(
                    "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition",
                    form.channels[key]
                      ? "border-violet-200 bg-violet-50/50"
                      : "border-gray-100 bg-gray-50/40 hover:border-gray-200"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={form.channels[key]}
                    onChange={(e) =>
                      patch({ channels: { ...form.channels, [key]: e.target.checked } })
                    }
                    className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                  />
                  <span className="text-base">{icon}</span>
                  <span className="text-sm font-medium text-gray-800">{label}</span>
                  {form.channels[key] && (
                    <span className="ml-auto text-xs font-medium text-violet-600 bg-violet-100 px-2 py-0.5 rounded-full">
                      {t("aiStudio.agents.editor.channels.active")}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </SectionCard>

          {/* ── Section 8: Mode ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.mode.title")}
            subtitle={t("aiStudio.agents.editor.mode.subtitle")}
          >
            <div className="space-y-3">
              {(
                [
                  {
                    value: "human_only" as AgentMode,
                    label: t("aiStudio.agents.editor.mode.humanOnly"),
                    desc: t("aiStudio.agents.editor.mode.humanOnlyDesc"),
                    icon: (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                      </svg>
                    ),
                  },
                  {
                    value: "copilot" as AgentMode,
                    label: t("aiStudio.agents.editor.mode.copilot"),
                    desc: t("aiStudio.agents.editor.mode.copilotDesc"),
                    icon: (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                      </svg>
                    ),
                  },
                  {
                    value: "autonomous" as AgentMode,
                    label: t("aiStudio.agents.editor.mode.autonomous"),
                    desc: t("aiStudio.agents.editor.mode.autonomousDesc"),
                    icon: (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                      </svg>
                    ),
                  },
                ]
              ).map(({ value, label, desc, icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => patch({ mode: value })}
                  className={clsx(
                    "w-full flex items-start gap-4 p-4 rounded-xl border text-left transition",
                    form.mode === value
                      ? "border-violet-300 bg-violet-50"
                      : "border-gray-100 bg-gray-50/40 hover:border-gray-200"
                  )}
                >
                  <div className={clsx(
                    "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                    form.mode === value ? "bg-violet-100 text-violet-600" : "bg-gray-100 text-gray-400"
                  )}>
                    {icon}
                  </div>
                  <div className="flex-1">
                    <p className={clsx("text-sm font-semibold", form.mode === value ? "text-violet-800" : "text-gray-800")}>
                      {label}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                  </div>
                  <div className={clsx(
                    "w-4 h-4 rounded-full border-2 mt-1 shrink-0 flex items-center justify-center",
                    form.mode === value ? "border-violet-500" : "border-gray-300"
                  )}>
                    {form.mode === value && <div className="w-2 h-2 rounded-full bg-violet-500" />}
                  </div>
                </button>
              ))}
            </div>
          </SectionCard>

          {/* ── Save button ── */}
          <div className="flex items-center gap-3 pb-8">
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-2 px-6 py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-60"
            >
              {saved ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  {t("aiStudio.agents.editor.saved")}
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
                  </svg>
                  {t("aiStudio.agents.editor.save")}
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => router.push("/ai-studio")}
              className="px-4 py-3 text-gray-500 hover:text-gray-700 text-sm transition"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
