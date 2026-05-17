"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { getVoiceSessionContext, type VoiceSessionContext } from "@/lib/api";
import { fetchCrmContext, type CrmContextEnvelope } from "@/lib/api-crm";
import { CopilotSuggestionsCard } from "./cards/CopilotSuggestionsCard";
import { CustomerContextCard } from "./cards/CustomerContextCard";
import { PreviousCallsCard } from "./cards/PreviousCallsCard";
import { NotesCard } from "./cards/NotesCard";
import { OpenTicketsCard } from "./cards/OpenTicketsCard";
import { CrmHistoryCard } from "./cards/CrmHistoryCard";
import clsx from "clsx";

interface Props {
  sessionId: string;
  conversationId: string | null;
}

/**
 * Right half of the /voice/[sessionId] workspace.
 *
 * Loads two context bundles in parallel on session open:
 *   1. `voice-sessions/:id/context` — call-specific: contact row, prior
 *      conversations, persisted CallAnalysis rolling/final summary.
 *   2. `crm/conversation/:conversationId/context` — customer-level: CRM
 *      open issues (= incomplete tasks), recent AI summaries across every
 *      channel, recent CRM notes, sentiment trend. Same bundle the chat
 *      panel shows — single source of truth.
 *
 * The CRM bundle only fires when a conversationId is known (every answered
 * call has one — voice-incoming creates the Conversation row before the
 * VoiceCallSession). Each fetch is fail-soft: a missing CRM link doesn't
 * block the call-specific cards from rendering.
 */
export function CallRightPanel({ sessionId, conversationId }: Props) {
  const { token } = useAuth();
  const [context, setContext] = useState<VoiceSessionContext | null>(null);
  const [crmContext, setCrmContext] = useState<CrmContextEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [crmLoading, setCrmLoading] = useState(true);

  useEffect(() => {
    if (!token || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setCrmLoading(true);

    // Fire both fetches in parallel — they share nothing and one being slow
    // (Zoho round-trip) shouldn't block the other (local Postgres).
    getVoiceSessionContext(token, sessionId)
      .then((res) => { if (!cancelled) setContext(res.data); })
      .catch(() => { if (!cancelled) setContext(null); })
      .finally(() => { if (!cancelled) setLoading(false); });

    if (conversationId) {
      fetchCrmContext(token, conversationId)
        .then((data) => { if (!cancelled) setCrmContext(data); })
        .catch(() => { if (!cancelled) setCrmContext(null); })
        .finally(() => { if (!cancelled) setCrmLoading(false); });
    } else {
      setCrmLoading(false);
    }

    return () => { cancelled = true; };
  }, [token, sessionId, conversationId]);

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4 flex flex-col gap-3">
      <CopilotSuggestionsCard sessionId={sessionId} conversationId={conversationId} />
      <CustomerContextCard context={context} loading={loading} />
      <SentimentTrendCard trend={crmContext?.sentiment_trend} />
      <OpenTicketsCard openIssues={crmContext?.open_issues} loading={crmLoading} />
      <RecentSummariesCard summaries={crmContext?.recent_summaries} loading={crmLoading} />
      <PreviousCallsCard context={context} loading={loading} />
      <NotesCard />
      <RecentCrmNotesCard notes={crmContext?.recent_crm_notes} loading={crmLoading} />
      <CrmHistoryCard context={context} loading={loading} />
    </div>
  );
}

// ─── Inline cards — small enough to live alongside the panel ──

function SentimentTrendCard({ trend }: { trend?: CrmContextEnvelope["sentiment_trend"] }) {
  if (!trend || trend.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm px-4 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-600 mb-1.5">
        Sentiment trend
      </div>
      <div className="flex items-center gap-1">
        {trend.map((v, i) => (
          <span
            key={i}
            title={v}
            className={clsx(
              "h-2 flex-1 rounded-sm",
              v === "positive" && "bg-emerald-400",
              v === "negative" && "bg-rose-400",
              v === "neutral"  && "bg-gray-300",
              v === "unknown"  && "bg-gray-200",
            )}
          />
        ))}
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5">most-recent →</div>
    </div>
  );
}

function RecentSummariesCard({
  summaries,
  loading,
}: {
  summaries?: CrmContextEnvelope["recent_summaries"];
  loading?: boolean;
}) {
  const others = (summaries || []).filter((s) => !s.isCurrentConversation);
  if (loading) {
    return (
      <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm px-4 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-600 mb-1.5">
          Recent conversations
        </div>
        <p className="text-xs text-gray-400">Loading…</p>
      </div>
    );
  }
  if (others.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
          Recent conversations
        </span>
        <span className="text-[10px] text-gray-400">{others.length}</span>
      </div>
      <ul className="px-4 py-2 space-y-1.5">
        {others.slice(0, 4).map((s) => (
          <li key={s.conversationId} className="rounded-md border border-gray-100 bg-white px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 uppercase">{s.channel}</span>
              <span className="text-[10px] text-gray-400">{new Date(s.occurredAt).toLocaleDateString()}</span>
            </div>
            {s.summary && (
              <p className="text-xs text-gray-700 mt-0.5 line-clamp-3">{s.summary}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {s.sentiment && (
                <span
                  className={clsx(
                    "text-[10px] px-1.5 py-0.5 rounded-full",
                    s.sentiment.toLowerCase().includes("positive") && "bg-emerald-50 text-emerald-700",
                    s.sentiment.toLowerCase().includes("negative") && "bg-rose-50 text-rose-700",
                    s.sentiment.toLowerCase().includes("neutral") && "bg-gray-100 text-gray-600",
                  )}
                >
                  {s.sentiment}
                </span>
              )}
              {s.qualification && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                  {s.qualification}
                </span>
              )}
              {s.actionItems.slice(0, 2).map((a, i) => (
                <span
                  key={i}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 truncate max-w-[160px]"
                >
                  • {a}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentCrmNotesCard({
  notes,
  loading,
}: {
  notes?: CrmContextEnvelope["recent_crm_notes"];
  loading?: boolean;
}) {
  if (loading) return null;
  if (!notes || notes.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
          CRM notes
        </span>
      </div>
      <ul className="px-4 py-2 space-y-1.5">
        {notes.slice(0, 5).map((n) => (
          <li key={n.id} className="rounded-md border border-gray-100 bg-white px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 uppercase">{n.kind}</span>
              <span className="text-[10px] text-gray-400">{new Date(n.occurred_at).toLocaleDateString()}</span>
            </div>
            <p className="text-xs text-gray-700 mt-0.5 line-clamp-3 whitespace-pre-wrap">{n.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
