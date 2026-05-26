"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getVoiceSessionContext, type VoiceSessionContext } from "@/lib/api";
import { fetchCrmContext, type CrmContextEnvelope } from "@/lib/api-crm";
import { getSocket } from "@/lib/socket";
import { CueLanesCard } from "./cards/CueLanesCard";
import { CustomerContextCard } from "./cards/CustomerContextCard";
import { CustomerBriefCard } from "./cards/CustomerBriefCard";
import { OpenTicketsCard } from "./cards/OpenTicketsCard";
import { CrmHistoryCard } from "./cards/CrmHistoryCard";
import { StageProgressCard } from "./cards/StageProgressCard";

interface Props {
  sessionId: string;
  conversationId: string | null;
}

type TabKey = "live" | "customer" | "history";

/**
 * Right rail of the /voice/[sessionId] workspace.
 *
 * Organized into 3 tabs (Live / Customer / History) so the agent doesn't
 * have to scroll through 8 stacked cards in a narrow column during a
 * live call. Pulse-level cues auto-promote the Live tab and flash a
 * badge on its label so the agent never misses a time-critical signal
 * while reading customer history.
 */
export function CallRightPanel({ sessionId, conversationId }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [context, setContext] = useState<VoiceSessionContext | null>(null);
  const [crmContext, setCrmContext] = useState<CrmContextEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [crmLoading, setCrmLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("live");
  const [pulseAlert, setPulseAlert] = useState(0);
  const [hasCoachingAlert, setHasCoachingAlert] = useState(false);
  const [crmReloadKey, setCrmReloadKey] = useState(0);

  useEffect(() => {
    if (!token || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setCrmLoading(true);

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
  }, [token, sessionId, conversationId, crmReloadKey]);

  // Subscribe to stage-change broadcasts so a manual override from another
  // tab or the post-call auto-advance both refresh this card live.
  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    if (!socket) return;
    const onStage = (data: unknown) => {
      const d = data as { conversationId?: string };
      if (!d || d.conversationId !== conversationId) return;
      setCrmReloadKey((k) => k + 1);
    };
    socket.on("crm.stage.changed", onStage);
    return () => { socket.off("crm.stage.changed", onStage); };
  }, [conversationId]);

  // Pulse-aware tab attention. When the cue projector emits a pulse-lane
  // cue we (a) auto-switch to Live so the agent doesn't have to context-
  // shift and (b) keep a count badge on the tab label as a fallback when
  // the agent has manually navigated away mid-call.
  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    if (!socket) return;
    const onCues = (data: unknown) => {
      const d = data as { conversationId?: string; cues?: Array<{ lane?: string }> };
      if (!d || d.conversationId !== conversationId) return;
      const cues = d.cues || [];
      const pulse = cues.filter((c) => c.lane === "pulse").length;
      const hasCoach = cues.some((c) => c.lane === "direction" || c.lane === "strategy");
      if (pulse > 0) {
        setPulseAlert((prev) => prev + pulse);
        setTab("live");
      } else if (hasCoach) {
        setHasCoachingAlert(true);
      }
    };
    socket.on("copilot.cues.updated", onCues);
    return () => { socket.off("copilot.cues.updated", onCues); };
  }, [conversationId]);

  // Clear the badge when the agent actually views the Live tab.
  useEffect(() => {
    if (tab === "live") {
      setPulseAlert(0);
      setHasCoachingAlert(false);
    }
  }, [tab]);

  // Counts driving the tab dots. Computed once per render so the tab
  // strip stays in sync with the underlying card content.
  const counts = useMemo(() => {
    const openIssues = crmContext?.open_issues?.length ?? 0;
    const otherSummaries = (crmContext?.recent_summaries || []).filter(
      (s) => !s.isCurrentConversation,
    ).length;
    // priorConversations now feeds a single unified history card spanning
    // every channel (voice + chats), so the History tab count is just the
    // total prior items + the AI memory summaries.
    const priorAll = (context?.priorConversations || []).length;
    const crmNotes = crmContext?.recent_crm_notes?.length ?? 0;
    return {
      customer: openIssues + crmNotes,
      history: otherSummaries + priorAll,
    };
  }, [context, crmContext]);

  const contact = context?.contact;
  const customerLabel =
    contact?.displayName || contact?.externalId || contact?.phone || "—";

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-gray-50">
      {/* Pinned customer header — keeps name + phone in view regardless of
          which tab is active. Skinny so it doesn't steal vertical space. */}
      <div className="px-4 py-2.5 bg-white border-b border-gray-100 flex items-center gap-2.5 shrink-0">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-xs font-semibold shrink-0">
          {(customerLabel || "?").trim().slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-gray-900 truncate leading-tight">
            {customerLabel}
          </div>
          {contact?.phone && contact?.displayName ? (
            <div className="text-[11px] text-gray-500 tabular-nums truncate leading-tight">
              {contact.phone}
            </div>
          ) : contact?.email ? (
            <div className="text-[11px] text-gray-500 truncate leading-tight">
              {contact.email}
            </div>
          ) : (
            <div className="text-[11px] text-gray-400 leading-tight">
              {loading ? "Loading…" : t("voice.workspace.cards.customer.noContact")}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {crmContext?.active_stage && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md uppercase tracking-wider bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100"
              title={`Pipeline stage · source: ${crmContext.active_stage.source}`}
            >
              {crmContext.active_stage.label}
            </span>
          )}
          <SentimentChip trend={crmContext?.sentiment_trend} />
        </div>
      </div>

      {/* Tab strip — sticky so it doesn't scroll away. */}
      <div className="px-2 pt-2 pb-0 bg-gray-50 border-b border-gray-100 flex items-center gap-1 shrink-0">
        <TabButton
          active={tab === "live"}
          onClick={() => setTab("live")}
          label={t("callRightPanel.tabs.live")}
          alert={pulseAlert > 0 ? "pulse" : hasCoachingAlert ? "coach" : null}
          alertCount={pulseAlert}
        />
        <TabButton
          active={tab === "customer"}
          onClick={() => setTab("customer")}
          label={t("callRightPanel.tabs.customer")}
          count={counts.customer}
        />
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          label={t("callRightPanel.tabs.history")}
          count={counts.history}
        />
      </div>

      {/* Tab body — each tab scrolls independently so a long history card
          can't push live cues off-screen. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "live" && (
          <div className="p-3 flex flex-col gap-2.5">
            <StageProgressCard
              stage={crmContext?.active_stage}
              conversationId={conversationId}
              onStageChanged={() => setCrmReloadKey((k) => k + 1)}
            />
            <CueLanesCard conversationId={conversationId} />
            <SentimentTrendCard trend={crmContext?.sentiment_trend} />
          </div>
        )}
        {tab === "customer" && (
          <div className="p-3 flex flex-col gap-2.5">
            {/* AI customer brief — persistent cross-conversation behavioral
                summary. Same source as the chat CRM panel's brief card so
                the rep sees one unified view of this customer regardless of
                channel. Lazily generated on first load if nothing is on
                disk yet; refreshed by post-call workers. */}
            <CustomerBriefCard conversationId={conversationId} />
            <CustomerContextCard context={context} loading={loading} />
            <OpenTicketsCard openIssues={crmContext?.open_issues} loading={crmLoading} />
            <RecentCrmNotesCard notes={crmContext?.recent_crm_notes} loading={crmLoading} />
            {!crmLoading && counts.customer === 0 && !contact?.tags?.length && (
              <EmptyState
                title={t("callRightPanel.emptyCustomer.title")}
                body={t("callRightPanel.emptyCustomer.body")}
              />
            )}
          </div>
        )}
        {tab === "history" && (
          <div className="p-3 flex flex-col gap-2.5">
            {/* Cross-channel summaries the AI memory layer keeps (older calls + chats
                across every connected channel). */}
            <RecentSummariesCard summaries={crmContext?.recent_summaries} loading={crmLoading} />
            {/* Unified timeline: voice + every chat channel in one card with
                platform badges. The old voice-only PreviousCallsCard was
                merged into CrmHistoryCard so the agent sees a single sorted
                stream instead of jumping between cards. */}
            <CrmHistoryCard context={context} loading={loading} />
            {!loading && !crmLoading && counts.history === 0 && (
              <EmptyState
                title={t("callRightPanel.emptyHistory.title")}
                body={t("callRightPanel.emptyHistory.body")}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab button ──────────────────────────────────────────────────

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  alert?: "pulse" | "coach" | null;
  alertCount?: number;
}

function TabButton({ active, onClick, label, count, alert, alertCount }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "relative flex-1 px-3 py-2 text-[12px] font-semibold tracking-wide transition rounded-t-lg",
        active
          ? "text-gray-900 bg-white border border-gray-100 border-b-white -mb-px"
          : "text-gray-500 hover:text-gray-800 hover:bg-white/50",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        {alert === "pulse" && (
          <span className="relative inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold rounded-full bg-rose-500 text-white tabular-nums">
            <span className="absolute inset-0 rounded-full bg-rose-500 opacity-60 animate-ping" />
            <span className="relative">{alertCount && alertCount > 0 ? alertCount : "!"}</span>
          </span>
        )}
        {alert === "coach" && (
          <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
        )}
        {!alert && typeof count === "number" && count > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-medium rounded-full bg-gray-200 text-gray-700 tabular-nums">
            {count}
          </span>
        )}
      </span>
    </button>
  );
}

// ─── Sentiment chip (compact, in header) ────────────────────────

function SentimentChip({ trend }: { trend?: CrmContextEnvelope["sentiment_trend"] }) {
  if (!trend || trend.length === 0) return null;
  const latest = trend[trend.length - 1];
  const cls =
    latest === "positive"
      ? "bg-emerald-100 text-emerald-700"
      : latest === "negative"
      ? "bg-rose-100 text-rose-700"
      : "bg-gray-100 text-gray-600";
  return (
    <span
      className={clsx("shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md uppercase tracking-wider", cls)}
      title={`Latest sentiment: ${latest}`}
    >
      {latest}
    </span>
  );
}

// ─── Empty state ────────────────────────────────────────────────

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white/50 px-4 py-6 text-center">
      <div className="text-[12px] font-semibold text-gray-700 mb-1">{title}</div>
      <div className="text-[11px] text-gray-500 leading-snug">{body}</div>
    </div>
  );
}

// ─── Sentiment trend bar (in Live tab) ──────────────────────────

function SentimentTrendCard({ trend }: { trend?: CrmContextEnvelope["sentiment_trend"] }) {
  if (!trend || trend.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">
          Sentiment trend
        </div>
        <div className="text-[10px] text-gray-400">oldest → latest</div>
      </div>
      <div className="flex items-center gap-1">
        {trend.map((v, i) => (
          <span
            key={i}
            title={v}
            className={clsx(
              "h-2.5 flex-1 rounded-sm",
              v === "positive" && "bg-emerald-400",
              v === "negative" && "bg-rose-400",
              v === "neutral"  && "bg-gray-300",
              v === "unknown"  && "bg-gray-200",
            )}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Recent conversations (cross-channel summaries) ─────────────

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
        <div className="text-[11px] font-semibold uppercase tracking-widest text-gray-700 mb-1.5">
          Recent conversations
        </div>
        <p className="text-xs text-gray-400">Loading…</p>
      </div>
    );
  }
  if (others.length === 0) return null;
  return (
    <CollapsibleCard
      title="Recent conversations"
      count={others.length}
      defaultOpen
    >
      <ul className="px-4 py-2 space-y-1.5">
        {others.slice(0, 4).map((s) => (
          <li key={s.conversationId} className="rounded-md border border-gray-100 bg-white px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-500 uppercase">{s.channel}</span>
              <span className="text-[11px] text-gray-400">{new Date(s.occurredAt).toLocaleDateString()}</span>
            </div>
            {s.summary && (
              <p className="text-xs text-gray-700 mt-0.5 line-clamp-3">{s.summary}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {s.sentiment && (
                <span
                  className={clsx(
                    "text-[11px] px-1.5 py-0.5 rounded-full",
                    s.sentiment.toLowerCase().includes("positive") && "bg-emerald-50 text-emerald-700",
                    s.sentiment.toLowerCase().includes("negative") && "bg-rose-50 text-rose-700",
                    s.sentiment.toLowerCase().includes("neutral") && "bg-gray-100 text-gray-600",
                  )}
                >
                  {s.sentiment}
                </span>
              )}
              {s.qualification && (
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                  {s.qualification}
                </span>
              )}
              {s.actionItems.slice(0, 2).map((a, i) => (
                <span
                  key={i}
                  className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 truncate max-w-[160px]"
                >
                  • {a}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </CollapsibleCard>
  );
}

// ─── Recent CRM notes ────────────────────────────────────────────

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
    <CollapsibleCard title="CRM notes" count={notes.length} defaultOpen={notes.length <= 3}>
      <ul className="px-4 py-2 space-y-1.5">
        {notes.slice(0, 5).map((n) => (
          <li key={n.id} className="rounded-md border border-gray-100 bg-white px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-500 uppercase">{n.kind}</span>
              <span className="text-[11px] text-gray-400">{new Date(n.occurred_at).toLocaleDateString()}</span>
            </div>
            <p className="text-xs text-gray-700 mt-0.5 line-clamp-3 whitespace-pre-wrap">{n.body}</p>
          </li>
        ))}
      </ul>
    </CollapsibleCard>
  );
}

// ─── Collapsible card chrome ────────────────────────────────────

function CollapsibleCard({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lastDefaultRef = useRef(defaultOpen);
  useEffect(() => {
    if (lastDefaultRef.current !== defaultOpen) {
      lastDefaultRef.current = defaultOpen;
      setOpen(defaultOpen);
    }
  }, [defaultOpen]);

  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 border-b border-gray-50 flex items-center justify-between gap-2 hover:bg-gray-50 transition"
      >
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">
          {title}
        </span>
        <span className="flex items-center gap-1.5">
          {typeof count === "number" && count > 0 && (
            <span className="text-[10px] text-gray-500 px-1.5 py-0.5 rounded-full bg-gray-100 tabular-nums">
              {count}
            </span>
          )}
          <svg
            className={clsx("w-3.5 h-3.5 text-gray-400 transition-transform", open && "rotate-90")}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
        </span>
      </button>
      {open && children}
    </div>
  );
}
