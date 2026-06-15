"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getMarketplaceIntegrations, getAIAgents, getChatbotFlows, getFlowCanvas, getKnowledgeBases, deleteChatbotFlow } from "@/lib/api";
import { INTEGRATION_LOGOS, logoForIntegration } from "@/lib/integration-logos";
import clsx from "clsx";
import TestChatModal from "@/components/TestChatModal";

// ─── Tab types ────────────────────────────────────────────────
type Tab = "team" | "playbooks" | "knowledge" | "skills";

const TAB_KEYS: Tab[] = ["team", "playbooks", "knowledge", "skills"];

function isTab(value: string | null): value is Tab {
  return value !== null && (TAB_KEYS as string[]).includes(value);
}

// Real connected tools come from the /api/integrations response
// (shape: [{name, slug, tenantConnection:{status}, catalogTools:[{name, riskLevel, tenantTool:{isEnabled}}]}]).
// The hardcoded MOCK_TOOLS list that used to live here has been replaced with
// live data - see the "connectedIntegrations" derivation inside SkillsTab.

// ─── Stat card ────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  color: string;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 flex items-start gap-4">
      <div className={clsx("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", color)}>
        {icon}
      </div>
      <div>
        <p className="text-xs text-gray-400 font-medium">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-0.5">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    draft: "bg-gray-100 text-gray-500",
    paused: "bg-yellow-100 text-yellow-700",
    synced: "bg-green-100 text-green-700",
    syncing: "bg-blue-100 text-blue-700",
    connected: "bg-green-100 text-green-700",
  };
  return (
    <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium capitalize", map[status] || "bg-gray-100 text-gray-500")}>
      {status}
    </span>
  );
}

// ─── Risk badge ───────────────────────────────────────────────
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

// ─── Team Members Tab ─────────────────────────────────────────
function TeamTab({ t }: { t: (key: string) => string }) {
  const { token } = useAuth();
  const router = useRouter();
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [testAgent, setTestAgent] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    getAIAgents(token)
      .then((res) => setAgents(res.data || []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.team.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.team.subtitle")}</p>
        </div>
        <Link
          href="/ai-studio/agents/new"
          data-tour="create-ai-employee"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("aiStudio.team.addMember")}
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => {
          const channels: string[] = typeof agent.channels === "string"
            ? (() => { try { return JSON.parse(agent.channels); } catch { return []; } })()
            : (agent.channels || []);
          const status = agent.status?.toLowerCase() || "draft";
          const knowledgeCount = agent.knowledgeSources?.length || 0;
          const skillsCount = agent.toolCount || 0;
          return (
          <div
            key={agent.id}
            className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 hover:shadow-md hover:border-violet-200 transition cursor-pointer"
            onClick={() => router.push(`/ai-studio/agents/${agent.id}`)}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
                {agent.name.charAt(0)}
              </div>
              <StatusBadge status={status} />
            </div>
            <h3 className="font-semibold text-gray-900">{agent.name}</h3>
            <p className="text-xs text-gray-400 mt-0.5 mb-2">{agent.role}</p>

            {/* Connected resources */}
            <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
                {knowledgeCount} {t("aiStudio.team.knowledge")}
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
                </svg>
                {skillsCount} {t("aiStudio.team.skills")}
              </span>
            </div>

            {/* Channels */}
            {channels.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {channels.slice(0, 3).map((ch: string) => (
                  <span key={ch} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 capitalize">{ch}</span>
                ))}
                {channels.length > 3 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">+{channels.length - 3}</span>
                )}
              </div>
            )}

            <div className="mt-4 pt-4 border-t border-gray-50 flex gap-2">
              <Link
                href={`/ai-studio/agents/${agent.id}`}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 py-1.5 rounded-lg bg-violet-50 text-violet-700 text-xs font-medium hover:bg-violet-100 transition text-center"
              >
                {t("aiStudio.edit")}
              </Link>
              <button
                onClick={(e) => { e.stopPropagation(); setTestAgent({ id: agent.id, name: agent.name }); }}
                className="py-1.5 px-3 rounded-lg bg-gray-50 text-gray-500 text-xs font-medium hover:bg-gray-100 transition"
              >
                {t("aiStudio.test")}
              </button>
            </div>
          </div>
          );
        })}

        {/* New member placeholder - always first when no agents */}
        <Link
          href="/ai-studio/agents/new"
          data-tour="create-ai-employee-empty"
          className={clsx(
            "bg-white rounded-2xl border-2 border-dashed border-gray-200 p-5 flex flex-col items-center justify-center gap-3 hover:border-violet-300 hover:bg-violet-50/30 transition cursor-pointer",
            agents.length === 0 ? "col-span-full min-h-[200px]" : "min-h-[160px]"
          )}
        >
          <div className="w-12 h-12 rounded-xl bg-violet-50 flex items-center justify-center">
            <svg className="w-6 h-6 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-sm text-violet-600 font-semibold">{t("aiStudio.team.addMember")}</p>
            <p className="text-xs text-gray-400 mt-1">{t("aiStudio.team.addMemberHint")}</p>
          </div>
        </Link>
      </div>
      )}

      {testAgent && token && (
        <TestChatModal
          isOpen={!!testAgent}
          onClose={() => setTestAgent(null)}
          agentId={testAgent.id}
          agentName={testAgent.name}
          avatarColor="from-violet-400 to-violet-600"
          token={token}
        />
      )}
    </div>
  );
}

// ─── Playbooks Tab (Simplified) ──────────────────────────────
// OLD: StepTypeIcon, RouteTypeBadge, PlaybookGraph removed

function PlaybooksTab({ t }: { t: (key: string) => string }) {
  const { token } = useAuth();
  const router = useRouter();
  const [flows, setFlows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Main Playbook node count - surfaces actual flow-canvas content rather
  // than the legacy RouterRule count (those are a separate, sibling system).
  // Excludes the synthetic `trigger_section_header` decorations.
  const [mainPlaybookNodeCount, setMainPlaybookNodeCount] = useState(0);

  useEffect(() => {
    if (!token) return;
    Promise.all([
      getChatbotFlows(token).then((r) => (Array.isArray(r) ? r : (r as any).data || [])),
      getFlowCanvas(token).then((r) => (r.data || { nodes: [] })),
    ])
      .then(([flowsData, canvas]) => {
        setFlows(flowsData);
        const nodes = Array.isArray((canvas as any).nodes) ? (canvas as any).nodes : [];
        setMainPlaybookNodeCount(
          nodes.filter((n: any) => n?.type !== "trigger_section_header").length,
        );
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  function toggleFlow(id: string) {
    setFlows((prev) => prev.map((f) => f.id === id ? { ...f, isActive: !f.isActive } : f));
  }

  async function handleDeleteFlow(id: string) {
    if (!token) return;
    if (!confirm("Are you sure you want to delete this flow?")) return;
    try {
      await deleteChatbotFlow(token, id);
      setFlows((prev) => prev.filter((f) => f.id !== id));
    } catch {
      // silently ignore
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.playbooks.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.playbooks.subtitle")}</p>
        </div>
        <Link
          href="/ai-studio/router?templates=open"
          className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50 hover:border-gray-300 transition shadow-sm mr-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z" />
          </svg>
          Templates
        </Link>
        <Link
          href="/ai-studio/flows/new"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("aiStudio.playbooks.newPlaybook")}
        </Link>
      </div>

      {/* Main Playbook Card */}
      <div
        onClick={() => router.push("/ai-studio/router")}
        className="bg-white rounded-2xl shadow-card border-2 border-violet-100 overflow-hidden mb-6 cursor-pointer hover:shadow-md hover:border-violet-200 transition group"
      >
        <div className="flex items-center justify-between px-5 py-5 bg-gradient-to-r from-violet-50 to-violet-50/30">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center shadow-sm">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
              </svg>
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">{t("aiStudio.playbooks.mainPlaybook")}</h3>
              <p className="text-xs text-gray-400 mt-0.5">{t("aiStudio.playbooks.mainPlaybookSub")}</p>
              {mainPlaybookNodeCount > 0 && (
                <p className="text-xs text-violet-500 mt-1 font-medium">{mainPlaybookNodeCount} node{mainPlaybookNodeCount !== 1 ? "s" : ""} configured</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-violet-600 font-medium group-hover:text-violet-700 transition hidden sm:block">
              {t("aiStudio.playbooks.editMainPlaybook")}
            </span>
            <svg className="w-5 h-5 text-violet-400 group-hover:text-violet-600 group-hover:translate-x-0.5 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        </div>
      </div>

      {/* Sub-Playbooks */}
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-700">{t("aiStudio.playbooks.subPlaybooks")}</h3>
        <span className="text-xs text-gray-400">({flows.length})</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-24">
          <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      ) : (
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {flows.length === 0 && (
          <div className="px-5 py-8 text-center text-gray-400">
            <p className="text-sm">No playbooks yet</p>
          </div>
        )}
        {flows.map((flow, i) => (
          <div
            key={flow.id}
            className={clsx(
              "flex items-center gap-4 px-5 py-4 hover:bg-gray-50/60 transition",
              i < flows.length - 1 && "border-b border-gray-50"
            )}
          >
            <div className="w-9 h-9 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            </div>

            <div
              className="flex-1 min-w-0 cursor-pointer"
              onClick={() => router.push(`/ai-studio/flows/${flow.id}`)}
            >
              <p className="text-sm font-semibold text-gray-900 hover:text-violet-700 transition">{flow.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">{t("aiStudio.flows.trigger")}: {flow.trigger}</p>
            </div>

            <div className="text-right hidden sm:block">
              <p className="text-sm font-semibold text-gray-800">{flow.runCount ?? 0}</p>
              <p className="text-xs text-gray-400">{t("aiStudio.playbooks.runs")}</p>
            </div>

            <button
              onClick={() => toggleFlow(flow.id)}
              className={clsx(
                "relative w-10 h-5.5 rounded-full transition-colors shrink-0",
                flow.isActive ? "bg-violet-500" : "bg-gray-200"
              )}
              style={{ width: 40, height: 22 }}
            >
              <span
                className={clsx(
                  "absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform",
                  flow.isActive && "translate-x-[18px]"
                )}
              />
            </button>

            <Link
              href={`/ai-studio/flows/${flow.id}`}
              className="p-1.5 rounded-lg text-gray-400 hover:text-violet-600 hover:bg-violet-50 transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
            </Link>

            <button
              onClick={() => handleDeleteFlow(flow.id)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition"
              title="Delete flow"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      )}

      <Link
        href="/ai-studio/flows/new"
        className="mt-4 bg-white rounded-2xl border-2 border-dashed border-gray-200 px-5 py-4 flex items-center gap-4 hover:border-violet-300 hover:bg-violet-50/30 transition cursor-pointer"
      >
        <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </div>
        <p className="text-sm text-gray-400 font-medium">{t("aiStudio.playbooks.newPlaybook")}</p>
      </Link>
    </div>
  );
}


// ─── Knowledge Tab ────────────────────────────────────────────
function KnowledgeTab({ t }: { t: (key: string) => string }) {
  const { token } = useAuth();
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    getKnowledgeBases(token)
      .then((res) => setKnowledgeBases(res.data || []))
      .catch(() => setKnowledgeBases([]))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.knowledge.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.knowledge.subtitle")}</p>
        </div>
        <Link
          href="/ai-studio/knowledge"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
          {t("aiStudio.knowledge.manageKnowledge")}
        </Link>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="grid grid-cols-[1fr_100px_100px_120px_40px] gap-3 px-5 py-3 bg-gray-50/60 border-b border-gray-100">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.source")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.type")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.status")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.lastSync")}</span>
          <span />
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
          </div>
        ) : knowledgeBases.length === 0 ? (
          <div className="px-5 py-10 text-center text-gray-400">
            <p className="text-sm">No knowledge sources yet</p>
          </div>
        ) : knowledgeBases.map((src, i) => {
          const status = src.status?.toLowerCase() || "synced";
          const lastSync = src.updatedAt ? new Date(src.updatedAt).toLocaleDateString() : "-";
          return (
          <div
            key={src.id}
            className={clsx(
              "grid grid-cols-[1fr_100px_100px_120px_40px] gap-3 items-center px-5 py-3.5 hover:bg-gray-50/60 transition",
              i < knowledgeBases.length - 1 && "border-b border-gray-50"
            )}
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
              </div>
              <span className="text-sm font-medium text-gray-800">{src.name}</span>
            </div>
            <span className="text-xs text-gray-500">{src.type || "Document"}</span>
            <StatusBadge status={status} />
            <span className="text-xs text-gray-400">{lastSync}</span>
            <button className="p-1.5 rounded-lg text-gray-300 hover:text-violet-600 hover:bg-violet-50 transition justify-self-end">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
            </button>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Skills & Integrations Tab (Tools + Marketplace) ──────────
// Only categories that actually have a published catalog row are listed.
// Re-add Helpdesk/Communication/Analytics/Shipping/Calendar here when an
// adapter ships under that category.
const MARKETPLACE_CATEGORIES = [
  { label: "All", value: "All" },
  { label: "E-Commerce", value: "ECOMMERCE" },
  { label: "CRM", value: "CRM" },
  { label: "Payments", value: "PAYMENTS" },
  { label: "Project Management", value: "PROJECT_MANAGEMENT" },
  { label: "Database", value: "DATABASE" },
  { label: "Custom", value: "CUSTOM" },
];

const MARKETPLACE_CATEGORY_COLORS: Record<string, string> = {
  ECOMMERCE: "bg-blue-100 text-blue-700",
  CRM: "bg-purple-100 text-purple-700",
  PAYMENTS: "bg-green-100 text-green-700",
  PROJECT_MANAGEMENT: "bg-indigo-100 text-indigo-700",
  DATABASE: "bg-slate-100 text-slate-700",
  CUSTOM: "bg-violet-100 text-violet-700",
};

// Shared logo map (includes airtable/fireberry/returngo). See @/lib/integration-logos.
const MARKETPLACE_LOGOS = INTEGRATION_LOGOS;

const MARKETPLACE_LOGO_COLORS = [
  "bg-blue-500", "bg-purple-500", "bg-green-500", "bg-orange-500",
  "bg-pink-500", "bg-yellow-500", "bg-teal-500", "bg-red-500",
];

function getMarketplaceLogoColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return MARKETPLACE_LOGO_COLORS[Math.abs(hash) % MARKETPLACE_LOGO_COLORS.length];
}

const AUTH_TYPE_STYLES: Record<string, string> = {
  OAUTH2: "bg-blue-50 text-blue-600 border-blue-200",
  API_KEY: "bg-amber-50 text-amber-600 border-amber-200",
  BASIC_AUTH: "bg-gray-50 text-gray-600 border-gray-200",
};

type SkillsSubView = "connected" | "marketplace";

// Integration logo with graceful fallback to a first-letter badge when there's
// no known logo (or the image fails to load). Resolves by slug or display name.
function IntegrationLogo({ name, slug, className }: { name: string; slug?: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  const url = logoForIntegration(slug || name);
  return (
    <div className={clsx("rounded-lg bg-white border border-gray-100 flex items-center justify-center shadow-sm overflow-hidden shrink-0", className)}>
      {url && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" onError={() => setBroken(true)} className="w-2/3 h-2/3 object-contain" />
      ) : (
        <span className="text-xs font-bold text-gray-600">{(name || "?").charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
}

function SkillsTab({ t }: { t: (key: string) => string }) {
  const { token } = useAuth();
  const router = useRouter();
  const [subView, setSubView] = useState<SkillsSubView>("connected");
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    getMarketplaceIntegrations(token)
      .then((res) => {
        const list = res.data || [];
        if (!list.some((i: any) => i.slug === "custom_api")) {
          list.push({
            id: "virtual_custom_api",
            slug: "custom_api",
            name: "Custom API",
            description: "Define your own HTTP tools - Postman-style request builder. Each tool exposes one API call to the AI as custom.<slug>.",
            category: "CUSTOM",
            authType: "CUSTOM",
            isPublished: true,
          });
        }
        setIntegrations(list);
      })
      .catch(() => setIntegrations([]))
      .finally(() => setLoading(false));
  }, [token]);

  const filtered = integrations.filter((intg) => {
    const matchSearch =
      !search ||
      intg.name?.toLowerCase().includes(search.toLowerCase()) ||
      intg.description?.toLowerCase().includes(search.toLowerCase());
    const matchCat = activeCategory === "All" || intg.category === activeCategory || intg.category?.toUpperCase() === activeCategory;
    return matchSearch && matchCat;
  });

  function getStatusInfo(intg: any) {
    const ti = intg.tenantConnection;
    const isConnected = ti && ti.status === "CONNECTED";
    const totalTools = intg.catalogTools?.length || 0;
    const enabledTools = intg.catalogTools?.filter((ct: any) => ct.tenantTool?.isEnabled).length || 0;
    return { isConnected, totalTools, enabledTools };
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.resources.skillsAndTools")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.tools.subtitle")}</p>
        </div>
      </div>

      {/* Sub-view toggle */}
      <div className="flex gap-1 bg-gray-100/80 rounded-xl p-1 mb-5 w-fit">
        <button
          onClick={() => setSubView("connected")}
          className={clsx(
            "px-4 py-2 rounded-lg text-sm font-medium transition",
            subView === "connected" ? "bg-white text-violet-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          {t("aiStudio.tools.title")}
        </button>
        <button
          onClick={() => setSubView("marketplace")}
          className={clsx(
            "px-4 py-2 rounded-lg text-sm font-medium transition",
            subView === "marketplace" ? "bg-white text-violet-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          {t("marketplace.title")}
        </button>
      </div>

      {subView === "connected" ? (
        <>
          {/* Connected tools - derived from real marketplace data */}
          {(() => {
            const connected = integrations
              .filter((intg: any) => intg.tenantConnection?.status === "CONNECTED")
              .map((intg: any) => ({
                name: intg.name || intg.slug,
                slug: intg.slug,
                tools: (intg.catalogTools || []).map((ct: any) => ({
                  name: ct.name,
                  risk: (ct.riskLevel || "LOW").toLowerCase(),
                  enabled: ct.tenantTool?.isEnabled ?? false,
                })),
              }));

            if (loading) {
              return <div className="text-sm text-gray-400 py-8 text-center">…</div>;
            }
            if (connected.length === 0) {
              return (
                <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-8 text-center">
                  <p className="text-sm text-gray-500">{t("aiStudio.tools.noneConnected") || "No integrations connected yet."}</p>
                  <p className="text-xs text-gray-400 mt-1">{t("aiStudio.tools.connectNewSub")}</p>
                </div>
              );
            }
            return (
              <div className="space-y-4">
                {connected.map((intg) => (
                  <div key={intg.slug} className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
                    <div className="flex items-center gap-3 px-5 py-3.5 border-b border-gray-50 bg-gray-50/40">
                      <IntegrationLogo name={intg.name} slug={intg.slug} className="w-8 h-8" />
                      <span className="font-semibold text-gray-800">{intg.name}</span>
                      <StatusBadge status="connected" />
                    </div>
                    {intg.tools.length === 0 ? (
                      <div className="px-5 py-3 text-xs text-gray-400">{t("aiStudio.tools.noTools") || "No tools available for this integration."}</div>
                    ) : (
                      intg.tools.map((tool: { name: string; risk: string; enabled: boolean }, i: number) => (
                        <div
                          key={tool.name}
                          className={clsx(
                            "flex items-center gap-4 px-5 py-3 hover:bg-gray-50/40 transition",
                            i < intg.tools.length - 1 && "border-b border-gray-50"
                          )}
                        >
                          <div className={clsx("w-2 h-2 rounded-full shrink-0", tool.enabled ? "bg-green-400" : "bg-gray-200")} />
                          <span className="text-sm text-gray-800 flex-1">{tool.name}</span>
                          <RiskBadge risk={tool.risk} />
                          <span className="text-xs text-gray-400 w-28 text-right">
                            {tool.enabled
                              ? <span className="text-green-600">{t("aiStudio.tools.enabled") || "enabled"}</span>
                              : <span className="text-gray-400">{t("aiStudio.tools.disabled") || "disabled"}</span>
                            }
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          <div
            className="mt-4 bg-white rounded-2xl border-2 border-dashed border-gray-200 p-6 flex items-center gap-4 hover:border-violet-300 hover:bg-violet-50/30 transition cursor-pointer"
            onClick={() => setSubView("marketplace")}
          >
            <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700">{t("aiStudio.tools.connectNew")}</p>
              <p className="text-xs text-gray-400 mt-0.5">{t("aiStudio.tools.connectNewSub")}</p>
            </div>
            <svg className="w-4 h-4 text-gray-400 ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </div>
        </>
      ) : (
        <>
          {/* Marketplace */}
          <div className="mb-5 flex flex-col gap-3">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("marketplace.search")}
                className="w-full pl-9 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none transition"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {MARKETPLACE_CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setActiveCategory(cat.value)}
                  className={clsx(
                    "px-4 py-1.5 rounded-full text-sm font-medium transition",
                    activeCategory === cat.value
                      ? "bg-violet-600 text-white shadow-sm"
                      : "bg-white text-gray-600 border border-gray-200 hover:border-violet-300 hover:text-violet-600"
                  )}
                >
                  {cat.value === "All" ? t("marketplace.allCategories") : cat.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-8 h-8 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400">
              <svg className="w-12 h-12 mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <p className="text-sm">No integrations found</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.map((intg) => {
                const { isConnected, totalTools, enabledTools } = getStatusInfo(intg);
                const logoSrc = intg.logoUrl || MARKETPLACE_LOGOS[intg.slug] || null;
                const logoColor = getMarketplaceLogoColor(intg.name || "");
                const authLabel = intg.authType === "OAUTH2" ? "OAuth" : intg.authType === "BASIC_AUTH" ? "Basic Auth" : "API Key";
                return (
                  <div
                    key={intg.id || intg.slug}
                    className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 flex flex-col gap-3 hover:shadow-md hover:border-violet-200 transition cursor-pointer"
                    onClick={() => router.push(`/integrations/${intg.slug}`)}
                  >
                    <div className="flex items-start justify-between">
                      <div className={clsx("w-12 h-12 rounded-xl flex items-center justify-center shrink-0", logoSrc ? "bg-white border border-gray-100 p-1.5" : `${logoColor} text-white font-bold text-lg`)}>
                        {logoSrc ? (
                          <img src={logoSrc} alt={intg.name} className="w-full h-full object-contain" />
                        ) : (
                          (intg.name || "?").charAt(0).toUpperCase()
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className={clsx("w-2 h-2 rounded-full", isConnected ? "bg-green-500" : "bg-gray-300")} />
                          <span className={clsx("text-xs font-medium", isConnected ? "text-green-600" : "text-gray-400")}>
                            {isConnected ? t("marketplace.connected") : t("marketplace.notConnected")}
                          </span>
                        </div>
                        {intg.authType && (
                          <span className={clsx("px-2 py-0.5 rounded-full text-[10px] font-medium border", AUTH_TYPE_STYLES[intg.authType] || AUTH_TYPE_STYLES.API_KEY)}>
                            {authLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 text-sm">{intg.name}</h3>
                      {intg.category && (
                        <span className={clsx("inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium", MARKETPLACE_CATEGORY_COLORS[intg.category] || "bg-gray-100 text-gray-600")}>
                          {intg.category}
                        </span>
                      )}
                    </div>
                    {intg.description && (
                      <p className="text-xs text-gray-500 line-clamp-2 flex-1">{intg.description}</p>
                    )}
                    <p className="text-xs text-gray-400">
                      {isConnected && totalTools > 0
                        ? `${enabledTools}/${totalTools} ${t("marketplace.toolsEnabled")}`
                        : `${totalTools} ${t("marketplace.toolsAvailable")}`}
                    </p>
                    <button
                      className={clsx(
                        "w-full py-2 rounded-xl text-sm font-medium transition",
                        isConnected
                          ? "bg-violet-50 text-violet-700 hover:bg-violet-100"
                          : "bg-violet-600 text-white hover:bg-violet-700 shadow-sm"
                      )}
                      onClick={(e) => { e.stopPropagation(); router.push(`/integrations/${intg.slug}`); }}
                    >
                      {isConnected ? t("marketplace.manage") : t("marketplace.connect")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
// `useSearchParams` triggers Next 14's CSR bailout, which the static-export
// build refuses to render unless the consumer is inside a Suspense boundary.
// Default export wraps the inner component to satisfy that requirement.
export default function AIStudioPage() {
  return (
    <Suspense fallback={null}>
      <AIStudioPageInner />
    </Suspense>
  );
}

function AIStudioPageInner() {
  const { t } = useI18n();
  const { token } = useAuth();
  // Persist tab selection in the URL (?tab=…) so refresh + back/forward + share-link
  // all land on the same tab. Falls back to "team" when the param is missing or junk.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  const [activeTab, setActiveTabState] = useState<Tab>(isTab(tabFromUrl) ? tabFromUrl : "team");
  // Keep state in sync if the URL changes (e.g. browser back/forward).
  useEffect(() => {
    if (isTab(tabFromUrl) && tabFromUrl !== activeTab) setActiveTabState(tabFromUrl);
  }, [tabFromUrl, activeTab]);
  const setActiveTab = useCallback(
    (next: Tab) => {
      setActiveTabState(next);
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set("tab", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );
  const [stats, setStats] = useState({ agents: 0, playbooks: 0, knowledge: 0, skills: 0 });

  useEffect(() => {
    if (!token) return;
    Promise.all([
      getAIAgents(token).then((r) => (r.data || []).filter((a: any) => a.status === "ACTIVE").length).catch(() => 0),
      getChatbotFlows(token).then((r) => (Array.isArray(r) ? r : (r as any).data || []).filter((f: any) => f.isActive).length).catch(() => 0),
      getKnowledgeBases(token).then((r) => (r.data || []).length).catch(() => 0),
      getMarketplaceIntegrations(token).then((r) => (r.data || []).filter((i: any) => i.tenantConnection?.status === "CONNECTED").length).catch(() => 0),
    ]).then(([agents, playbooks, knowledge, skills]) => setStats({ agents, playbooks, knowledge, skills }));
  }, [token]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    {
      key: "team",
      label: t("aiStudio.tabs.team"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
        </svg>
      ),
    },
    {
      key: "playbooks",
      label: t("aiStudio.tabs.playbooks"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      ),
    },
    {
      key: "knowledge",
      label: t("aiStudio.tabs.knowledge"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
        </svg>
      ),
    },
    {
      key: "skills",
      label: t("aiStudio.tabs.skills"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
        </svg>
      ),
    },
  ];

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">{t("aiStudio.title")}</h1>
          </div>
          <p className="text-sm text-gray-400 ml-11">{t("aiStudio.subtitle")}</p>
        </div>

        {/* Stats overview */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <StatCard
            icon={<svg className="w-5 h-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" /></svg>}
            label={t("aiStudio.stats.teamMembers")}
            value={stats.agents}
            sub={t("aiStudio.stats.activeMembers")}
            color="bg-violet-50"
          />
          <StatCard
            icon={<svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>}
            label={t("aiStudio.stats.activePlaybooks")}
            value={stats.playbooks}
            sub={t("aiStudio.stats.playbooksSub")}
            color="bg-blue-50"
          />
          <StatCard
            icon={<svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>}
            label={t("aiStudio.stats.knowledgeSources")}
            value={stats.knowledge}
            sub={t("aiStudio.stats.knowledgeSub")}
            color="bg-emerald-50"
          />
          <StatCard
            icon={<svg className="w-5 h-5 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" /></svg>}
            label={t("aiStudio.stats.connectedSkills")}
            value={stats.skills}
            sub={t("aiStudio.stats.skillsSub")}
            color="bg-orange-50"
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100/80 rounded-2xl p-1 mb-6 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={clsx(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition whitespace-nowrap flex-1 justify-center",
                activeTab === tab.key
                  ? "bg-white text-violet-700 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              )}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "team" && <TeamTab t={t} />}
        {activeTab === "playbooks" && <PlaybooksTab t={t} />}
        {activeTab === "knowledge" && <KnowledgeTab t={t} />}
        {activeTab === "skills" && <SkillsTab t={t} />}
      </div>
    </AppLayout>
  );
}
