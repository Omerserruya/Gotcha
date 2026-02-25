"use client";

import { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getCopilotSettings, updateCopilotSettings,
  getDepartments, getDepartmentCopilot, updateDepartmentCopilot,
  getDepartmentMembers, addDepartmentMember, removeDepartmentMember, updateDepartmentMember,
  getAgents,
} from "@/lib/api";
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

// Default initialization values for structured personality blocks
const DEFAULT_IDENTITY = { role: "", responsibility: "", representationGuidelines: [] as string[] };
const DEFAULT_GOALS = { focus: "", slaAwareness: "", conversionObjective: "", qualityExpectations: [] as string[] };
const DEFAULT_TONE = { formalityLevel: "professional_friendly", empathyLevel: "moderate", assertiveness: "moderate", brandAlignment: "" };
const DEFAULT_BEHAVIORAL = {
  escalationTriggers: [] as string[],
  noAutoReplyConditions: [] as string[],
  forbiddenActions: [] as string[],
  safetyBoundaries: [] as string[],
  confidenceHandling: {
    highConfidence: "Respond directly with the information",
    mediumConfidence: "Provide answer with appropriate caveats",
    lowConfidence: "Flag for human review before sending",
  },
};

// Collapsible card wrapper component
function CollapsibleCard({
  title,
  children,
  defaultOpen = false,
  headerRight,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  headerRight?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <div className="flex items-center justify-between cursor-pointer select-none" onClick={() => setOpen(!open)}>
        <h4 className="font-semibold text-gray-900 flex items-center gap-2">
          <svg
            className={clsx("w-4 h-4 text-violet-400 transition-transform", open ? "rotate-90" : "")}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          {title}
        </h4>
        <div onClick={(e) => e.stopPropagation()}>
          {headerRight}
        </div>
      </div>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

// Editable string list (add/remove items)
function EditableStringList({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
}) {
  function handleAdd() { onChange([...items, ""]); }
  function handleUpdate(i: number, v: string) { const u = [...items]; u[i] = v; onChange(u); }
  function handleRemove(i: number) { onChange(items.filter((_, idx) => idx !== i)); }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        <button
          onClick={handleAdd}
          className="text-xs px-2.5 py-1 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 font-medium transition flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add
        </button>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <p className="text-xs text-gray-300 italic py-2 text-center">No items yet</p>
        ) : (
          items.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-gray-400 font-mono w-5 shrink-0 text-end">{i + 1}</span>
              <input
                type="text"
                value={item}
                onChange={(e) => handleUpdate(i, e.target.value)}
                placeholder={placeholder || "Enter item..."}
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
              />
              <button
                onClick={() => handleRemove(i)}
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
  );
}

// Shared text input row
function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
      />
    </div>
  );
}

// Shared select row
function LabeledSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// "Initialize / Clear" button pair for null-state blocks
function InitClearButtons({ onInit, onClear }: { onInit: () => void; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onInit}
        className="text-xs px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 font-medium transition"
      >
        Initialize
      </button>
      <button
        onClick={onClear}
        className="text-xs px-3 py-1.5 bg-gray-100 text-gray-500 rounded-lg hover:bg-gray-200 font-medium transition"
      >
        Clear
      </button>
    </div>
  );
}

export default function CopilotPage() {
  const { token } = useAuth();
  const { t } = useI18n();

  // Department state
  const [departments, setDepartments] = useState<any[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null); // null = global
  const [deptSource, setDeptSource] = useState<string>("tenant");

  // Members state (for department tabs)
  const [members, setMembers] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [showAddMember, setShowAddMember] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);

  // Copilot settings state
  const [copilotMode, setCopilotMode] = useState<string>("READY_MESSAGE");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [rules, setRules] = useState<string[]>([]);
  const [tools, setTools] = useState<ToolConfig[]>(DEFAULT_TOOLS);
  const [model, setModel] = useState("gpt-4o-mini");
  const [provider, setProvider] = useState("openai");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  // Structured AI personality blocks
  const [identity, setIdentity] = useState<any>(null);
  const [goals, setGoals] = useState<any>(null);
  const [tone, setTone] = useState<any>(null);
  const [behavioral, setBehavioral] = useState<any>(null);

  // Load departments on mount
  useEffect(() => {
    if (!token) return;
    getDepartments(token).then((res) => setDepartments(res.data || [])).catch(console.error);
  }, [token]);

  // Load copilot settings when tab changes
  const loadSettings = useCallback(async () => {
    if (!token) return;
    try {
      if (selectedDeptId) {
        const res = await getDepartmentCopilot(token, selectedDeptId);
        setDeptSource(res.source);
        const d = res.data || {};
        setCopilotMode(d.copilotMode || "READY_MESSAGE");
        setSystemPrompt(d.systemPrompt || "");
        setRules(Array.isArray(d.rules) ? d.rules : []);
        setTools(Array.isArray(d.tools) && d.tools.length > 0 ? d.tools : DEFAULT_TOOLS);
        setModel(d.model || "gpt-4o-mini");
        setProvider(d.provider || "openai");
        setTemperature(d.temperature ?? 0.7);
        setMaxTokens(d.maxTokens ?? 1024);
        setIsActive(d.isActive ?? true);
        setIdentity(d.identity || null);
        setGoals(d.goals || null);
        setTone(d.tone || null);
        setBehavioral(d.behavioral || null);
      } else {
        const data = await getCopilotSettings(token);
        setDeptSource("tenant");
        setCopilotMode(data.copilotMode || "READY_MESSAGE");
        setSystemPrompt(data.systemPrompt || "");
        setRules(Array.isArray(data.rules) ? data.rules : []);
        setTools(Array.isArray(data.tools) && data.tools.length > 0 ? data.tools : DEFAULT_TOOLS);
        setModel(data.model || "gpt-4o-mini");
        setProvider(data.provider || "openai");
        setTemperature(data.temperature ?? 0.7);
        setMaxTokens(data.maxTokens ?? 1024);
        setIsActive(data.isActive ?? true);
        setIdentity(data.identity || null);
        setGoals(data.goals || null);
        setTone(data.tone || null);
        setBehavioral(data.behavioral || null);
      }
    } catch (err) {
      console.error(err);
    }
  }, [token, selectedDeptId]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  // Load members when a department is selected
  const loadMembers = useCallback(async () => {
    if (!token || !selectedDeptId) { setMembers([]); return; }
    setMembersLoading(true);
    try {
      const [membersRes, agentsRes] = await Promise.all([
        getDepartmentMembers(token, selectedDeptId),
        getAgents(token),
      ]);
      setMembers(membersRes.data);
      setAgents(Array.isArray(agentsRes) ? agentsRes : []);
    } catch (err) { console.error(err); }
    finally { setMembersLoading(false); }
  }, [token, selectedDeptId]);

  useEffect(() => { loadMembers(); }, [loadMembers]);

  async function handleSave() {
    if (!token) return;
    setLoading(true);
    try {
      const payload = { copilotMode, systemPrompt, rules, tools, model, provider, temperature, maxTokens, isActive, identity, goals, tone, behavioral };
      if (selectedDeptId) {
        await updateDepartmentCopilot(token, selectedDeptId, payload);
        setDeptSource("department");
      } else {
        await updateCopilotSettings(token, payload);
      }
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

  // Member management handlers
  async function handleAddMember(userId: string) {
    if (!token || !selectedDeptId) return;
    try {
      await addDepartmentMember(token, selectedDeptId, { userId, departmentRole: "AGENT" });
      setShowAddMember(false);
      loadMembers();
      getDepartments(token).then((res) => setDepartments(res.data || [])).catch(console.error);
    } catch (err: any) { alert(err.message); }
  }

  async function handleRemoveMember(userId: string) {
    if (!token || !selectedDeptId) return;
    try {
      await removeDepartmentMember(token, selectedDeptId, userId);
      loadMembers();
      getDepartments(token).then((res) => setDepartments(res.data || [])).catch(console.error);
    } catch (err: any) { alert(err.message); }
  }

  async function handleToggleRole(userId: string, currentRole: string) {
    if (!token || !selectedDeptId) return;
    const newRole = currentRole === "MANAGER" ? "AGENT" : "MANAGER";
    try {
      await updateDepartmentMember(token, selectedDeptId, userId, { departmentRole: newRole });
      loadMembers();
    } catch (err: any) { alert(err.message); }
  }

  const availableAgents = agents.filter((a: any) => !members.some((m: any) => m.userId === a.id));
  const selectedDept = departments.find((d) => d.id === selectedDeptId);
  const hasDepartments = departments.length > 0;

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900 ">{t("copilot.title")}</h1>
        </div>

        <div className="max-w-3xl space-y-6">
          {/* Header Card */}
          <div className="bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl p-5 text-white shadow-lg">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-lg">{t("copilot.settingsTitle")}</h3>
                <p className="text-white/80 text-sm">{t("copilot.desc")}</p>
              </div>
            </div>
          </div>

          {/* Department Tabs - only shown when departments exist */}
          {hasDepartments && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-2">
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                {/* Global tab */}
                <button
                  onClick={() => setSelectedDeptId(null)}
                  className={clsx(
                    "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all shrink-0",
                    selectedDeptId === null
                      ? "bg-violet-500 text-white shadow-md shadow-violet-200"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                  )}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                  </svg>
                  {t("copilot.global")}
                </button>

                <div className="w-px h-6 bg-gray-200 shrink-0" />

                {/* Department tabs */}
                {departments.map((dept) => (
                  <button
                    key={dept.id}
                    onClick={() => setSelectedDeptId(dept.id)}
                    className={clsx(
                      "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all shrink-0",
                      selectedDeptId === dept.id
                        ? "bg-violet-500 text-white shadow-md shadow-violet-200"
                        : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                    )}
                  >
                    <div className={clsx(
                      "w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold",
                      selectedDeptId === dept.id ? "bg-white/20 text-white" : "bg-gray-200 text-gray-500"
                    )}>
                      {dept.name?.charAt(0).toUpperCase()}
                    </div>
                    {dept.name}
                    <span className={clsx(
                      "text-[10px] px-1.5 py-0.5 rounded-full",
                      selectedDeptId === dept.id ? "bg-white/20" : "bg-gray-100 text-gray-400"
                    )}>
                      {dept._count?.members || 0}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Helper text for Default Template tab */}
          {!selectedDeptId && hasDepartments && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm bg-violet-50 text-violet-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
              </svg>
              {t("copilot.globalHelperText")}
            </div>
          )}

          {/* Source indicator for department */}
          {selectedDeptId && (
            <div className={clsx(
              "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm",
              deptSource === "department" ? "bg-violet-50 text-violet-600" : "bg-amber-50 text-amber-600"
            )}>
              {deptSource === "tenant" ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 me-1">
                  {t("copilot.usingDefaultTemplate")}
                </span>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
              )}
              {deptSource === "department" ? t("departments.copilotCustom") : t("departments.copilotInherited")}
            </div>
          )}

          {/* Members Section - only shown when a department is selected */}
          {selectedDeptId && selectedDept && (
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="font-semibold text-gray-900">{t("copilot.departmentMembers")}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">{selectedDept.name} - {members.length} {t("departments.members").toLowerCase()}</p>
                </div>
                <button
                  onClick={() => setShowAddMember(true)}
                  className="text-xs px-3 py-1.5 bg-primary-50 text-primary-600 rounded-lg hover:bg-primary-100 font-medium transition flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  {t("departments.addMember")}
                </button>
              </div>

              {membersLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="w-5 h-5 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                </div>
              ) : members.length === 0 ? (
                <p className="text-sm text-gray-300 text-center py-4 italic">{t("departments.noMembers")}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {members.map((m: any) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-full border border-gray-200 bg-gray-50 hover:bg-gray-100 transition group"
                    >
                      <div className="w-6 h-6 bg-gradient-to-br from-primary-100 to-primary-200 rounded-full flex items-center justify-center">
                        <span className="text-[10px] font-bold text-primary-600">{m.user?.name?.charAt(0).toUpperCase()}</span>
                      </div>
                      <span className="text-xs font-medium text-gray-700">{m.user?.name}</span>
                      <button
                        onClick={() => handleToggleRole(m.userId, m.departmentRole)}
                        className={clsx(
                          "text-[9px] px-1.5 py-0.5 rounded-full font-medium cursor-pointer transition",
                          m.departmentRole === "MANAGER" ? "bg-violet-100 text-violet-600 hover:bg-violet-200" : "bg-gray-200 text-gray-500 hover:bg-gray-300"
                        )}
                      >
                        {m.departmentRole === "MANAGER" ? t("departments.roleManager") : t("departments.roleAgent")}
                      </button>
                      <button
                        onClick={() => handleRemoveMember(m.userId)}
                        className="w-5 h-5 rounded-full flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition opacity-0 group-hover:opacity-100"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Active Toggle */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-semibold text-gray-900">{t("copilot.active")}</h4>
                <p className="text-sm text-gray-400 mt-0.5">{t("copilot.activeDesc")}</p>
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

          {/* Copilot Mode Toggle */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <h4 className="font-semibold text-gray-900 mb-1">{t("copilotMode.label")}</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
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
              <button
                onClick={() => setCopilotMode("CHAT")}
                className={clsx(
                  "p-4 rounded-xl border-2 text-start transition",
                  copilotMode === "CHAT" ? "border-violet-500 bg-violet-50" : "border-gray-200 hover:border-gray-300"
                )}
              >
                <p className="font-medium text-sm text-gray-900">{t("copilotMode.chat")}</p>
                <p className="text-xs text-gray-500 mt-1">{t("copilotMode.chatDesc")}</p>
              </button>
            </div>
          </div>

          {/* System Prompt */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <h4 className="font-semibold text-gray-900 mb-1">{t("copilot.systemPrompt")}</h4>
            <p className="text-sm text-gray-400 mb-3">{t("copilot.systemPromptDesc")}</p>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("copilot.systemPromptPlaceholder")}
              rows={6}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition resize-none font-mono"
            />
          </div>

          {/* Card A: Identity */}
          <CollapsibleCard
            title="AI Identity"
            headerRight={
              <InitClearButtons
                onInit={() => setIdentity({ ...DEFAULT_IDENTITY, representationGuidelines: [] })}
                onClear={() => setIdentity(null)}
              />
            }
          >
            {identity === null ? (
              <p className="text-sm text-gray-400 italic text-center py-3">
                Not configured. Click <span className="font-medium text-violet-600">Initialize</span> to define the AI identity, or leave as null to use auto-generated defaults.
              </p>
            ) : (
              <div className="space-y-4">
                <LabeledInput
                  label="Role"
                  value={identity.role || ""}
                  onChange={(v) => setIdentity({ ...identity, role: v })}
                  placeholder="e.g. Customer Support Specialist"
                />
                <LabeledInput
                  label="Responsibility"
                  value={identity.responsibility || ""}
                  onChange={(v) => setIdentity({ ...identity, responsibility: v })}
                  placeholder="e.g. Handle customer inquiries and resolve issues"
                />
                <EditableStringList
                  label="Representation Guidelines"
                  items={Array.isArray(identity.representationGuidelines) ? identity.representationGuidelines : []}
                  onChange={(items) => setIdentity({ ...identity, representationGuidelines: items })}
                  placeholder="e.g. Always introduce yourself by name"
                />
              </div>
            )}
          </CollapsibleCard>

          {/* Card B: Goals */}
          <CollapsibleCard
            title="AI Goals"
            headerRight={
              <InitClearButtons
                onInit={() => setGoals({ ...DEFAULT_GOALS, qualityExpectations: [] })}
                onClear={() => setGoals(null)}
              />
            }
          >
            {goals === null ? (
              <p className="text-sm text-gray-400 italic text-center py-3">
                Not configured. Click <span className="font-medium text-violet-600">Initialize</span> to define goals, or leave as null to use auto-generated defaults.
              </p>
            ) : (
              <div className="space-y-4">
                <LabeledInput
                  label="Focus"
                  value={goals.focus || ""}
                  onChange={(v) => setGoals({ ...goals, focus: v })}
                  placeholder="e.g. First-contact resolution"
                />
                <LabeledInput
                  label="SLA Awareness"
                  value={goals.slaAwareness || ""}
                  onChange={(v) => setGoals({ ...goals, slaAwareness: v })}
                  placeholder="e.g. Respond within 2 minutes during business hours"
                />
                <LabeledInput
                  label="Conversion Objective"
                  value={goals.conversionObjective || ""}
                  onChange={(v) => setGoals({ ...goals, conversionObjective: v })}
                  placeholder="e.g. Guide customer to self-service portal"
                />
                <EditableStringList
                  label="Quality Expectations"
                  items={Array.isArray(goals.qualityExpectations) ? goals.qualityExpectations : []}
                  onChange={(items) => setGoals({ ...goals, qualityExpectations: items })}
                  placeholder="e.g. Always verify understanding before closing"
                />
              </div>
            )}
          </CollapsibleCard>

          {/* Card C: Tone */}
          <CollapsibleCard
            title="AI Tone"
            headerRight={
              <InitClearButtons
                onInit={() => setTone({ ...DEFAULT_TONE })}
                onClear={() => setTone(null)}
              />
            }
          >
            {tone === null ? (
              <p className="text-sm text-gray-400 italic text-center py-3">
                Not configured. Click <span className="font-medium text-violet-600">Initialize</span> to configure tone, or leave as null to use auto-generated defaults.
              </p>
            ) : (
              <div className="space-y-4">
                <LabeledSelect
                  label="Formality Level"
                  value={tone.formalityLevel || "professional_friendly"}
                  onChange={(v) => setTone({ ...tone, formalityLevel: v })}
                  options={[
                    { value: "professional_friendly", label: "Professional Friendly" },
                    { value: "warm_professional", label: "Warm Professional" },
                    { value: "precise_professional", label: "Precise Professional" },
                    { value: "business_formal", label: "Business Formal" },
                    { value: "concise_professional", label: "Concise Professional" },
                    { value: "efficient_professional", label: "Efficient Professional" },
                    { value: "professional", label: "Professional" },
                  ]}
                />
                <LabeledSelect
                  label="Empathy Level"
                  value={tone.empathyLevel || "moderate"}
                  onChange={(v) => setTone({ ...tone, empathyLevel: v })}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "moderate", label: "Moderate" },
                    { value: "high", label: "High" },
                    { value: "very_high", label: "Very High" },
                  ]}
                />
                <LabeledSelect
                  label="Assertiveness"
                  value={tone.assertiveness || "moderate"}
                  onChange={(v) => setTone({ ...tone, assertiveness: v })}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "moderate", label: "Moderate" },
                    { value: "high", label: "High" },
                  ]}
                />
                <LabeledInput
                  label="Brand Alignment"
                  value={tone.brandAlignment || ""}
                  onChange={(v) => setTone({ ...tone, brandAlignment: v })}
                  placeholder="e.g. Friendly and approachable, consistent with brand voice"
                />
              </div>
            )}
          </CollapsibleCard>

          {/* Card D: Behavioral Rules */}
          <CollapsibleCard
            title="Behavioral Rules"
            headerRight={
              <InitClearButtons
                onInit={() => setBehavioral({
                  escalationTriggers: [],
                  noAutoReplyConditions: [],
                  forbiddenActions: [],
                  safetyBoundaries: [],
                  confidenceHandling: { ...DEFAULT_BEHAVIORAL.confidenceHandling },
                })}
                onClear={() => setBehavioral(null)}
              />
            }
          >
            {behavioral === null ? (
              <p className="text-sm text-gray-400 italic text-center py-3">
                Not configured. Click <span className="font-medium text-violet-600">Initialize</span> to define behavioral rules, or leave as null to use auto-generated defaults.
              </p>
            ) : (
              <div className="space-y-5">
                <EditableStringList
                  label="Escalation Triggers"
                  items={Array.isArray(behavioral.escalationTriggers) ? behavioral.escalationTriggers : []}
                  onChange={(items) => setBehavioral({ ...behavioral, escalationTriggers: items })}
                  placeholder="e.g. Customer expresses frustration or anger"
                />
                <EditableStringList
                  label="No Auto-Reply Conditions"
                  items={Array.isArray(behavioral.noAutoReplyConditions) ? behavioral.noAutoReplyConditions : []}
                  onChange={(items) => setBehavioral({ ...behavioral, noAutoReplyConditions: items })}
                  placeholder="e.g. Legal or compliance-related inquiries"
                />
                <EditableStringList
                  label="Forbidden Actions"
                  items={Array.isArray(behavioral.forbiddenActions) ? behavioral.forbiddenActions : []}
                  onChange={(items) => setBehavioral({ ...behavioral, forbiddenActions: items })}
                  placeholder="e.g. Never share internal pricing strategies"
                />
                <EditableStringList
                  label="Safety Boundaries"
                  items={Array.isArray(behavioral.safetyBoundaries) ? behavioral.safetyBoundaries : []}
                  onChange={(items) => setBehavioral({ ...behavioral, safetyBoundaries: items })}
                  placeholder="e.g. Do not provide medical or legal advice"
                />
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Confidence Handling</p>
                  <div className="space-y-3 pl-3 border-l-2 border-violet-100">
                    <LabeledInput
                      label="High Confidence"
                      value={behavioral.confidenceHandling?.highConfidence || ""}
                      onChange={(v) => setBehavioral({
                        ...behavioral,
                        confidenceHandling: { ...behavioral.confidenceHandling, highConfidence: v },
                      })}
                      placeholder="e.g. Respond directly with the information"
                    />
                    <LabeledInput
                      label="Medium Confidence"
                      value={behavioral.confidenceHandling?.mediumConfidence || ""}
                      onChange={(v) => setBehavioral({
                        ...behavioral,
                        confidenceHandling: { ...behavioral.confidenceHandling, mediumConfidence: v },
                      })}
                      placeholder="e.g. Provide answer with appropriate caveats"
                    />
                    <LabeledInput
                      label="Low Confidence"
                      value={behavioral.confidenceHandling?.lowConfidence || ""}
                      onChange={(v) => setBehavioral({
                        ...behavioral,
                        confidenceHandling: { ...behavioral.confidenceHandling, lowConfidence: v },
                      })}
                      placeholder="e.g. Flag for human review before sending"
                    />
                  </div>
                </div>
              </div>
            )}
          </CollapsibleCard>

          {/* Rules */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-1">
              <h4 className="font-semibold text-gray-900">{t("copilot.rules")}</h4>
              <button
                onClick={handleAddRule}
                className="text-xs px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 font-medium transition flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                {t("copilot.addRule")}
              </button>
            </div>
            <p className="text-sm text-gray-400 mb-3">{t("copilot.rulesDesc")}</p>
            <div className="space-y-2">
              {rules.length === 0 ? (
                <p className="text-sm text-gray-300 italic py-3 text-center">{t("common.noResults")}</p>
              ) : (
                rules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 font-mono w-5 shrink-0 text-end">{i + 1}</span>
                    <input
                      type="text"
                      value={rule}
                      onChange={(e) => handleUpdateRule(i, e.target.value)}
                      placeholder={t("copilot.rulePlaceholder")}
                      className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
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
            <h4 className="font-semibold text-gray-900 mb-1">{t("copilot.tools")}</h4>
            <p className="text-sm text-gray-400 mb-3">{t("copilot.toolsDesc")}</p>
            <div className="space-y-2">
              {tools.map((tool) => (
                <div key={tool.id} className={clsx(
                  "flex items-center justify-between p-3 rounded-xl border transition",
                  tool.enabled ? "bg-violet-50/50 border-violet-100" : "bg-gray-50 border-gray-100"
                )}>
                  <div className="flex items-center gap-3">
                    <div className={clsx(
                      "w-8 h-8 rounded-lg flex items-center justify-center",
                      tool.enabled ? "bg-violet-100" : "bg-gray-200"
                    )}>
                      {tool.id === "kb_search" ? (
                        <svg className={clsx("w-4 h-4", tool.enabled ? "text-violet-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                        </svg>
                      ) : tool.id === "conversation_history" ? (
                        <svg className={clsx("w-4 h-4", tool.enabled ? "text-violet-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      ) : tool.id === "customer_lookup" ? (
                        <svg className={clsx("w-4 h-4", tool.enabled ? "text-violet-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                        </svg>
                      ) : (
                        <svg className={clsx("w-4 h-4", tool.enabled ? "text-violet-600" : "text-gray-400")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
                      tool.enabled ? "bg-violet-500" : "bg-gray-300"
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
            <h4 className="font-semibold text-gray-900 mb-3">{t("copilot.modelSettings")}</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("copilot.provider")}</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google AI</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("copilot.model")}</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
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
                  {t("copilot.temperature")}: {temperature.toFixed(1)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full accent-violet-500"
                />
                <p className="text-[11px] text-gray-400 mt-1">{t("copilot.temperatureDesc")}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("copilot.maxTokens")}</label>
                <input
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
                  min={1}
                  max={8192}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition"
                />
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex items-center gap-3 pb-6">
            <button
              onClick={handleSave}
              disabled={loading}
              className="bg-violet-600 hover:bg-violet-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              )}
              {loading ? t("common.loading") : t("copilot.save")}
            </button>
            {saved && (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {t("copilot.saved")}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Add Member Dialog */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="font-bold text-gray-900 mb-1">{t("departments.addMember")}</h3>
            <p className="text-xs text-gray-400 mb-4">{t("departments.selectAgent")}</p>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {availableAgents.map((agent: any) => (
                <button key={agent.id} onClick={() => handleAddMember(agent.id)} disabled={!agent.isActive} className="w-full text-start p-3 rounded-xl border border-gray-100 hover:bg-primary-50 hover:border-primary-200 transition disabled:opacity-40">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-gradient-to-br from-primary-100 to-primary-200 rounded-lg flex items-center justify-center">
                      <span className="text-xs font-bold text-primary-600">{agent.name?.charAt(0).toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-gray-900">{agent.name}</p>
                      <p className="text-xs text-gray-400">{agent.email}</p>
                    </div>
                    {agent.departmentName && (
                      <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{agent.departmentName}</span>
                    )}
                  </div>
                </button>
              ))}
              {availableAgents.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">{t("common.noResults")}</p>
              )}
            </div>
            <button onClick={() => setShowAddMember(false)} className="w-full mt-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-xl transition">
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
