"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getMarketplaceIntegrations } from "@/lib/api";
import clsx from "clsx";

// ─── Tab types ────────────────────────────────────────────────
type Tab = "agents" | "flows" | "router" | "knowledge" | "tools" | "marketplace";

// ─── Mock data ────────────────────────────────────────────────
const MOCK_AGENTS = [
  { id: "1", name: "Maya", role: "Support Agent", status: "active", conversations: 24, satisfaction: 94 },
  { id: "2", name: "Sales Bot", role: "Sales Agent", status: "active", conversations: 11, satisfaction: 88 },
  { id: "3", name: "Returns Handler", role: "Returns Agent", status: "draft", conversations: 0, satisfaction: null },
];

const MOCK_FLOWS = [
  { id: "1", name: "Welcome & Onboarding", trigger: "New conversation", active: true, runs: 142 },
  { id: "2", name: "Order Status Check", trigger: 'Keyword: "track order"', active: true, runs: 89 },
  { id: "3", name: "Lead Qualification", trigger: "Intent: pricing question", active: false, runs: 0 },
];

const MOCK_RULES = [
  { id: "1", priority: 1, name: "VIP customers", condition: "Customer Tag = VIP", routeTo: "Human Agent" },
  { id: "2", priority: 2, name: "Cancel intent", condition: 'Intent: "cancel order"', routeTo: "Returns Flow" },
  { id: "3", priority: 3, name: "Track order", condition: 'Intent: "track order"', routeTo: "Maya (Support)" },
  { id: "4", priority: 4, name: "Sales inquiry", condition: "Intent: pricing/buy", routeTo: "Sales Bot" },
  { id: "5", priority: 5, name: "Everything else", condition: "Default fallback", routeTo: "Maya (Support)" },
];

const MOCK_KNOWLEDGE = [
  { id: "1", name: "Return Policy", type: "Document", status: "synced", lastSync: "2 hours ago" },
  { id: "2", name: "FAQ — General", type: "FAQ", status: "synced", lastSync: "1 hour ago" },
  { id: "3", name: "Product Catalog", type: "Website", status: "syncing", lastSync: "In progress" },
  { id: "4", name: "Shipping Rates", type: "File", status: "synced", lastSync: "Yesterday" },
];

const MOCK_TOOLS = [
  {
    integration: "Shopify",
    status: "connected",
    tools: [
      { name: "Order Lookup", risk: "low", enabled: true, usedBy: "Maya" },
      { name: "Track Shipment", risk: "low", enabled: true, usedBy: "Maya" },
      { name: "Process Refund", risk: "high", enabled: false, usedBy: null },
      { name: "Cancel Order", risk: "high", enabled: true, usedBy: "Maya" },
    ],
  },
  {
    integration: "HubSpot",
    status: "connected",
    tools: [
      { name: "Customer Lookup", risk: "low", enabled: true, usedBy: "All" },
      { name: "Create Deal", risk: "medium", enabled: true, usedBy: "Sales Bot" },
    ],
  },
];

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

// ─── Agents Tab ───────────────────────────────────────────────
function AgentsTab({ t }: { t: (key: string) => string }) {
  const router = useRouter();

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.agents.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.agents.subtitle")}</p>
        </div>
        <Link
          href="/ai-studio/agents/new"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("aiStudio.agents.newAgent")}
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {MOCK_AGENTS.map((agent) => (
          <div
            key={agent.id}
            className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 hover:shadow-md hover:border-violet-200 transition cursor-pointer"
            onClick={() => router.push(`/ai-studio/agents/${agent.id}`)}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
                {agent.name.charAt(0)}
              </div>
              <StatusBadge status={agent.status} />
            </div>
            <h3 className="font-semibold text-gray-900">{agent.name}</h3>
            <p className="text-xs text-gray-400 mt-0.5 mb-3">{agent.role}</p>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>
                <span className="font-semibold text-gray-800">{agent.conversations}</span> {t("aiStudio.agents.conversations")}
              </span>
              {agent.satisfaction !== null && (
                <span>
                  <span className="font-semibold text-gray-800">{agent.satisfaction}%</span> {t("aiStudio.agents.satisfaction")}
                </span>
              )}
            </div>
            <div className="mt-4 pt-4 border-t border-gray-50 flex gap-2">
              <Link
                href={`/ai-studio/agents/${agent.id}`}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 py-1.5 rounded-lg bg-violet-50 text-violet-700 text-xs font-medium hover:bg-violet-100 transition text-center"
              >
                {t("aiStudio.edit")}
              </Link>
              <button
                onClick={(e) => { e.stopPropagation(); }}
                className="py-1.5 px-3 rounded-lg bg-gray-50 text-gray-500 text-xs font-medium hover:bg-gray-100 transition"
              >
                {t("aiStudio.test")}
              </button>
            </div>
          </div>
        ))}

        {/* New agent placeholder card */}
        <Link
          href="/ai-studio/agents/new"
          className="bg-white rounded-2xl border-2 border-dashed border-gray-200 p-5 flex flex-col items-center justify-center gap-3 hover:border-violet-300 hover:bg-violet-50/30 transition cursor-pointer min-h-[160px]"
        >
          <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </div>
          <p className="text-sm text-gray-400 font-medium">{t("aiStudio.agents.newAgent")}</p>
        </Link>
      </div>
    </div>
  );
}

// ─── Flows Tab ────────────────────────────────────────────────
function FlowsTab({ t }: { t: (key: string) => string }) {
  const router = useRouter();
  const [flows, setFlows] = useState(MOCK_FLOWS);

  function toggleFlow(id: string) {
    setFlows((prev) => prev.map((f) => f.id === id ? { ...f, active: !f.active } : f));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.flows.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.flows.subtitle")}</p>
        </div>
        <Link
          href="/ai-studio/flows/new"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("aiStudio.flows.newFlow")}
        </Link>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {flows.map((flow, i) => (
          <div
            key={flow.id}
            className={clsx(
              "flex items-center gap-4 px-5 py-4 hover:bg-gray-50/60 transition",
              i < flows.length - 1 && "border-b border-gray-50"
            )}
          >
            {/* Flow icon */}
            <div className="w-9 h-9 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            </div>

            {/* Info — clicking name navigates to builder */}
            <div
              className="flex-1 min-w-0 cursor-pointer"
              onClick={() => router.push(`/ai-studio/flows/${flow.id}`)}
            >
              <p className="text-sm font-semibold text-gray-900 hover:text-violet-700 transition">{flow.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">{t("aiStudio.flows.trigger")}: {flow.trigger}</p>
            </div>

            {/* Runs */}
            <div className="text-right hidden sm:block">
              <p className="text-sm font-semibold text-gray-800">{flow.runs}</p>
              <p className="text-xs text-gray-400">{t("aiStudio.flows.runs")}</p>
            </div>

            {/* Toggle */}
            <button
              onClick={() => toggleFlow(flow.id)}
              className={clsx(
                "relative w-10 h-5.5 rounded-full transition-colors shrink-0",
                flow.active ? "bg-violet-500" : "bg-gray-200"
              )}
              style={{ width: 40, height: 22 }}
            >
              <span
                className={clsx(
                  "absolute top-0.5 left-0.5 w-[18px] h-[18px] bg-white rounded-full shadow transition-transform",
                  flow.active && "translate-x-[18px]"
                )}
              />
            </button>

            {/* Edit — navigates to flow builder */}
            <Link
              href={`/ai-studio/flows/${flow.id}`}
              className="p-1.5 rounded-lg text-gray-400 hover:text-violet-600 hover:bg-violet-50 transition"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
            </Link>
          </div>
        ))}
      </div>

      {/* New flow placeholder card */}
      <Link
        href="/ai-studio/flows/new"
        className="mt-4 bg-white rounded-2xl border-2 border-dashed border-gray-200 px-5 py-4 flex items-center gap-4 hover:border-violet-300 hover:bg-violet-50/30 transition cursor-pointer"
      >
        <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </div>
        <p className="text-sm text-gray-400 font-medium">{t("aiStudio.flows.newFlow")}</p>
      </Link>
    </div>
  );
}

// ─── Router Tab ───────────────────────────────────────────────
function RouterTab({ t }: { t: (key: string) => string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.router.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.router.subtitle")}</p>
        </div>
        <Link
          href="/ai-studio/router"
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
          </svg>
          {t("aiStudio.router.configureRouter")}
        </Link>
      </div>

      {/* Preview of rules — read-only summary */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[48px_1fr_1fr_1fr_40px] gap-3 px-5 py-3 bg-gray-50/60 border-b border-gray-100">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">#</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.router.rule")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.router.condition")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.router.routeTo")}</span>
          <span />
        </div>

        {MOCK_RULES.map((rule, i) => (
          <div
            key={rule.id}
            className={clsx(
              "grid grid-cols-[48px_1fr_1fr_1fr_40px] gap-3 items-center px-5 py-3.5 hover:bg-gray-50/60 transition",
              i < MOCK_RULES.length - 1 && "border-b border-gray-50",
              i === MOCK_RULES.length - 1 && "bg-gray-50/30"
            )}
          >
            <span className={clsx(
              "w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0",
              i === MOCK_RULES.length - 1
                ? "bg-gray-100 text-gray-400"
                : "bg-violet-100 text-violet-700"
            )}>
              {rule.priority}
            </span>
            <p className="text-sm font-medium text-gray-800">{rule.name}</p>
            <p className="text-xs text-gray-500 font-mono bg-gray-50 px-2 py-1 rounded-lg truncate">{rule.condition}</p>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
              <span className="text-sm text-gray-700">{rule.routeTo}</span>
            </div>
            <Link
              href="/ai-studio/router"
              className="p-1.5 rounded-lg text-gray-300 hover:text-violet-600 hover:bg-violet-50 transition justify-self-end"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
            </Link>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-gray-400">{t("aiStudio.router.hint")}</p>
        <Link
          href="/ai-studio/router"
          className="text-xs text-violet-600 hover:text-violet-700 font-medium flex items-center gap-1 transition"
        >
          {t("aiStudio.router.configureRouter")}
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

// ─── Knowledge Tab ────────────────────────────────────────────
function KnowledgeTab({ t }: { t: (key: string) => string }) {
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
        {/* Header */}
        <div className="grid grid-cols-[1fr_100px_100px_120px_40px] gap-3 px-5 py-3 bg-gray-50/60 border-b border-gray-100">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.source")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.type")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.status")}</span>
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{t("aiStudio.knowledge.lastSync")}</span>
          <span />
        </div>

        {MOCK_KNOWLEDGE.map((src, i) => (
          <div
            key={src.id}
            className={clsx(
              "grid grid-cols-[1fr_100px_100px_120px_40px] gap-3 items-center px-5 py-3.5 hover:bg-gray-50/60 transition",
              i < MOCK_KNOWLEDGE.length - 1 && "border-b border-gray-50"
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
            <span className="text-xs text-gray-500">{src.type}</span>
            <StatusBadge status={src.status} />
            <span className="text-xs text-gray-400">{src.lastSync}</span>
            <button className="p-1.5 rounded-lg text-gray-300 hover:text-violet-600 hover:bg-violet-50 transition justify-self-end">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Tools Tab ────────────────────────────────────────────────
function ToolsTab({ t, onOpenMarketplace }: { t: (key: string) => string; onOpenMarketplace?: () => void }) {
  const router = useRouter();

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("aiStudio.tools.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">{t("aiStudio.tools.subtitle")}</p>
        </div>
        <button
          onClick={onOpenMarketplace}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-700 transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
          {t("aiStudio.tools.openMarketplace")}
        </button>
      </div>

      <div className="space-y-4">
        {MOCK_TOOLS.map((intg) => (
          <div key={intg.integration} className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            {/* Integration header */}
            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-gray-50 bg-gray-50/40">
              <div className="w-8 h-8 rounded-lg bg-white border border-gray-100 flex items-center justify-center text-xs font-bold text-gray-600 shadow-sm">
                {intg.integration.charAt(0)}
              </div>
              <span className="font-semibold text-gray-800">{intg.integration}</span>
              <StatusBadge status={intg.status} />
            </div>

            {/* Tools list */}
            {intg.tools.map((tool, i) => (
              <div
                key={tool.name}
                className={clsx(
                  "flex items-center gap-4 px-5 py-3 hover:bg-gray-50/40 transition",
                  i < intg.tools.length - 1 && "border-b border-gray-50"
                )}
              >
                {/* Toggle indicator */}
                <div className={clsx("w-2 h-2 rounded-full shrink-0", tool.enabled ? "bg-green-400" : "bg-gray-200")} />

                {/* Name */}
                <span className="text-sm text-gray-800 flex-1">{tool.name}</span>

                {/* Risk */}
                <RiskBadge risk={tool.risk} />

                {/* Used by */}
                <span className="text-xs text-gray-400 w-24 text-right">
                  {tool.usedBy
                    ? <span className="text-gray-600">{t("aiStudio.tools.usedBy")}: <strong>{tool.usedBy}</strong></span>
                    : <span className="text-gray-300">{t("aiStudio.tools.notAssigned")}</span>
                  }
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* CTA to marketplace */}
      <div
        className="mt-4 bg-white rounded-2xl border-2 border-dashed border-gray-200 p-6 flex items-center gap-4 hover:border-violet-300 hover:bg-violet-50/30 transition cursor-pointer"
        onClick={onOpenMarketplace}
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
    </div>
  );
}

// ─── Marketplace constants ────────────────────────────────────
const MARKETPLACE_CATEGORIES = [
  { label: "All", value: "All" },
  { label: "E-Commerce", value: "ECOMMERCE" },
  { label: "CRM", value: "CRM" },
  { label: "Payments", value: "PAYMENTS" },
  { label: "Helpdesk", value: "HELPDESK" },
  { label: "Communication", value: "COMMUNICATION" },
  { label: "Analytics", value: "ANALYTICS" },
  { label: "Shipping", value: "SHIPPING" },
  { label: "Project Management", value: "PROJECT_MANAGEMENT" },
  { label: "Calendar", value: "CALENDAR" },
  { label: "Database", value: "DATABASE" },
];

const MARKETPLACE_CATEGORY_COLORS: Record<string, string> = {
  ECOMMERCE: "bg-blue-100 text-blue-700",
  CRM: "bg-purple-100 text-purple-700",
  PAYMENTS: "bg-green-100 text-green-700",
  HELPDESK: "bg-orange-100 text-orange-700",
  COMMUNICATION: "bg-pink-100 text-pink-700",
  ANALYTICS: "bg-yellow-100 text-yellow-700",
  SHIPPING: "bg-cyan-100 text-cyan-700",
  PROJECT_MANAGEMENT: "bg-indigo-100 text-indigo-700",
  CALENDAR: "bg-emerald-100 text-emerald-700",
  DATABASE: "bg-slate-100 text-slate-700",
};

const MARKETPLACE_LOGOS: Record<string, string> = {
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

// ─── Marketplace Tab ─────────────────────────────────────────
function MarketplaceTab({ t }: { t: (key: string) => string }) {
  const { token } = useAuth();
  const router = useRouter();
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    getMarketplaceIntegrations(token)
      .then((res) => setIntegrations(res.data || []))
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
          <h2 className="text-lg font-semibold text-gray-900">{t("marketplace.title")}</h2>
          <p className="text-sm text-gray-400 mt-0.5">Connect external services to power your AI agents</p>
        </div>
      </div>

      {/* Search + filters */}
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

      {/* Grid */}
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
                onClick={() => router.push(`/ai-studio/marketplace/${intg.slug}`)}
              >
                {/* Logo + status */}
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

                {/* Name + category */}
                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">{intg.name}</h3>
                  {intg.category && (
                    <span className={clsx("inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium", MARKETPLACE_CATEGORY_COLORS[intg.category] || "bg-gray-100 text-gray-600")}>
                      {intg.category}
                    </span>
                  )}
                </div>

                {/* Description */}
                {intg.description && (
                  <p className="text-xs text-gray-500 line-clamp-2 flex-1">{intg.description}</p>
                )}

                {/* Tool count */}
                <p className="text-xs text-gray-400">
                  {isConnected && totalTools > 0
                    ? `${enabledTools}/${totalTools} ${t("marketplace.toolsEnabled")}`
                    : `${totalTools} ${t("marketplace.toolsAvailable")}`}
                </p>

                {/* Action button */}
                <button
                  className={clsx(
                    "w-full py-2 rounded-xl text-sm font-medium transition",
                    isConnected
                      ? "bg-violet-50 text-violet-700 hover:bg-violet-100"
                      : "bg-violet-600 text-white hover:bg-violet-700 shadow-sm"
                  )}
                  onClick={(e) => { e.stopPropagation(); router.push(`/ai-studio/marketplace/${intg.slug}`); }}
                >
                  {isConnected ? t("marketplace.manage") : t("marketplace.connect")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function AIStudioPage() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>("agents");

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    {
      key: "agents",
      label: t("aiStudio.tabs.agents"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
        </svg>
      ),
    },
    {
      key: "flows",
      label: t("aiStudio.tabs.flows"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      ),
    },
    {
      key: "router",
      label: t("aiStudio.tabs.router"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
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
    {
      key: "marketplace",
      label: t("marketplace.title"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349m-16.5 11.65V9.35m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72m-13.5 8.65h3.75a.75.75 0 00.75-.75V13.5a.75.75 0 00-.75-.75H6.75a.75.75 0 00-.75.75v3.75c0 .415.336.75.75.75z" />
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
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">{t("aiStudio.title")}</h1>
          </div>
          <p className="text-sm text-gray-400 ml-11">{t("aiStudio.subtitle")}</p>
        </div>

        {/* Stats overview */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <StatCard
            icon={<svg className="w-5 h-5 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>}
            label={t("aiStudio.stats.activeAgents")}
            value={2}
            sub={t("aiStudio.stats.agentsSub")}
            color="bg-violet-50"
          />
          <StatCard
            icon={<svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>}
            label={t("aiStudio.stats.activeFlows")}
            value={2}
            sub={t("aiStudio.stats.flowsSub")}
            color="bg-blue-50"
          />
          <StatCard
            icon={<svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>}
            label={t("aiStudio.stats.knowledgeSources")}
            value={4}
            sub={t("aiStudio.stats.knowledgeSub")}
            color="bg-emerald-50"
          />
          <StatCard
            icon={<svg className="w-5 h-5 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" /></svg>}
            label={t("aiStudio.stats.connectedTools")}
            value={6}
            sub={t("aiStudio.stats.toolsSub")}
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
        {activeTab === "agents" && <AgentsTab t={t} />}
        {activeTab === "flows" && <FlowsTab t={t} />}
        {activeTab === "router" && <RouterTab t={t} />}
        {activeTab === "knowledge" && <KnowledgeTab t={t} />}
        {activeTab === "tools" && <ToolsTab t={t} onOpenMarketplace={() => setActiveTab("marketplace")} />}
        {activeTab === "marketplace" && <MarketplaceTab t={t} />}
      </div>
    </AppLayout>
  );
}
