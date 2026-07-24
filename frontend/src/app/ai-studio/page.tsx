"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getMarketplaceIntegrations, getAIAgents, getChatbotFlows, getKnowledgeBases, deleteAIAgent, deleteKnowledgeBase } from "@/lib/api";
import { INTEGRATION_LOGOS, logoForIntegration } from "@/lib/integration-logos";
import clsx from "clsx";
import TestChatModal from "@/components/TestChatModal";
import { ReadinessReportModal, readinessBadgeTone } from "@/components/ReadinessReport";
import { builderReadinessTest, type ReadinessReport } from "@/lib/gotcha-api";
import ToolPermissionsPanel from "@/components/ai-studio/ToolPermissionsPanel";
import ActionPoliciesPanel from "@/components/ai-studio/ActionPoliciesPanel";
import { MainPlaybookEditor } from "@/components/mainPlaybook/MainPlaybookEditor";
import { FlowEditor } from "@/components/chatbot/FlowEditor";
import { AI_STUDIO_TABS, normalizeAiStudioTab, type AiStudioTab } from "@/lib/ai-studio-tabs";
import { canonicalDocType } from "@/lib/knowledge-source-type";

// ─── Tab types ────────────────────────────────────────────────
// The tab contract lives in one shared module (URL = source of truth). Old
// values (team/playbooks/skills) normalize to the canonical ones so bookmarks,
// the Settings legacy redirects and guided-tour anchors keep working.
type Tab = AiStudioTab;
const TAB_KEYS: readonly Tab[] = AI_STUDIO_TABS;

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
function StatusBadge({ status, label }: { status: string; label?: string }) {
  const map: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    draft: "bg-gray-100 text-gray-500",
    paused: "bg-yellow-100 text-yellow-700",
    synced: "bg-green-100 text-green-700",
    syncing: "bg-blue-100 text-blue-700",
    connected: "bg-green-100 text-green-700",
    ready: "bg-green-100 text-green-700",
    processing: "bg-blue-100 text-blue-700",
    error: "bg-red-100 text-red-700",
    empty: "bg-gray-100 text-gray-400",
  };
  return (
    <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium capitalize", map[status] || "bg-gray-100 text-gray-500")}>
      {label ?? status}
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
  // Readiness is an ONGOING optimization surface, not a one-time wizard step:
  // each card shows the last score and opens the full, actionable report.
  const [readinessAgent, setReadinessAgent] = useState<{ id: string; name: string; kbId: string | null; report: ReadinessReport | null } | null>(null);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const { locale } = useI18n();

  async function rerunReadiness() {
    if (!token || !readinessAgent || readinessBusy) return;
    setReadinessBusy(true);
    try {
      const res = await builderReadinessTest(token, readinessAgent.id, locale);
      setReadinessAgent((prev) => (prev ? { ...prev, report: res.data } : prev));
      setAgents((prev) => prev.map((a) => (a.id === readinessAgent.id ? { ...a, readinessReport: res.data } : a)));
    } catch { /* keep the previous report visible */ }
    finally { setReadinessBusy(false); }
  }

  const load = useCallback(() => {
    if (!token) return;
    getAIAgents(token)
      .then((res) => setAgents(res.data || []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // An INCOMPLETE wizard draft (status DRAFT + a saved builderStep) is shown in
  // a separate "Continue setup" strip and kept OUT of the employees grid, so
  // abandoned wizards never look like real, usable AI employees.
  const isIncompleteDraft = (a: any) =>
    String(a.status || "").toUpperCase() === "DRAFT" && !!a.builderStep;
  const incompleteDrafts = agents.filter(isIncompleteDraft);
  const employees = agents.filter((a) => !isIncompleteDraft(a));

  async function discardDraft(id: string, name: string) {
    if (!token) return;
    if (!confirm(`Discard this unfinished AI employee${name ? ` ("${name}")` : ""}? This removes the draft.`)) return;
    try {
      await deleteAIAgent(token, id);
      load();
    } catch (e) {
      console.error("Discard draft failed:", e);
    }
  }

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
      <>
        {incompleteDrafts.length > 0 && (
          <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-sm font-semibold text-amber-700">Continue setup</span>
              <span className="text-xs text-amber-600/80">
                {incompleteDrafts.length} unfinished {incompleteDrafts.length === 1 ? "employee" : "employees"} - resume where you stopped, or discard.
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {incompleteDrafts.map((d) => (
                <div key={d.id} className="bg-white rounded-xl border border-amber-200 p-4 flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-300 to-amber-500 flex items-center justify-center text-white font-bold shrink-0">
                      {(d.name || "?").charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{d.name || "Untitled AI Employee"}</p>
                      <p className="text-[11px] text-amber-600 capitalize">Draft · step: {d.builderStep}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => router.push(`/ai-studio/agents/${d.id}`)}
                      className="flex-1 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-medium hover:bg-violet-700 transition"
                    >
                      Resume
                    </button>
                    <button
                      onClick={() => discardDraft(d.id, d.name)}
                      className="py-1.5 px-3 rounded-lg bg-gray-50 text-red-500 text-xs font-medium hover:bg-red-50 transition"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {employees.map((agent) => {
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
              <div className="flex items-center gap-1.5">
                {/* Readiness score - click for the full actionable report. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setReadinessAgent({
                      id: agent.id,
                      name: agent.name,
                      kbId: agent.knowledgeSources?.[0]?.id || null,
                      report: (agent.readinessReport as ReadinessReport | null) || null,
                    });
                  }}
                  title={t("aiStudio.team.readinessTitle")}
                  className={clsx(
                    "px-2 py-0.5 rounded-full text-xs font-semibold border transition hover:opacity-80",
                    agent.readinessReport?.score != null
                      ? readinessBadgeTone(Number(agent.readinessReport.score))
                      : "bg-gray-50 text-gray-400 border-gray-200",
                  )}
                >
                  {agent.readinessReport?.score != null ? `${agent.readinessReport.score}%` : "?"}
                </button>
                <StatusBadge status={status} />
              </div>
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
            employees.length === 0 ? "col-span-full min-h-[200px]" : "min-h-[160px]"
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
      </>
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

      {readinessAgent && token && (
        <ReadinessReportModal
          open={!!readinessAgent}
          onClose={() => setReadinessAgent(null)}
          report={readinessAgent.report}
          token={token}
          kbId={readinessAgent.kbId}
          busy={readinessBusy}
          onRerun={rerunReadiness}
          agentName={readinessAgent.name}
        />
      )}
    </div>
  );
}

// ─── Playbooks Tab (Simplified) ──────────────────────────────
// OLD: StepTypeIcon, RouteTypeBadge, PlaybookGraph removed

function PlaybooksTab({ t }: { t: (key: string) => string }) {
  const { token } = useAuth();
  const [flows, setFlows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Canvas-first: the selected process opens DIRECTLY in the embedded editor -
  // no card, no intermediate Enter/Edit step. "main" = the Main Playbook,
  // "new" = a fresh unsaved process, otherwise an existing flow id.
  const [selected, setSelected] = useState<string>("main");
  const [newNonce, setNewNonce] = useState(0);

  const load = useCallback(() => {
    if (!token) return;
    getChatbotFlows(token)
      .then((r) => setFlows(Array.isArray(r) ? r : (r as any).data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const selectedFlow = flows.find((f) => f.id === selected) || null;

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 250px)", minHeight: 520 }} data-tour="new-workflow">
      {/* Compact process selector - NOT a card grid. Switch, create, template. */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="text-xs font-semibold text-gray-500">{t("aiStudio.playbooks.process")}</label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none min-w-[180px]"
        >
          <option value="main">{t("aiStudio.playbooks.mainPlaybook")}</option>
          {flows.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
          {selected === "new" && <option value="new">{t("aiStudio.playbooks.newProcessOption")}</option>}
        </select>

        {selected !== "main" && selected !== "new" && selectedFlow && (
          <span className={clsx(
            "text-[11px] px-2 py-0.5 rounded-full font-medium",
            selectedFlow.isActive ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500",
          )}>
            {selectedFlow.isActive ? t("aiStudio.playbooks.statusPublished") : t("aiStudio.playbooks.statusDraft")}
          </span>
        )}

        <button
          onClick={() => { setNewNonce((n) => n + 1); setSelected("new"); }}
          className="ms-auto flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white rounded-lg text-sm font-medium hover:bg-violet-700 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("aiStudio.playbooks.newProcess")}
        </button>
        <Link
          href="/ai-studio/router?templates=open"
          className="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 hover:border-gray-300 transition"
        >
          {t("aiStudio.playbooks.templates")}
        </Link>
      </div>

      {/* The selected process opens DIRECTLY in the canvas - no Edit step. */}
      <div className="flex-1 min-h-0 rounded-2xl border border-gray-200 overflow-hidden bg-white">
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">{t("common.loading")}</div>
        ) : selected === "main" ? (
          <MainPlaybookEditor embedded />
        ) : selected === "new" ? (
          <FlowEditor key={`new-${newNonce}`} flowId="new" embedded onCreated={(id) => { load(); setSelected(id); }} />
        ) : (
          <FlowEditor key={selected} flowId={selected} embedded onCreated={(id) => { load(); setSelected(id); }} />
        )}
      </div>
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

  // Deleting a knowledge base takes every document and embedding with it, so it
  // always goes through a confirm step - never a single stray click.
  const [confirmKb, setConfirmKb] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function runDelete() {
    if (!token || !confirmKb || deleting) return;
    setDeleting(true);
    try {
      await deleteKnowledgeBase(token, confirmKb.id);
      setKnowledgeBases((prev) => prev.filter((k) => k.id !== confirmKb.id));
      setConfirmKb(null);
    } catch (err) {
      console.error("Failed to delete knowledge base:", err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    // "kb-overview" - GuidedTour anchor: the knowledge step spotlights the
    // whole tab (read-only overview) instead of an action button the tour
    // wouldn't let the user click anyway.
    <div data-tour="kb-overview">
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

      {/* §8 What Knowledge is + how to add real, mapped sources. */}
      <p className="text-sm text-gray-500 mb-4 -mt-2 max-w-2xl">{t("aiStudio.knowledge.explain")}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {[
          { mode: "file", labelKey: "addFiles", descKey: "cardFilesDesc", color: "violet", d: "M9 13.5l3 3m0 0l3-3m-3 3v-6m1.06-4.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" },
          { mode: "url", labelKey: "addUrl", descKey: "cardWebsiteDesc", color: "blue", d: "M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" },
          { mode: "drive", labelKey: "addDrive", descKey: "cardDriveDesc", color: "emerald", d: "M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" },
          { mode: "text", labelKey: "addAnswer", descKey: "cardFaqDesc", color: "amber", d: "M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" },
          { mode: "confluence", labelKey: "cardConfluence", descKey: "cardConfluenceDesc", color: "sky", d: "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" },
        ].map((c) => (
          <Link
            key={c.mode}
            href={`/ai-studio/knowledge?add=${c.mode}`}
            className="group flex flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-4 hover:border-violet-300 hover:shadow-md transition"
          >
            <span className={clsx("w-9 h-9 rounded-xl flex items-center justify-center",
              c.color === "violet" ? "bg-violet-50 text-violet-600" : c.color === "blue" ? "bg-blue-50 text-blue-600" : c.color === "emerald" ? "bg-emerald-50 text-emerald-600" : c.color === "amber" ? "bg-amber-50 text-amber-600" : "bg-sky-50 text-sky-600")}>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d={c.d} /></svg>
            </span>
            <span className="text-sm font-semibold text-gray-900">{t(`aiStudio.knowledge.${c.labelKey}`)}</span>
            <span className="text-[11px] text-gray-400 leading-snug">{t(`aiStudio.knowledge.${c.descKey}`)}</span>
          </Link>
        ))}
      </div>

      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t("aiStudio.knowledge.activeSources")}</p>
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="grid grid-cols-[1fr_90px_70px_90px_110px_40px] gap-3 px-5 py-3 bg-gray-50/60 border-b border-gray-100">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.source")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.type")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.itemsCol")}</span>
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
          // Real per-source facts derived from the KB's documents (the API
          // returns them with status/sourceType/createdAt) - never a fixed
          // "Document"/"synced" placeholder.
          const docs: any[] = Array.isArray(src.documents) ? src.documents : [];
          const items = docs.length;
          const typeSet = new Set(docs.map((d) => d.sourceType).filter(Boolean).map((s: string) => canonicalDocType(s)));
          const typeKey = typeSet.size === 0 ? "empty" : typeSet.size > 1 ? "mixed" : String(Array.from(typeSet)[0]);
          const lc = (s: any) => String(s || "").toLowerCase();
          const anyError = docs.some((d) => ["error", "failed"].includes(lc(d.status)));
          const anyPending = docs.some((d) => ["pending", "processing", "syncing"].includes(lc(d.status)));
          const status = anyError ? "error" : anyPending ? "processing" : items > 0 ? "ready" : "empty";
          const lastTs = docs.reduce<string | null>((max, d) => (d.createdAt && (!max || d.createdAt > max) ? d.createdAt : max), src.updatedAt ?? null);
          const lastSync = lastTs ? new Date(lastTs).toLocaleDateString() : "-";
          const typeLabel = t(`aiStudio.knowledge.typeLabels.${typeKey}`);
          return (
          <div
            key={src.id}
            className={clsx(
              "grid grid-cols-[1fr_90px_70px_90px_110px_76px] gap-3 items-center px-5 py-3.5 hover:bg-gray-50/60 transition",
              i < knowledgeBases.length - 1 && "border-b border-gray-50"
            )}
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
              </div>
              <span className="text-sm font-medium text-gray-800 truncate">{src.name}</span>
            </div>
            <span className="text-xs text-gray-500 truncate">{typeLabel}</span>
            <span className="text-xs text-gray-500 tabular-nums">{items}</span>
            <StatusBadge status={status} label={t(`aiStudio.knowledge.statusLabels.${status}`)} />
            <span className="text-xs text-gray-400">{lastSync}</span>
            {/* This tab is a read-only overview. Editing a knowledge base lives
                in one place - the Manage Knowledge page - so this opens that KB
                there rather than duplicating the editor. It used to be a button
                with no handler at all, which simply did nothing when clicked. */}
            <div className="flex items-center gap-1 justify-self-end">
              <Link
                href={`/ai-studio/knowledge?kb=${encodeURIComponent(src.id)}`}
                title={t("aiStudio.knowledge.editInManage")}
                aria-label={t("aiStudio.knowledge.editInManage")}
                className="p-1.5 rounded-lg text-gray-300 hover:text-violet-600 hover:bg-violet-50 transition"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                </svg>
              </Link>
              <button
                type="button"
                onClick={() => setConfirmKb({ id: src.id, name: src.name })}
                title={t("aiStudio.knowledge.removeKb")}
                aria-label={t("aiStudio.knowledge.removeKb")}
                className="p-1.5 rounded-lg text-gray-300 hover:text-red-600 hover:bg-red-50 transition"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </button>
            </div>
          </div>
          );
        })}
      </div>

      {confirmKb && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !deleting && setConfirmKb(null)} />
          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
            <h3 className="text-lg font-bold text-gray-900">{t("aiStudio.knowledge.confirmDeleteKbTitle")}</h3>
            <p className="text-sm text-gray-500 mt-2">
              {t("aiStudio.knowledge.confirmRemoveKbBody").replace("{name}", confirmKb.name)}
            </p>
            <p className="text-xs text-gray-400 mt-2">{t("aiStudio.knowledge.confirmDeleteIrreversible")}</p>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setConfirmKb(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={runDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition disabled:opacity-50 shadow-sm"
              >
                {deleting ? t("aiStudio.knowledge.deleting") : t("aiStudio.knowledge.confirmDeleteAction")}
              </button>
            </div>
          </div>
        </div>
      )}
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

type SkillsSubView = "connected" | "marketplace" | "permissions";

const SKILLS_SUB_VIEWS: SkillsSubView[] = ["connected", "marketplace", "permissions"];

// §9: "policies" is no longer a standalone sub-view. Business-policy caps now
// live INSIDE the unified Tool governance surface (the permissions view),
// alongside the per-tool HITL toggle - one place, not a disconnected tab.
// The alias keeps old ?view=policies deep-links (and the /settings/policy,
// /settings/business-rules redirects) landing on the right surface.
function normalizeSkillsSubView(value: string | null): SkillsSubView | null {
  if (value === "policies") return "permissions";
  return isSkillsSubView(value) ? value : null;
}

function isSkillsSubView(value: string | null): value is SkillsSubView {
  return value !== null && (SKILLS_SUB_VIEWS as string[]).includes(value);
}

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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Persist the sub-view selection in the URL (?view=…) so the redirects from
  // the old /settings/tools and /settings/policy|business-rules pages
  // (?tab=skills&view=permissions|policies) land on the right sub-view, and so
  // refresh/back/forward/share-link keep working the same way ?tab= does above.
  const viewFromUrl = searchParams.get("view");
  const [subView, setSubViewState] = useState<SkillsSubView>(
    normalizeSkillsSubView(viewFromUrl) ?? "connected",
  );
  useEffect(() => {
    const normalized = normalizeSkillsSubView(viewFromUrl);
    if (normalized && normalized !== subView) setSubViewState(normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewFromUrl]);
  const setSubView = useCallback(
    (next: SkillsSubView) => {
      setSubViewState(next);
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set("tab", "tools");
      params.set("view", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );
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
      <div className="flex gap-1 bg-gray-100/80 rounded-xl p-1 mb-5 w-fit" data-tour="ai-tools">
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
        <button
          onClick={() => setSubView("permissions")}
          className={clsx(
            "px-4 py-2 rounded-lg text-sm font-medium transition",
            subView === "permissions" ? "bg-white text-violet-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
          )}
        >
          {t("aiStudio.tools.governanceTab")}
        </button>
      </div>

      {subView === "permissions" ? (
        // §9: ONE canonical Tool governance surface. The per-tool matrix
        // (enable + HITL/requires-approval, split system vs external) is the
        // single source of truth for AUTO/HITL; the business-policy spend caps
        // that bound compensation/refund tools render below it - no separate
        // "Business Policies" tab to drift out of sync.
        <div className="space-y-10">
          <ToolPermissionsPanel />
          <div className="pt-8 border-t border-gray-200">
            <ActionPoliciesPanel />
          </div>
        </div>
      ) : subView === "connected" ? (
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
  // Normalize (alias-aware) - missing/junk/legacy "team" all resolve to
  // Overview, NEVER an accidental Team default.
  const [activeTab, setActiveTabState] = useState<Tab>(normalizeAiStudioTab(tabFromUrl));
  // Keep state in sync if the URL changes (e.g. browser back/forward).
  useEffect(() => {
    const norm = normalizeAiStudioTab(tabFromUrl);
    if (norm !== activeTab) setActiveTabState(norm);
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
      key: "overview",
      label: t("aiStudio.tabs.overview"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
        </svg>
      ),
    },
    {
      key: "processes",
      label: t("aiStudio.tabs.processes"),
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
      key: "tools",
      label: t("aiStudio.tabs.tools"),
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

        {/* Tabs - "ai-studio-tabs" is the GuidedTour's AI Studio overview
            anchor (it introduces the four sections via this bar). */}
        <div data-tour="ai-studio-tabs" className="flex gap-1 bg-gray-100/80 rounded-2xl p-1 mb-6 overflow-x-auto">
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
        {activeTab === "overview" && <TeamTab t={t} />}
        {activeTab === "processes" && <PlaybooksTab t={t} />}
        {activeTab === "knowledge" && <KnowledgeTab t={t} />}
        {activeTab === "tools" && <SkillsTab t={t} />}
      </div>
    </AppLayout>
  );
}
