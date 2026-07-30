"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDynamicParam } from "@/lib/useRouteParam";
import { aiStudioHref, normalizeAiStudioTab } from "@/lib/ai-studio-tabs";
import { AppLayout } from "@/components/AppLayout";
import { useI18n } from "@/context/I18nContext";
import { useAuth } from "@/context/AuthContext";
import { getAIAgent, getAIAgentReachability, getAIAgentEffectivePermissions, createAIAgent, updateAIAgent, deleteAIAgent, getDepartments, getMarketplaceIntegrations, getSystemKnowledgeBases, type EffectivePermissions } from "@/lib/api";
import { listFunnelSummaries, type FunnelSummary } from "@/lib/api-funnel";
import { getGoogleCalendarConnectUrl } from "@/lib/api-scheduler";
import clsx from "clsx";
import IntegrationDrawer from "@/components/IntegrationDrawer";
import KnowledgeDrawer from "@/components/KnowledgeDrawer";
import TestChatModal from "@/components/TestChatModal";
import { ReadinessReportModal, readinessScoreColor } from "@/components/ReadinessReport";
import { builderReadinessTest, type ReadinessReport } from "@/lib/gotcha-api";
// FunnelSection import removed - funnels are now managed at /settings/funnels.
// The agent is funnel-guided at runtime via resolveActiveStage; there is no
// per-agent funnel override config to edit on this page.
// Shared AI-employee creation experience. Lives in components/aiEmployee
// so onboarding renders the SAME wizard instead of maintaining a second,
// divergent one (see components/aiEmployee/AgentBuilder.tsx header).
import AgentBuilder from "@/components/aiEmployee/AgentBuilder";

// ─── Types ────────────────────────────────────────────────────
// (Tone type removed - personality is governed by the platform skill now.)
type AgentRole = "customer_support" | "sales" | "sdr" | "recruiting" | "booking" | "billing" | "research" | "custom";

// Roles for which a funnel binding is REQUIRED at save time (server
// enforces this too - see services/ai/src/routes/ai-agents.ts).
const FUNNEL_REQUIRED_ROLES: AgentRole[] = ["sales", "sdr", "recruiting"];
function roleRequiresFunnel(role: AgentRole | string): boolean {
  return (FUNNEL_REQUIRED_ROLES as string[]).includes(String(role));
}

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
  // Per-agent semantics (Tier 2). Both optional; null = use catalog defaults.
  description?: string;  // what this tool means FOR THIS AGENT
  usageRule?: string;    // when/how to use FOR THIS AGENT
  expanded?: boolean;    // local UI state - show the per-agent editor
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
  // description field removed per spec - agent identity is fully
  // expressed through structured fields (role, persona, identity,
  // behavioralAnchors, etc.). Free-text description was bypassing
  // the structured-prompt contract.
  // Required for non-funnel roles (Support, Research, Custom, Billing);
  // optional for Sales/SDR/Recruiting where the funnel stage provides
  // the goal. Always rendered into the system prompt when present.
  goal: string;
  successCriteria: string;
  avatarColor: string;
  tone: string;
  departmentId: string;
  funnelId: string;
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
  // Full persona JSON ({ gender, traits, brand_archetype, … }). Kept whole so a
  // brand_archetype edit doesn't wipe gender/traits set elsewhere - the PATCH
  // route replaces the whole persona object.
  persona: Record<string, unknown>;
  salesContext: {
    whatWeSell: string;
    idealCustomerProfile: string;
    problemsSolved: string[];
    expectedOutcomes: string[];
    qualificationSignals: string[];
    disqualifiers: string[];
  };
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
    goal: typeof agent.goal === "string" ? agent.goal : "",
    successCriteria: typeof agent.successCriteria === "string" ? agent.successCriteria : "",
    avatarColor: hexToGradient(agent.avatarColor) || "from-violet-400 to-violet-600",
    tone: agent.tone || "friendly",
    departmentId: agent.departmentId || "",
    funnelId: agent.funnelId || "",
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
      description: typeof t.description === "string" ? t.description : "",
      usageRule: typeof t.usageRule === "string" ? t.usageRule : "",
      expanded: false,
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
    persona: parsePersona(agent.persona),
    salesContext: {
      whatWeSell: agent.salesContext?.whatWeSell || "",
      idealCustomerProfile: agent.salesContext?.idealCustomerProfile || "",
      problemsSolved: agent.salesContext?.problemsSolved || [],
      expectedOutcomes: agent.salesContext?.expectedOutcomes || [],
      qualificationSignals: agent.salesContext?.qualificationSignals || [],
      disqualifiers: agent.salesContext?.disqualifiers || [],
    },
  };
}

function parsePersona(persona: any): Record<string, unknown> {
  if (!persona) return {};
  if (typeof persona === "string") {
    try { const p = JSON.parse(persona); return p && typeof p === "object" ? p : {}; }
    catch { return {}; }
  }
  return typeof persona === "object" ? persona : {};
}

const NEW_AGENT_DEFAULT: AgentFormData = {
  name: "",
  role: "custom",
  goal: "",
  successCriteria: "",
  avatarColor: "from-violet-400 to-violet-600",
  tone: "friendly",
  departmentId: "",
  funnelId: "",
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
  persona: {},
  salesContext: {
    whatWeSell: "",
    idealCustomerProfile: "",
    problemsSolved: [],
    expectedOutcomes: [],
    qualificationSignals: [],
    disqualifiers: [],
  },
};

// Brand Voice archetypes - keys MUST match services/ai/src/services/brand-archetypes.ts.
// "" = no strong flavor (renderer resolves it to the neutral default).
const BRAND_ARCHETYPE_OPTIONS: { value: string; en: string; he: string }[] = [
  { value: "", en: "Neutral / Professional (default)", he: "ניטרלי / מקצועי (ברירת מחדל)" },
  { value: "trusted_advisor", en: "Trusted Advisor - measured, credible, no hype", he: "יועץ מהימן - שקול, אמין, בלי הייפ" },
  { value: "high_energy_coach", en: "High-Energy Coach - short, fast, motivating", he: "מאמן אנרגטי - קצר, מהיר, מניע לפעולה" },
  { value: "luxury_concierge", en: "Luxury Concierge - refined, formal, deliberate", he: "קונסיירז' יוקרתי - מעודן, רשמי, מדוד" },
  { value: "beauty_consultant", en: "Beauty Consultant - warm, intimate, expressive", he: "יועצת יופי - חמה, אישית, אקספרסיבית" },
];

// ─── Small shared components ───────────────────────────────────
function SectionCard({ title, subtitle, children }: { title: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode }) {
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
  const id = useDynamicParam();
  const router = useRouter();
  const searchParams = useSearchParams();
  // An employee editor belongs to Overview; explicit ?returnTab= overrides.
  const _rt = searchParams.get("returnTab");
  const returnTab = _rt ? normalizeAiStudioTab(_rt) : "employees";
  const { t, locale } = useI18n();
  const { token } = useAuth();

  const isNew = id === "new";

  const [form, setForm] = useState<AgentFormData>(NEW_AGENT_DEFAULT);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set when the loaded agent is an INCOMPLETE wizard draft - we then resume
  // the builder at this step instead of dropping the user into the full editor.
  const [resumeStep, setResumeStep] = useState<string | null>(null);
  const [customRuleInput, setCustomRuleInput] = useState("");
  const [showCustomRuleInput, setShowCustomRuleInput] = useState(false);
  const [departments, setDepartments] = useState<any[]>([]);
  const [funnels, setFunnels] = useState<FunnelSummary[]>([]);
  const [showSkillsPanel, setShowSkillsPanel] = useState(false);
  const [showKnowledgePanel, setShowKnowledgePanel] = useState(false);
  const [showTestChat, setShowTestChat] = useState(false);
  // Readiness as an ongoing improvement loop: last persisted report + rerun,
  // accessible from the "what this employee can do" area of the editor.
  const [readinessReport, setReadinessReport] = useState<ReadinessReport | null>(null);
  const [readinessKbId, setReadinessKbId] = useState<string | null>(null);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [marketplaceIntegrations, setMarketplaceIntegrations] = useState<any[]>([]);
  // Integration groups the user has expanded in the Skills section. Groups start
  // collapsed: a tenant with several integrations connected has hundreds of
  // tools, which buries every other section on the page.
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set());
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);
  const [calendarCapability, setCalendarCapability] = useState<{
    capability: string;
    bookable: boolean;
    providers: string[];
    activeMeetingTypes: number;
    lastError: string | null;
  } | null>(null);

  const [reachability, setReachability] = useState<{ hasCanvas: boolean; reachable: boolean } | null>(null);
  const [effectivePerms, setEffectivePerms] = useState<EffectivePermissions | null>(null);

  useEffect(() => {
    if (isNew || !token) return;
    getAIAgentReachability(token, id)
      .then((res) => setReachability(res.data))
      .catch(() => setReachability(null));
    getAIAgentEffectivePermissions(token, id)
      .then((res) => setEffectivePerms(res.data))
      .catch(() => setEffectivePerms(null));
  }, [isNew, token, id]);

  useEffect(() => {
    if (isNew || !token) return;
    setLoading(true);
    setLoadError(null);
    getAIAgent(token, id)
      .then((res) => {
        if (res.data) {
          setForm(mapApiToForm(res.data));
          setCalendarCapability(res.data.calendarCapability ?? null);
          setReadinessReport((res.data.readinessReport as ReadinessReport | null) || null);
          setReadinessKbId(
            res.data.knowledgeSources?.[0]?.id
              || res.data.knowledgeBases?.[0]?.knowledgeBase?.id
              || null,
          );
          // Incomplete wizard draft → resume the builder at its saved step.
          const status = String(res.data.status || "").toUpperCase();
          if (status === "DRAFT" && res.data.builderStep) {
            setResumeStep(String(res.data.builderStep));
          } else {
            setResumeStep(null);
          }
        }
      })
      .catch((err: any) => {
        console.error("Failed to load agent:", err);
        // Surface 404 / 500 instead of silently bouncing - the redirect
        // was hiding a real backend error (P2022 on missing columns)
        // from operators trying to debug prod.
        const msg = err?.message || err?.error || "Failed to load AI Employee.";
        if (err?.status === 404) {
          router.push(aiStudioHref(returnTab));
        } else {
          setLoadError(typeof msg === "string" ? msg : "Failed to load AI Employee.");
        }
      })
      .finally(() => setLoading(false));
  }, [id, token, isNew]);

  // Load departments
  useEffect(() => {
    if (!token) return;
    getDepartments(token).then((res) => setDepartments((res as any)?.data || [])).catch(() => {});
  }, [token]);

  // Load funnels for the picker
  useEffect(() => {
    if (!token) return;
    listFunnelSummaries(token).then(setFunnels).catch(() => {});
  }, [token]);

  function patch(partial: Partial<AgentFormData>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    setSaveError(null);
    try {
      const channelsArr = Object.entries(form.channels)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const toolIds = form.tools
        .filter((t) => t.enabled && t.tenantToolId)
        .map((t) => t.tenantToolId);
      // Per-tool semantics overrides (Tier 2). Only sent for enabled tools
      // that have at least one of description/usageRule set, so unchanged
      // tools keep the route's default upsert path.
      const tools = form.tools
        .filter((t) => t.enabled && t.tenantToolId)
        .map((t) => ({
          tenantToolId: t.tenantToolId,
          description: (t.description ?? "").trim() || null,
          usageRule: (t.usageRule ?? "").trim() || null,
        }));
      const knowledgeBaseIds = form.knowledge
        .filter((k) => k.enabled)
        .map((k) => k.id);

      const payload = {
        name: form.name,
        role: form.role,
        goal: form.goal.trim() || null,
        successCriteria: form.successCriteria.trim() || null,
        avatarColor: GRADIENT_TO_HEX[form.avatarColor] || "#7c5cfc",
        tone: form.tone,
        departmentId: form.departmentId || null,
        funnelId: form.funnelId || null,
        languages: form.languages,
        style: form.style,
        channels: channelsArr,
        escalationRules: form.escalationRules,
        interactiveMessages: form.interactiveMessages,
        status: form.status.toUpperCase(),
        conversationFlow: form.conversationFlow.length > 0 ? form.conversationFlow : null,
        customGuardrails: form.customGuardrails.length > 0 ? form.customGuardrails : null,
        persona: Object.keys(form.persona).length > 0 ? form.persona : null,
        toolIds,
        tools,
        knowledgeBaseIds,
        salesContext: (() => {
          const sc = form.salesContext;
          return (sc.whatWeSell.trim() || sc.idealCustomerProfile.trim() || sc.problemsSolved.length || sc.expectedOutcomes.length || sc.qualificationSignals.length || sc.disqualifiers.length)
            ? {
                whatWeSell: sc.whatWeSell.trim(),
                idealCustomerProfile: sc.idealCustomerProfile.trim(),
                problemsSolved: sc.problemsSolved,
                expectedOutcomes: sc.expectedOutcomes,
                qualificationSignals: sc.qualificationSignals,
                disqualifiers: sc.disqualifiers,
              }
            : null;
        })(),
      };

      if (isNew) {
        const res = await createAIAgent(token, payload);
        router.push(`/ai-studio/agents/${res.data.id}`);
      } else {
        await updateAIAgent(token, id, payload);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } catch (err: any) {
      console.error("Save failed:", err);
      const msg =
        err?.message ||
        err?.error ||
        "Save failed. Please check required fields and try again.";
      setSaveError(typeof msg === "string" ? msg : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!token || isNew) return;
    try {
      await deleteAIAgent(token, id);
      router.push(aiStudioHref(returnTab));
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

  const toolGroupNames = Object.keys(toolsByIntegration);
  const allToolGroupsExpanded = toolGroupNames.length > 0 && toolGroupNames.every((g) => expandedToolGroups.has(g));

  function toggleToolGroup(integration: string) {
    setExpandedToolGroups((prev) => {
      const next = new Set(prev);
      if (next.has(integration)) next.delete(integration);
      else next.add(integration);
      return next;
    });
  }

  function toggleAllToolGroups() {
    setExpandedToolGroups(allToolGroupsExpanded ? new Set() : new Set(toolGroupNames));
  }

  /** Enable/disable every tool belonging to one integration in a single patch. */
  function setIntegrationToolsEnabled(integration: string, enabled: boolean) {
    patch({
      tools: form.tools.map((t) => (t.integration === integration ? { ...t, enabled } : t)),
    });
  }

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

  if (loadError) {
    return (
      <AppLayout>
        <div className="p-3 md:p-6 flex items-center justify-center h-screen">
          <div className="max-w-md w-full bg-white border border-red-200 rounded-2xl shadow-sm p-6 text-center space-y-3">
            <h2 className="text-lg font-semibold text-gray-900">Couldn&apos;t open this AI Employee</h2>
            <p className="text-sm text-gray-500">{loadError}</p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => router.push(aiStudioHref(returnTab))}
                className="px-3 py-1.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50"
              >
                Back to AI Studio
              </button>
              <button
                onClick={() => { setLoadError(null); router.refresh(); }}
                className="px-3 py-1.5 rounded-xl bg-violet-500 text-white text-sm hover:bg-violet-600"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  // ─── Dynamic AI Employee Builder (replaces the static wizard) ──
  // A goal-driven agent interviews the admin and assembles the whole
  // AIAgent config via tool-calls, with a live draft preview. On finish
  // it routes to this same editor (the DRAFT row, prefilled) to review
  // and Save.
  if (isNew) {
    return (
      <AppLayout>
        <AgentBuilder token={token || ""} onCancel={() => router.push(aiStudioHref(returnTab))} />
      </AppLayout>
    );
  }

  // Incomplete wizard draft → resume the builder at its saved step instead of
  // the full editor, so the user continues exactly where they stopped.
  if (resumeStep) {
    return (
      <AppLayout>
        <AgentBuilder
          token={token || ""}
          resumeAgentId={id}
          resumeStep={resumeStep as "chat" | "kb" | "refine" | "tools"}
          onCancel={() => router.push(aiStudioHref(returnTab))}
        />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Back button */}
        <button
          onClick={() => router.push(aiStudioHref(returnTab))}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm mb-5 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {t("aiStudio.agents.editor.backToStudio")}
        </button>

        <div className="max-w-2xl space-y-5">
          {saveError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <div className="flex-1">{saveError}</div>
              <button onClick={() => setSaveError(null)} className="text-red-500 hover:text-red-700" aria-label="Dismiss">×</button>
            </div>
          )}

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

          {/* Go-live honesty: an ACTIVE employee no playbook node routes to
              never receives a conversation. Say so instead of letting "live"
              be a broken promise. */}
          {reachability && !reachability.reachable && String(form.status).toUpperCase() === "ACTIVE" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-800 mb-1">
                ⚠️ {t("aiStudio.agents.editor.reachability.title")}
              </p>
              <p className="text-xs text-amber-700 mb-3">
                {reachability.hasCanvas
                  ? t("aiStudio.agents.editor.reachability.noNode")
                  : t("aiStudio.agents.editor.reachability.noCanvas")}
              </p>
              <button
                type="button"
                onClick={() => router.push(aiStudioHref("processes"))}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition"
              >
                {t("aiStudio.agents.editor.reachability.cta")}
              </button>
            </div>
          )}

          {/* Effective permissions (P1-8): the runtime AND-rule made visible -
              what this employee can ACTUALLY do right now (capability live AND
              granted). Only shown for saved employees with at least one live
              capability. */}
          {effectivePerms && effectivePerms.capabilities.some((c) => c.live) && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-sm font-semibold text-gray-800 mb-1">
                {t("aiStudio.agents.editor.effectivePerms.title")}
              </p>
              <p className="text-xs text-gray-400 mb-3">
                {t("aiStudio.agents.editor.effectivePerms.subtitle")}
              </p>
              <div className="space-y-2.5">
                {effectivePerms.capabilities.filter((c) => c.live).map((cap) => (
                  <div key={cap.capability}>
                    <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{cap.capability}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {cap.operations.map((op) => (
                        <span
                          key={op.name}
                          className={clsx(
                            "text-[11px] font-mono px-2 py-0.5 rounded border",
                            op.effective
                              ? "bg-green-50 text-green-700 border-green-200"
                              : "bg-gray-50 text-gray-400 border-gray-200 line-through"
                          )}
                          title={op.effective
                            ? t("aiStudio.agents.editor.effectivePerms.allowed")
                            : t("aiStudio.agents.editor.effectivePerms.blocked")}
                        >
                          {op.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Readiness - the permanent "what is it still missing" loop. Lives
              next to "what this employee can do" so improving the employee is
              one click away, not buried in the onboarding wizard. */}
          {!isNew && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 flex items-center gap-4">
              <div className={clsx("text-3xl font-bold shrink-0", readinessReport ? readinessScoreColor(readinessReport.score) : "text-gray-300")}>
                {readinessReport ? `${readinessReport.score}%` : "-"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-800">{t("aiStudio.agents.editor.readiness.title")}</p>
                <p className="text-xs text-gray-400">{t("aiStudio.agents.editor.readiness.subtitle")}</p>
              </div>
              {/* Opening only opens. The readiness test is an expensive LLM run,
                  so it fires solely from an explicit user action - the modal's
                  own "Run"/"Re-run" button - never as a side effect of viewing. */}
              <button
                type="button"
                onClick={() => setReadinessOpen(true)}
                className="shrink-0 text-xs font-semibold px-3.5 py-1.5 rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 transition"
              >
                {readinessReport ? t("aiStudio.agents.editor.readiness.open") : t("aiStudio.agents.editor.readiness.run")}
              </button>
            </div>
          )}

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
                onChange={(e) => {
                  const role = e.target.value as AgentRole;
                  // The funnel picker only renders for pipeline roles, so drop
                  // any existing binding when moving off one - otherwise the
                  // agent stays bound to a funnel through a control the user
                  // can no longer see.
                  patch(roleRequiresFunnel(role) ? { role } : { role, funnelId: "" });
                }}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
              >
                <option value="customer_support">{t("aiStudio.agents.editor.setup.roleSupport")}</option>
                <option value="sales">{t("aiStudio.agents.editor.setup.roleSales")}</option>
                <option value="sdr">SDR (outbound qualification)</option>
                <option value="recruiting">Recruiting</option>
                <option value="booking">{t("aiStudio.agents.editor.setup.roleBooking")}</option>
                <option value="billing">{t("aiStudio.agents.editor.setup.roleBilling")}</option>
                <option value="research">Research</option>
                <option value="custom">{t("aiStudio.agents.editor.setup.roleCustom")}</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {roleRequiresFunnel(form.role)
                  ? "Pipeline role - funnel binding is required below."
                  : "Outcome role - goal text is required below."}
              </p>
            </div>

            {/* Goal - always rendered into the system prompt. Required for
                non-funnel roles, optional but recommended for funnel roles. */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Goal
                {!roleRequiresFunnel(form.role) && <span className="text-red-400 ml-1">*</span>}
              </label>
              <textarea
                value={form.goal}
                onChange={(e) => patch({ goal: e.target.value })}
                placeholder="What outcome is this agent driving toward? One sentence. E.g. &quot;Resolve the customer's issue or escalate cleanly; capture CSAT signal.&quot;"
                rows={2}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
              />
              <p className="text-xs text-gray-400 mt-1">
                {roleRequiresFunnel(form.role)
                  ? "Optional. The funnel stage goal is the primary driver; this stacks beneath it."
                  : "Required. Rendered into every turn's prompt as the agent's anchor goal."}
              </p>
            </div>

            {/* Success criteria - measurable conditions that indicate "done". */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Success criteria
              </label>
              <textarea
                value={form.successCriteria}
                onChange={(e) => patch({ successCriteria: e.target.value })}
                placeholder='What does success look like? E.g. "Customer confirms issue resolved AND positive CSAT signal in transcript."'
                rows={2}
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
              />
              <p className="text-xs text-gray-400 mt-1">
                Optional but recommended. The bot uses this to decide when to close vs. continue.
              </p>
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

            {/* description textarea removed - the agent's identity is fully
                expressed through Personality (tone/style), Identity object,
                Behavioral anchors, and Custom guardrails below. Free-text
                description was bypassing the structured-prompt contract. */}
          </SectionCard>

          {/* Personality (tone + style) section removed - humanlike behavior
              is now governed centrally by the platform Personality skill
              (services/ai/src/prompts/personality.md), not per-agent toggles.
              The tone/style fields remain on the record for back-compat but are
              no longer edited here and no longer affect the prompt.

              Brand Voice IS the sanctioned per-agent voice dial: it shapes HOW
              the employee sounds (pace/warmth/vocabulary), layered on top of the
              central Personality skill - it never changes WHAT it does. */}
          <SectionCard
            title={locale === "he" ? "קול המותג" : "Brand Voice"}
            subtitle={
              locale === "he"
                ? "ארכיטיפ שמעצב איך העובד נשמע - קצב, חום ואוצר מילים. נשען על מנגנון האישיות המרכזי, לא מחליף אותו."
                : "An archetype that shapes how this employee sounds - pace, warmth, vocabulary. Layered on the central Personality skill; it never overrides strategy or guardrails."
            }
          >
            <label className="block text-xs font-medium text-gray-500 mb-1.5">
              {locale === "he" ? "ארכיטיפ" : "Archetype"}
            </label>
            <select
              value={typeof form.persona.brand_archetype === "string" ? form.persona.brand_archetype : ""}
              onChange={(e) =>
                patch({ persona: { ...form.persona, brand_archetype: e.target.value } })
              }
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
            >
              {BRAND_ARCHETYPE_OPTIONS.map((opt) => (
                <option key={opt.value || "neutral"} value={opt.value}>
                  {locale === "he" ? opt.he : opt.en}
                </option>
              ))}
            </select>
          </SectionCard>

          {/* ── Section 3: Skills (Tools) ── */}
          <SectionCard
            title={t("aiStudio.agents.editor.skills.title")}
            subtitle={t("aiStudio.agents.editor.skills.subtitle")}
          >
            {/* Calendar capability warning banner */}
            {calendarCapability && !calendarCapability.bookable && form.tools.some(t => t.enabled && /calendar|calendly/i.test(t.integration)) && (
              <div className={clsx(
                "mb-4 rounded-xl border p-4",
                calendarCapability.capability === "NO_CALENDAR"
                  ? "border-red-200 bg-red-50"
                  : "border-amber-200 bg-amber-50"
              )}>
                <p className={clsx(
                  "text-sm font-semibold mb-1",
                  calendarCapability.capability === "NO_CALENDAR" ? "text-red-800" : "text-amber-800"
                )}>
                  ⚠️{" "}
                  {calendarCapability.capability === "NO_CALENDAR"
                    ? "This AI Employee cannot book meetings"
                    : "No bookable meeting types"}
                </p>
                <p className={clsx(
                  "text-xs mb-3",
                  calendarCapability.capability === "NO_CALENDAR" ? "text-red-700" : "text-amber-700"
                )}>
                  {calendarCapability.capability === "NO_CALENDAR"
                    ? "Calendar tools are enabled but no calendar account is connected, so it cannot book meetings."
                    : "A calendar is connected, but there are no active meeting types, so this AI Employee still can’t book. Add a meeting type in Scheduling settings."}
                </p>
                {calendarCapability.capability === "NO_CALENDAR" && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const { url } = await getGoogleCalendarConnectUrl(token!, id);
                        window.location.href = url;
                      } catch (err) {
                        console.error("Failed to get calendar connect URL:", err);
                      }
                    }}
                    className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition"
                  >
                    Connect Google Calendar
                  </button>
                )}
              </div>
            )}

            {toolGroupNames.length > 1 && (
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  onClick={toggleAllToolGroups}
                  className="text-xs font-medium text-violet-600 hover:text-violet-700 px-2 py-1 rounded hover:bg-violet-50 transition"
                >
                  {allToolGroupsExpanded
                    ? t("aiStudio.agents.editor.skills.collapseAll")
                    : t("aiStudio.agents.editor.skills.expandAll")}
                </button>
              </div>
            )}

            {Object.entries(toolsByIntegration).map(([integration, tools]) => {
              const groupExpanded = expandedToolGroups.has(integration);
              const enabledCount = tools.filter((t) => t.enabled).length;
              const allEnabled = enabledCount === tools.length;
              return (
              <div key={integration} className="mb-4 last:mb-0">
                {/* Integration header - click to expand/collapse this group */}
                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => toggleToolGroup(integration)}
                    aria-expanded={groupExpanded}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left rounded-lg px-1 py-1 -mx-1 hover:bg-gray-50 transition"
                  >
                    <svg
                      className={clsx("w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform", groupExpanded && "rotate-90")}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    <div className="w-6 h-6 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0">
                      {integration.charAt(0)}
                    </div>
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide truncate">
                      {integration}
                    </span>
                    <span className={clsx(
                      "px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0",
                      enabledCount > 0
                        ? "bg-violet-50 text-violet-600 border-violet-200"
                        : "bg-gray-50 text-gray-400 border-gray-200"
                    )}>
                      {enabledCount}/{tools.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIntegrationToolsEnabled(integration, !allEnabled)}
                    className="text-xs font-medium text-violet-600 hover:text-violet-700 px-2 py-1 rounded hover:bg-violet-50 transition shrink-0"
                  >
                    {allEnabled
                      ? t("aiStudio.agents.editor.skills.clearGroup")
                      : t("aiStudio.agents.editor.skills.enableGroup")}
                  </button>
                </div>

                <div className={clsx("space-y-2", !groupExpanded && "hidden")}>
                  {tools.map((tool) => {
                    const hasOverrides = (tool.description ?? "").trim().length > 0 || (tool.usageRule ?? "").trim().length > 0;
                    return (
                    <div
                      key={tool.id}
                      className={clsx(
                        "rounded-xl border transition",
                        tool.enabled
                          ? "border-gray-200 bg-white"
                          : "border-gray-100 bg-gray-50/50"
                      )}
                    >
                      <div className="flex items-center gap-3 p-3">
                        <input
                          type="checkbox"
                          checked={tool.enabled}
                          onChange={() => toggleTool(tool.id)}
                          className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                        />
                        <span className="text-sm text-gray-800 flex-1">{tool.name}</span>
                        {hasOverrides && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium border bg-violet-50 text-violet-600 border-violet-200">
                            per-agent
                          </span>
                        )}
                        <RiskBadge risk={tool.risk} />
                        {tool.risk === "high" && tool.enabled && (
                          <svg className="w-4 h-4 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                          </svg>
                        )}
                        {tool.enabled && (
                          <button
                            type="button"
                            onClick={() => patch({
                              tools: form.tools.map((tt) => tt.id === tool.id ? { ...tt, expanded: !tt.expanded } : tt)
                            })}
                            className="text-xs text-violet-600 hover:text-violet-700 font-medium px-2 py-1 rounded hover:bg-violet-50 transition shrink-0"
                            title="Edit per-agent description and usage rule"
                          >
                            {tool.expanded ? "Hide" : "Edit"}
                          </button>
                        )}
                      </div>
                      {tool.enabled && tool.expanded && (
                        <div className="border-t border-gray-100 px-3 py-3 space-y-3 bg-gray-50/40">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Description for this agent
                              <span className="text-gray-400 font-normal"> (optional, overrides catalog)</span>
                            </label>
                            <textarea
                              value={tool.description ?? ""}
                              onChange={(e) => patch({
                                tools: form.tools.map((tt) => tt.id === tool.id ? { ...tt, description: e.target.value } : tt)
                              })}
                              placeholder="What this tool means FOR THIS AGENT. E.g. &quot;Schedule a follow-up call with the SDR team - not used for customer support tickets.&quot;"
                              rows={2}
                              className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none transition resize-none"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Usage rule for this agent
                              <span className="text-gray-400 font-normal"> (optional, stacks on catalog)</span>
                            </label>
                            <textarea
                              value={tool.usageRule ?? ""}
                              onChange={(e) => patch({
                                tools: form.tools.map((tt) => tt.id === tool.id ? { ...tt, usageRule: e.target.value } : tt)
                              })}
                              placeholder="When THIS AGENT should use it. E.g. &quot;Only after budget &gt; 10k confirmed. Never before qualifying the timeline.&quot;"
                              rows={2}
                              className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none transition resize-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
              );
            })}

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

          {/* ── Sales Context (sales-oriented roles only) ── */}
          {(["sales", "sdr", "customer_success"] as string[]).includes(form.role) && (
            <SectionCard
              title="Sales Context"
              subtitle="What you sell and who you sell to - used to qualify prospects against your actual offer."
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    What we sell
                  </label>
                  <textarea
                    value={form.salesContext.whatWeSell}
                    onChange={(e) => patch({ salesContext: { ...form.salesContext, whatWeSell: e.target.value } })}
                    placeholder="Describe your product or service in 1–2 sentences."
                    rows={2}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Ideal customer profile
                  </label>
                  <textarea
                    value={form.salesContext.idealCustomerProfile}
                    onChange={(e) => patch({ salesContext: { ...form.salesContext, idealCustomerProfile: e.target.value } })}
                    placeholder="Who is the perfect customer? E.g. company size, industry, role, pain points."
                    rows={2}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Problems solved
                    <span className="text-gray-400 font-normal ml-1 text-xs">(one per line)</span>
                  </label>
                  <textarea
                    value={form.salesContext.problemsSolved.join("\n")}
                    onChange={(e) => patch({ salesContext: { ...form.salesContext, problemsSolved: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) } })}
                    placeholder={"Manual process taking too long\nNo visibility into pipeline\nHigh churn from poor onboarding"}
                    rows={3}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expected outcomes
                    <span className="text-gray-400 font-normal ml-1 text-xs">(one per line)</span>
                  </label>
                  <textarea
                    value={form.salesContext.expectedOutcomes.join("\n")}
                    onChange={(e) => patch({ salesContext: { ...form.salesContext, expectedOutcomes: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) } })}
                    placeholder={"50% reduction in manual work\nFull pipeline visibility\n3x faster onboarding"}
                    rows={3}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Qualification signals
                    <span className="text-gray-400 font-normal ml-1 text-xs">(one per line)</span>
                  </label>
                  <textarea
                    value={form.salesContext.qualificationSignals.join("\n")}
                    onChange={(e) => patch({ salesContext: { ...form.salesContext, qualificationSignals: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) } })}
                    placeholder={"Budget > $10k/yr confirmed\nDecision maker in the call\nActive evaluation underway"}
                    rows={3}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Disqualifiers
                    <span className="text-gray-400 font-normal ml-1 text-xs">(one per line)</span>
                  </label>
                  <textarea
                    value={form.salesContext.disqualifiers.join("\n")}
                    onChange={(e) => patch({ salesContext: { ...form.salesContext, disqualifiers: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) } })}
                    placeholder={"Fewer than 10 employees\nNo budget for current quarter\nAlready locked in a contract"}
                    rows={3}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none"
                  />
                </div>
              </div>
            </SectionCard>
          )}

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

          {/* ── Section 5: Funnel binding ──
              The agent IS funnel-guided at runtime - `resolveActiveStage`
              runs on every turn (chat + voice) and injects the current
              stage's goal, required questions, data fields, and exit
              criteria into the prompt. Picker below pins a specific
              funnel to THIS agent; leaving it blank falls through to the
              channel override → department → tenant default.

              Only pipeline roles see this. A support or billing employee has
              no pipeline to run, so the picker was pure noise for them. The
              gate deliberately matches the SERVER's FUNNEL_REQUIRED_ROLES
              (ai-agents.ts) rather than a hand-written sales/sdr list: those
              roles 422 on save without a funnel, so hiding the only control
              that sets one would make them impossible to save. */}
          {roleRequiresFunnel(form.role) && (
          <SectionCard
            title={
              <span className="inline-flex items-center gap-1.5">
                Funnel
                <span className="text-red-400 text-sm">*</span>
              </span>
            }
            subtitle="Pipeline this AI employee runs - REQUIRED for this role."
          >
            <select
              value={form.funnelId}
              onChange={(e) => patch({ funnelId: e.target.value })}
              className={clsx(
                "w-full px-4 py-2.5 bg-gray-50 border rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:bg-white outline-none transition",
                !form.funnelId
                  ? "border-red-300 focus:border-red-400"
                  : "border-gray-200 focus:border-violet-300"
              )}
            >
              <option value="">- Select a funnel (required) -</option>
              {funnels.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.funnelId}
                  {f.departmentId ? "" : " (tenant default)"}
                  {f.isActive ? "" : " - inactive"}
                  {" · "}{f.stageCount} stages
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-2">
              Save will fail with 422 if no funnel is selected.
            </p>
            <a
              href="/settings/funnels"
              className="inline-flex items-center gap-1.5 mt-2 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition"
            >
              Manage funnels in Settings →
            </a>
          </SectionCard>
          )}

          {/* Action Contracts removed: the planner, capability layer and
              objective engine now decide the tool chain at runtime, so hand-wired
              deterministic contracts are no longer part of setting up an employee. */}

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


          {/* ── Section 8: Conversation Flow ── */}
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

          {/* ── Section 9: Custom Guardrails ── */}
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
              data-tour="save-ai-employee"
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
              onClick={() => router.push(aiStudioHref(returnTab))}
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

      {/* Integration Drawer (inline - no navigation) */}
      <IntegrationDrawer
        isOpen={showSkillsPanel}
        aiAgentId={id !== "new" ? id : undefined}
        onClose={() => {
          setShowSkillsPanel(false);
          // Refresh both the marketplace list (drawer UI) AND this agent's
          // tool list. The Skills section under the agent is scoped to
          // AgentToolPermission - NOT to every tenant-enabled tool - so we
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

      {/* Knowledge Drawer (inline - no navigation) */}
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

      <ReadinessReportModal
        open={readinessOpen}
        onClose={() => setReadinessOpen(false)}
        report={readinessReport}
        token={token || ""}
        kbId={readinessKbId}
        busy={readinessBusy}
        agentName={form.name || undefined}
        onRerun={async () => {
          if (!token || readinessBusy) return;
          setReadinessBusy(true);
          try {
            const res = await builderReadinessTest(token, id, locale);
            setReadinessReport(res.data);
          } catch { /* keep last report */ }
          finally { setReadinessBusy(false); }
        }}
      />
    </AppLayout>
  );
}
