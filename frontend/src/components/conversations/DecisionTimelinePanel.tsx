"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { fetchDecisionTimeline, type DecisionRun } from "@/lib/api-decision-timeline";

interface Props {
  conversationId: string;
  onClose?: () => void;
}

const DECISION_COLOR: Record<string, string> = {
  EXECUTE: "bg-blue-50 text-blue-600",
  FINISH: "bg-green-50 text-green-600",
  ESCALATE: "bg-amber-50 text-amber-700",
  REQUEST_INPUT: "bg-purple-50 text-purple-600",
  CONVERSE: "bg-gray-100 text-gray-600",
  WAIT: "bg-gray-100 text-gray-500",
};
const RUNTIME_COLOR: Record<string, string> = {
  EXECUTED: "bg-green-50 text-green-700",
  RECOMMENDED: "bg-indigo-50 text-indigo-600",
  AWAITING_APPROVAL: "bg-amber-50 text-amber-700",
  BLOCKED: "bg-red-50 text-red-600",
  FAILED: "bg-red-50 text-red-600",
  DENIED: "bg-red-50 text-red-600",
  SUPERSEDED: "bg-gray-100 text-gray-500",
};

export function DecisionTimelinePanel({ conversationId, onClose }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [runs, setRuns] = useState<DecisionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDecisionTimeline(token!, conversationId)
      .then((r) => { if (!cancelled) setRuns(r.data.runs); })
      .catch((e) => { if (!cancelled) setError(e?.message || "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId, token]);

  return (
    <div className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto w-full md:w-[380px] bg-white flex flex-col h-full animate-slide-in-right border-s border-gray-100">
      <div className="px-4 py-3 shadow-subtle flex items-center gap-2.5">
        <div className="w-8 h-8 bg-gradient-to-br from-slate-600 to-slate-800 rounded-xl flex items-center justify-center shadow-sm">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-800">{t("conversations.decisionTimeline.title")}</div>
          <div className="text-xs text-gray-400">{t("conversations.decisionTimeline.subtitle")}</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1" aria-label="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {loading && <div className="text-xs text-gray-400 py-8 text-center">{t("common.loading")}</div>}
        {error && <div className="text-xs text-red-500 py-8 text-center">{error}</div>}
        {!loading && !error && runs && runs.length === 0 && (
          <div className="text-xs text-gray-400 py-8 text-center">{t("conversations.decisionTimeline.empty")}</div>
        )}
        {!loading && runs && runs.map((run) => (
          <div key={run.loopId} className="rounded-xl border border-gray-100 overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold text-gray-700 truncate">{run.goal || t("conversations.decisionTimeline.noGoal")}</span>
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-white text-gray-400 border border-gray-200">{run.mode}</span>
              </div>
              <span className="text-[10px] text-gray-400 shrink-0">{run.iterationCount} · {run.spentUnits}u · {Math.round(run.wallMs)}ms</span>
            </div>
            <div className="divide-y divide-gray-50">
              {run.iterations.map((it) => (
                <div key={it.iteration} className="px-3 py-2 space-y-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-mono text-gray-400">#{it.iteration}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${DECISION_COLOR[it.decisionType] || "bg-gray-100 text-gray-500"}`}>{it.decisionType}</span>
                    {it.proposedOperation && <span className="text-[10px] font-mono text-gray-600">{it.proposedOperation}</span>}
                    {it.runtimeResult && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${RUNTIME_COLOR[it.runtimeResult] || "bg-gray-100 text-gray-500"}`}>{it.runtimeResult}</span>}
                  </div>
                  {it.reasoningSummary && <div className="text-xs text-gray-600 leading-snug">{it.reasoningSummary}</div>}
                  {it.observation && <div className="text-[11px] text-gray-500 font-mono bg-gray-50 rounded px-2 py-1 break-words">{it.observation}</div>}
                  {it.facts && (
                    <div className="text-[10px] text-gray-400">
                      {t("conversations.decisionTimeline.billing")}: {it.facts.billing ?? "?"} · {t("conversations.decisionTimeline.allowed")}: {it.facts.allowed.length}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="px-3 py-1.5 bg-gray-50 text-[10px] text-gray-400 flex items-center justify-between">
              <span>{t("conversations.decisionTimeline.termination")}: {run.terminationReason}</span>
              <span>{run.model}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
