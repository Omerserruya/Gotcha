"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { useI18n } from "@/context/I18nContext";
import { useAuth } from "@/context/AuthContext";
import { getAIAgent, createAIAgent, updateAIAgent, deleteAIAgent, generateAIEmployeeConfig, getDepartments, getMarketplaceIntegrations, getSystemKnowledgeBases } from "@/lib/api";
import clsx from "clsx";
import IntegrationDrawer from "@/components/IntegrationDrawer";
import KnowledgeDrawer from "@/components/KnowledgeDrawer";
import TestChatModal from "@/components/TestChatModal";
import FunnelSection from "@/components/FunnelSection";
import ActionContractsSection from "@/components/ActionContractsSection";

// ─── Types ────────────────────────────────────────────────────
type Tone = "professional" | "friendly" | "casual" | "formal";
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
  tenantToolId?: string;
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

interface ConversationFlowStep {
  id: string;
  action: string;
  details: string;
}

interface AgentFormData {
  name: string;
  role: AgentRole;
  description: string;
  avatarColor: string;
  tone: string;
  departmentId: string;
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
  status: "active" | "draft" | "paused";
  conversationFlow: ConversationFlowStep[];
  customGuardrails: string[];
}

// ─── Constants ─────────────────────────────────────────────────
const AVATAR_COLORS = [
  { value: "from-violet-400 to-violet-600", label: "Violet" },
  { value: "from-blue-400 to-blue-600", label: "Blue" },
  { value: "from-emerald-400 to-emerald-600", label: "Green" },
  { value: "from-rose-400 to-rose-600", label: "Rose" },
  { value: "from-amber-400 to-amber-600", label: "Amber" },
  { value: "from-cyan-400 to-cyan-600", label: "Cyan" },
];

const GRADIENT_TO_HEX: Record<string, string> = {
  "from-violet-400 to-violet-600": "#7c5cfc",
  "from-blue-400 to-blue-600": "#3b82f6",
  "from-emerald-400 to-emerald-600": "#10b981",
  "from-rose-400 to-rose-600": "#f43f5e",
  "from-amber-400 to-amber-600": "#f59e0b",
  "from-cyan-400 to-cyan-600": "#06b6d4",
};

const HEX_TO_GRADIENT: Record<string, string> = Object.fromEntries(
  Object.entries(GRADIENT_TO_HEX).map(([k, v]) => [v, k])
);

function hexToGradient(hex: string): string {
  return HEX_TO_GRADIENT[hex] || "from-violet-400 to-violet-600";
}

function parseChannels(channels: any): { whatsapp: boolean; instagram: boolean; webchat: boolean } {
  if (!channels) return { whatsapp: false, instagram: false, webchat: false };
  const arr = typeof channels === "string" ? JSON.parse(channels) : channels;
  if (Array.isArray(arr)) {
    return {
      whatsapp: arr.includes("whatsapp"),
      instagram: arr.includes("instagram"),
      webchat: arr.includes("webchat"),
    };
  }
  return channels;
}

function mapApiToForm(agent: any): AgentFormData {
  return {
    name: agent.name || "",
    role: (agent.role || "custom") as AgentRole,
    description: agent.description || "",
    avatarColor: hexToGradient(agent.avatarColor) || "from-violet-400 to-violet-600",
    tone: agent.tone || "friendly",
    departmentId: agent.departmentId || "",
    languages: typeof agent.languages === "string"
      ? JSON.parse(agent.languages)
      : (agent.languages || { english: true, hebrew: false, arabic: false }),
    style: typeof agent.style === "string"
      ? JSON.parse(agent.style)
      : (agent.style || { useEmojis: false, concise: true, useFirstName: false, proactive: false }),
    tools: (agent.tools || []).map((t: any) => ({
      id: t.id,
      tenantToolId: t.tenantToolId,
      name: t.name || "Unknown",
      integration: t.integration || "",
      risk: (t.risk || "low").toLowerCase() as "low" | "medium" | "high",
      enabled: t.enabled ?? true,
    })),
    knowledge: (agent.knowledgeBases || []).map((ak: any) => ({
      id: ak.knowledgeBase?.id || ak.id,
      name: ak.knowledgeBase?.name || ak.name || "Unknown",
      type: "Document",
      status: ak.knowledgeBase?.isActive ? "synced" : "error",
      enabled: true,
    })),
    escalationRules: typeof agent.escalationRules === "string"
      ? JSON.parse(agent.escalationRules)
      : (agent.escalationRules || []),
    interactiveMessages: typeof agent.interactiveMessages === "string"
      ? JSON.parse(agent.interactiveMessages)
      : (agent.interactiveMessages || {
          allowQuickReply: true,
          allowListMenu: false,
          allowCTA: false,
          autoSuggestMultipleOptions: true,
          autoSuggestYesNo: true,
          autoSuggestProductChoice: false,
          autoSuggestAlways: false,
        }),
    channels: parseChannels(agent.channels),
    status: ((agent.status || "DRAFT").toLowerCase()) as "active" | "draft" | "paused",
    conversationFlow: Array.isArray(agent.conversationFlow) ? agent.conversationFlow : [],
    customGuardrails: Array.isArray(agent.customGuardrails) ? agent.customGuardrails : [],
  };
}

const NEW_AGENT_DEFAULT: AgentFormData = {
  name: "",
  role: "custom",
  description: "",
  avatarColor: "from-violet-400 to-violet-600",
  tone: "friendly",
  departmentId: "",
  languages: { english: true, hebrew: false, arabic: false },
  style: { useEmojis: false, concise: true, useFirstName: false, proactive: false },
  tools: [],
  knowledge: [],
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
  status: "draft",
  conversationFlow: [],
  customGuardrails: [],
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
  const { token } = useAuth();

  const isNew = id === "new";

  const [form, setForm] = useState<AgentFormData>(NEW_AGENT_DEFAULT);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [customRuleInput, setCustomRuleInput] = useState("");
  const [showCustomRuleInput, setShowCustomRuleInput] = useState(false);
  const [departments, setDepartments] = useState<any[]>([]);
  const [showSkillsPanel, setShowSkillsPanel] = useState(false);
  const [showKnowledgePanel, setShowKnowledgePanel] = useState(false);
  const [showTestChat, setShowTestChat] = useState(false);
  const [marketplaceIntegrations, setMarketplaceIntegrations] = useState<any[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);

  // ─── Creation Wizard State ──────────────────────────────────
  const [wizardComplete, setWizardComplete] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardAnswers, setWizardAnswers] = useState<Record<string, string>>({});
  const [wizardGenerating, setWizardGenerating] = useState(false);
  const [wizardInput, setWizardInput] = useState("");

  const wizardChatRef = useRef<HTMLDivElement>(null);

  const WIZARD_QUESTIONS = [
    { key: "name", question: t("aiStudio.wizard.q1Name") },
    { key: "responsibility", question: t("aiStudio.wizard.q2Responsibility") },
    { key: "channels", question: t("aiStudio.wizard.q3Channels") },
    { key: "communication", question: t("aiStudio.wizard.q4Communication") },
    { key: "escalation", question: t("aiStudio.wizard.q5Escalation") },
    { key: "aiDisclosure", question: t("aiStudio.wizard.q6AiDisclosure") },
    { key: "extra", question: t("aiStudio.wizard.q7Extra") },
    { key: "conversationFlow", question: t("aiStudio.wizard.q8ConversationFlow") },
    { key: "guardrails", question: t("aiStudio.wizard.q9Guardrails") },
  ];

  // Auto-scroll wizard chat
  useEffect(() => {
    if (wizardChatRef.current) {
      wizardChatRef.current.scrollTop = wizardChatRef.current.scrollHeight;
    }
  }, [wizardStep, wizardAnswers, wizardGenerating]);

  function handleWizardAnswer() {
    if (!wizardInput.trim()) return;
    const currentQ = WIZARD_QUESTIONS[wizardStep];
    const newAnswers = { ...wizardAnswers, [currentQ.key]: wizardInput.trim() };
    setWizardAnswers(newAnswers);
    setWizardInput("");

    if (wizardStep < WIZARD_QUESTIONS.length - 1) {
      setWizardStep(wizardStep + 1);
    } else {
      // All questions answered — generate config
      finishWizard(newAnswers);
    }
  }

  function handleWizardSkip() {
    if (wizardStep < WIZARD_QUESTIONS.length - 1) {
      setWizardStep(wizardStep + 1);
    } else {
      finishWizard(wizardAnswers);
    }
  }

  async function finishWizard(answers: Record<string, string>) {
    setWizardGenerating(true);
    try {
      if (token) {
        const res = await generateAIEmployeeConfig(token, { answers });
        if (res.data) {
          // Map generated config back to form
          const generated = res.data;
          const patchData: Partial<AgentFormData> = {
            name: generated.name || answers.name || "",
            role: generated.role || "custom",
            description: generated.description || "",
            tone: generated.tone || "friendly",
            channels: {
              whatsapp: (answers.channels || "").toLowerCase().includes("whatsapp"),
              instagram: (answers.channels || "").toLowerCase().includes("instagram"),
              webchat: (answers.channels || "").toLowerCase().includes("web"),
            },
          };

          // Parse conversation flow from wizard answer
          if (answers.conversationFlow) {
            const steps = answers.conversationFlow
              .split(/[,\n]/)
              .map(s => s.trim())
              .filter(Boolean)
              .map((action, i) => ({ id: `cf_${Date.now()}_${i}`, action, details: "" }));
            if (steps.length > 0) patchData.conversationFlow = steps;
          }

          // Parse custom guardrails from wizard answer
          if (answers.guardrails) {
            const rules = answers.guardrails
              .split(/[,\n]/)
              .map(s => s.trim())
              .filter(Boolean);
            if (rules.length > 0) patchData.customGuardrails = rules;
          }

          patch(patchData);
        }
      }
    } catch (err) {
      console.error("Wizard generation failed:", err);
      // Still allow manual editing even if generation fails
      if (answers.name) patch({ name: answers.name });
    } finally {
      setWizardGenerating(false);
      setWizardComplete(true);
    }
  }

  useEffect(() => {
    if (isNew || !token) return;
    setLoading(true);
    getAIAgent(token, id)
      .then((res) => {
        if (res.data) {
          setForm(mapApiToForm(res.data));
        }
      })
      .catch((err) => {
        console.error("Failed to load agent:", err);
        router.push("/ai-studio");
      })
      .finally(() => setLoading(false));
  }, [id, token, isNew]);

  // Load departments
  useEffect(() => {
    if (!token) return;
    getDepartments(token).then((res) => setDepartments((res as any)?.data || [])).catch(() => {});
  }, [token]);

  function patch(partial: Partial<AgentFormData>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    try {
      const channelsArr = Object.entries(form.channels)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const toolIds = form.tools
        .filter((t) => t.enabled && t.tenantToolId)
        .map((t) => t.tenantToolId);
      const knowledgeBaseIds = form.knowledge
        .filter((k) => k.enabled)
        .map((k) => k.id);

      const payload = {
        name: form.name,
        role: form.role,
        description: form.description,
        avatarColor: GRADIENT_TO_HEX[form.avatarColor] || "#7c5cfc",
        tone: form.tone,
        languages: form.languages,
        style: form.style,
        channels: channelsArr,
        escalationRules: form.escalationRules,
        interactiveMessages: form.interactiveMessages,
        status: form.status.toUpperCase(),
        conversationFlow: form.conversationFlow.length > 0 ? form.conversationFlow : null,
        customGuardrails: form.customGuardrails.length > 0 ? form.customGuardrails : null,
        toolIds,
        knowledgeBaseIds,
      };

      if (isNew) {
        const res = await createAIAgent(token, payload);
        router.push(`/ai-studio/agents/${res.data.id}`);
      } else {
        await updateAIAgent(token, id, payload);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!token || isNew) return;
    try {
      await deleteAIAgent(token, id);
      router.push("/ai-studio");
    } catch (err) {
      console.error("Delete failed:", err);
    }
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

  if (loading) {
    return (
      <AppLayout>
        <div className="p-3 md:p-6 flex items-center justify-center h-screen">
          <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  // ─── Creation Wizard (chat-like onboarding) ─────────────────
  if (isNew && !wizardComplete) {
    return (
      <AppLayout>
        <div className="flex flex-col h-[calc(100vh-48px)] md:h-[calc(100vh-16px)]">
          {/* Fixed header */}
          <div className="shrink-0 p-3 md:p-6 pb-0">
            <button
              onClick={() => router.push("/ai-studio")}
              className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm mb-4 transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              {t("aiStudio.agents.editor.backToStudio")}
            </button>

            <div className="max-w-2xl mx-auto text-center mb-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white mx-auto mb-3 shadow-lg">
                <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <h1 className="text-xl font-bold text-gray-900">{t("aiStudio.wizard.title")}</h1>
              <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.wizard.subtitle")}</p>
              {/* Progress indicator */}
              <div className="flex items-center gap-1.5 mt-3 justify-center">
                {WIZARD_QUESTIONS.map((_, i) => (
                  <div
                    key={i}
                    className={clsx(
                      "h-1.5 rounded-full transition-all",
                      i < wizardStep ? "bg-violet-500 w-6" : i === wizardStep ? "bg-violet-400 w-4" : "bg-gray-200 w-1.5"
                    )}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Scrollable chat area */}
          <div ref={wizardChatRef} className="flex-1 overflow-y-auto px-3 md:px-6">
            <div className="max-w-2xl mx-auto space-y-4 pb-4">
              {WIZARD_QUESTIONS.slice(0, wizardStep + 1).map((q, i) => (
                <div key={q.key}>
                  {/* AI question bubble */}
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white shrink-0 mt-0.5">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                      </svg>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm max-w-md">
                      <p className="text-sm text-gray-800">{q.question}</p>
                    </div>
                  </div>
                  {/* User answer bubble */}
                  {wizardAnswers[q.key] && (
                    <div className="flex justify-end mb-2">
                      <div className="bg-violet-600 text-white rounded-2xl rounded-tr-sm px-4 py-3 max-w-md">
                        <p className="text-sm">{wizardAnswers[q.key]}</p>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Generating indicator */}
              {wizardGenerating && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white shrink-0">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                    </svg>
                  </div>
                  <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
                      <p className="text-sm text-gray-500">{t("aiStudio.wizard.generating")}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Fixed input area */}
          {!wizardGenerating && (
            <div className="shrink-0 px-3 md:px-6 py-3 border-t border-gray-100 bg-white">
              <div className="max-w-2xl mx-auto">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={wizardInput}
                    onChange={(e) => setWizardInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleWizardAnswer(); }}
                    placeholder={t("aiStudio.wizard.inputPlaceholder")}
                    autoFocus
                    className="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                  />
                  <button
                    onClick={handleWizardAnswer}
                    disabled={!wizardInput.trim()}
                    className="px-4 py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-40"
                  >
                    {t("common.send")}
                  </button>
                  <button
                    onClick={handleWizardSkip}
                    className="px-3 py-3 text-gray-400 hover:text-gray-600 text-sm transition"
                  >
                    {t("aiStudio.wizard.skip")}
                  </button>
                </div>
                <div className="text-center mt-2">
                  <button
                    onClick={() => setWizardComplete(true)}
                    className="text-xs text-gray-400 hover:text-gray-600 transition"
                  >
                    {t("aiStudio.wizard.skipAll")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </AppLayout>
    );
  }

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

            {/* Department */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("agents.department")}
              </label>
              <select
                value={form.departmentId}
                onChange={(e) => patch({ departmentId: e.target.value })}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
              >
                <option value="">{t("aiStudio.agents.editor.setup.tenantLevel")}</option>
                {departments.map((dept: any) => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">{t("aiStudio.agents.editor.setup.departmentHint")}</p>
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
            {/* Tone (multi-select) */}
            <div className="mb-5">
              <p className="text-sm font-medium text-gray-700 mb-2">
                {t("aiStudio.agents.editor.personality.tone")}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(["professional", "friendly", "casual", "formal"] as Tone[]).map((tone) => {
                  const tones = (form.tone || "").split(",").map(s => s.trim()).filter(Boolean);
                  const isSelected = tones.includes(tone);
                  return (
                    <button
                      key={tone}
                      type="button"
                      onClick={() => {
                        const updated = isSelected
                          ? tones.filter(t => t !== tone)
                          : [...tones, tone];
                        patch({ tone: updated.join(",") || "professional" });
                      }}
                      className={clsx(
                        "py-2 px-3 rounded-xl text-sm font-medium border transition capitalize",
                        isSelected
                          ? "bg-violet-50 border-violet-300 text-violet-700"
                          : "bg-gray-50 border-gray-200 text-gray-600 hover:border-gray-300"
                      )}
                    >
                      {t(`aiStudio.agents.editor.personality.tone_${tone}`)}
                    </button>
                  );
                })}
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
              onClick={async () => {
                setShowSkillsPanel(true);
                if (marketplaceIntegrations.length === 0 && token) {
                  setPanelLoading(true);
                  getMarketplaceIntegrations(token).then(res => setMarketplaceIntegrations((res as any)?.data || [])).catch(() => {}).finally(() => setPanelLoading(false));
                }
              }}
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
              onClick={async () => {
                setShowKnowledgePanel(true);
                if (knowledgeBases.length === 0 && token) {
                  setPanelLoading(true);
                  getSystemKnowledgeBases(token).then(res => setKnowledgeBases((res as any)?.data || [])).catch(() => {}).finally(() => setPanelLoading(false));
                }
              }}
              className="mt-3 flex items-center gap-2 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              {t("aiStudio.agents.editor.knowledge.addSource")}
            </button>
          </SectionCard>

          {/* ── Section 5: Funnel (BEL overlay) ── */}
          <SectionCard
            title="Funnel"
            subtitle="Stages, strategy & playbook overrides applied on top of the BEL for this employee's mode."
          >
            <FunnelSection />
          </SectionCard>

          {/* ── Section 6: Action Contracts (deterministic tool chains) ── */}
          <SectionCard
            title="Action Contracts"
            subtitle="When a business action fires, the bot is forced to call specific tools — no skipping, no reordering."
          >
            <ActionContractsSection />
          </SectionCard>

          {/* ── Section 7: Escalation Rules ── */}
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
                className="mt-3 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
              >
                + {t("aiStudio.agents.editor.escalation.addCustomRule")}
              </button>
            )}
          </SectionCard>


          {/* ── Section 6: Conversation Flow ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.conversationFlow.title")}
            subtitle={t("aiStudio.agents.editor.conversationFlow.subtitle")}
          >
              {form.conversationFlow.length === 0 ? (
                <p className="text-sm text-gray-400 py-2">{t("aiStudio.agents.editor.conversationFlow.emptyState")}</p>
              ) : (
                <div className="space-y-3">
                  {form.conversationFlow.map((step, idx) => (
                    <div key={step.id} className="p-3 rounded-xl border border-gray-100 bg-gray-50/40">
                      <div className="flex items-start gap-3">
                        <span className="w-6 h-6 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">{idx + 1}</span>
                        <div className="flex-1 min-w-0 space-y-2">
                          <input
                            type="text"
                            value={step.action}
                            onChange={(e) => {
                              const updated = [...form.conversationFlow];
                              updated[idx] = { ...step, action: e.target.value };
                              patch({ conversationFlow: updated });
                            }}
                            placeholder={t("aiStudio.agents.editor.conversationFlow.stepPlaceholder")}
                            className="w-full px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm focus:ring-1 focus:ring-violet-200 focus:border-violet-300 outline-none"
                          />
                          <input
                            type="text"
                            value={step.details}
                            onChange={(e) => {
                              const updated = [...form.conversationFlow];
                              updated[idx] = { ...step, details: e.target.value };
                              patch({ conversationFlow: updated });
                            }}
                            placeholder={t("aiStudio.agents.editor.conversationFlow.detailsPlaceholder")}
                            className="w-full px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-500 focus:ring-1 focus:ring-violet-200 focus:border-violet-300 outline-none"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => patch({ conversationFlow: form.conversationFlow.filter((_, i) => i !== idx) })}
                          className="p-1 rounded text-gray-300 hover:text-red-400 transition shrink-0"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => patch({ conversationFlow: [...form.conversationFlow, { id: `cf_${Date.now()}`, action: "", details: "" }] })}
                className="mt-3 text-sm text-violet-600 hover:text-violet-700 font-medium transition"
              >
                {t("aiStudio.agents.editor.conversationFlow.addStep")}
              </button>
              <p className="mt-2 text-xs text-gray-400">{t("aiStudio.agents.editor.conversationFlow.hint")}</p>
            </SectionCard>

          {/* ── Section 7: Custom Guardrails ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.customGuardrails.title")}
            subtitle={t("aiStudio.agents.editor.customGuardrails.subtitle")}
          >
            {form.customGuardrails.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">{t("aiStudio.agents.editor.customGuardrails.emptyState")}</p>
            ) : (
              <div className="space-y-2">
                {form.customGuardrails.map((rule, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-red-400 shrink-0">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      value={rule}
                      onChange={(e) => {
                        const updated = [...form.customGuardrails];
                        updated[idx] = e.target.value;
                        patch({ customGuardrails: updated });
                      }}
                      className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-1 focus:ring-red-200 focus:border-red-300 focus:bg-white outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => patch({ customGuardrails: form.customGuardrails.filter((_, i) => i !== idx) })}
                      className="p-1 rounded text-gray-300 hover:text-red-400 transition shrink-0"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => patch({ customGuardrails: [...form.customGuardrails, ""] })}
              className="mt-3 text-sm text-red-500 hover:text-red-600 font-medium transition"
            >
              {t("aiStudio.agents.editor.customGuardrails.addRule")}
            </button>
            <p className="mt-2 text-xs text-gray-400">{t("aiStudio.agents.editor.customGuardrails.hint")}</p>
          </SectionCard>

          {/* ── Save button ── */}
          <div className="flex items-center gap-3 pb-8">
            <button
              onClick={() => setShowTestChat(true)}
              disabled={isNew && !form.name}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-violet-200 text-violet-600 hover:bg-violet-50 text-sm font-medium transition disabled:opacity-40"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
              Test Agent
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-60"
            >
              {saving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {t("aiStudio.agents.editor.save")}
                </>
              ) : saved ? (
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
            {!isNew && (
              <button
                type="button"
                onClick={handleDelete}
                className="ml-auto flex items-center gap-2 px-4 py-3 text-red-400 hover:text-red-600 text-sm transition"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
                {t("common.delete")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Integration Drawer (inline — no navigation) */}
      <IntegrationDrawer
        isOpen={showSkillsPanel}
        aiAgentId={id !== "new" ? id : undefined}
        onClose={() => {
          setShowSkillsPanel(false);
          // Refresh both the marketplace list (drawer UI) AND this agent's
          // tool list. The Skills section under the agent is scoped to
          // AgentToolPermission — NOT to every tenant-enabled tool — so we
          // re-read the agent from the backend rather than rebuilding from
          // the marketplace response (which would wipe per-agent grants
          // on the next save).
          if (!token || !id || id === "new") return;
          Promise.all([
            getMarketplaceIntegrations(token).catch(() => ({ data: [] })),
            getAIAgent(token, id).catch(() => null),
          ]).then(([mkt, agentRes]) => {
            setMarketplaceIntegrations((mkt as any)?.data || []);
            const fresh = (agentRes as any)?.data;
            if (fresh?.tools) {
              patch({
                tools: fresh.tools.map((t: any) => ({
                  id: t.id,
                  tenantToolId: t.tenantToolId,
                  name: t.name || "Unknown",
                  integration: t.integration || "",
                  risk: (t.risk || "low").toLowerCase() as "low" | "medium" | "high",
                  enabled: t.enabled ?? true,
                })),
              });
            }
          });
        }}
      />

      {/* Knowledge Drawer (inline — no navigation) */}
      <KnowledgeDrawer
        isOpen={showKnowledgePanel}
        onClose={() => setShowKnowledgePanel(false)}
        linkedKbIds={form.knowledge.map(k => k.id)}
        onToggleKb={(kbId, linked) => {
          if (linked) {
            // Find KB name from knowledgeBases state or use id
            const kb = knowledgeBases.find((k: any) => k.id === kbId);
            patch({ knowledge: [...form.knowledge, { id: kbId, name: kb?.name || kbId, type: "Document", status: "synced", enabled: true }] });
          } else {
            patch({ knowledge: form.knowledge.filter(k => k.id !== kbId) });
          }
        }}
      />

      <TestChatModal
        isOpen={showTestChat}
        onClose={() => setShowTestChat(false)}
        agentId={id}
        agentName={form.name || "AI Agent"}
        avatarColor={form.avatarColor}
        token={token || ""}
      />
    </AppLayout>
  );
}
