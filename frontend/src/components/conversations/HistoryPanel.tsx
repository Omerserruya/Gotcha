"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/context/AuthContext";
import { CustomerIntelligenceCard } from "./CustomerIntelligenceCard";
import { CommerceContextPanel } from "./CommerceContextPanel";
import { ImportedHistoryCard } from "./ImportedHistoryCard";
import { useI18n } from "@/context/I18nContext";
import { getConversationHistory } from "@/lib/api";
import { fetchCustomerSummary, postCrmNote, type CrmContextEnvelope, type CustomerSummary } from "@/lib/api-crm";
import { formatDistanceToNow, format } from "date-fns";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";

interface HistoryPanelProps {
  conversation: any;
  /** Rich CRM payload (lifted to ChatPanel). Used to render the CRM-side
   *  timeline: recent summaries, activities, CRM notes - alongside the local
   *  past-conversations list. Null when CRM isn't connected/linked. */
  crmContext?: CrmContextEnvelope | null;
  crmLoading?: boolean;
  /** Reserved for future write-back of agent notes; currently unused since the
   *  panel is read-only. Left in the signature so the parent ChatPanel doesn't
   *  need to change when we wire a composer back in. */
  onCrmNotePosted?: () => void | Promise<void>;
  onClose?: () => void;
  onSelectConversation?: (id: string) => void;
}

export function HistoryPanel({ conversation, crmContext, crmLoading, onCrmNotePosted, onClose, onSelectConversation }: HistoryPanelProps) {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // CRM note composer - manual notes from the agent that land on the
  // vendor's contact timeline. The CRM-notes collapsible below renders
  // them once the next context fetch returns.
  const [crmNoteText, setCrmNoteText] = useState("");
  const [postingCrmNote, setPostingCrmNote] = useState(false);
  const [crmNoteMsg, setCrmNoteMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // AI-generated customer briefing - rendered as a highlighted card at the
  // top of the panel. Same payload Co-Pilot will consume next. Cached
  // server-side for 10 minutes; the ↻ button bypasses the cache.
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // When Shopify is the connected system, the commerce panel reports a state
  // other than "not_connected" and we hide the generic CRM sections below.
  const [commerceState, setCommerceState] = useState<string | null>(null);
  const shopifyActive = commerceState != null && commerceState !== "not_connected";

  const isLinked = crmContext?.status === "linked";
  const crmActivities = crmContext?.recent_activities ?? [];
  const crmNotes = crmContext?.recent_crm_notes ?? [];
  const openIssues = crmContext?.open_issues ?? [];

  // Index summaries by conversationId so the expanded row in the unified
  // "Past Conversations" list can surface sentiment / qualification /
  // action items inline - no separate "AI summaries (other channels)"
  // section needed.
  const summaryByConv = useMemo(() => {
    const m = new Map<string, NonNullable<CrmContextEnvelope["recent_summaries"]>[number]>();
    for (const s of crmContext?.recent_summaries ?? []) m.set(s.conversationId, s);
    return m;
  }, [crmContext?.recent_summaries]);

  const customerKey = conversation?.customerExternalId;
  const conversationId = conversation?.id;

  const fetchHistory = useCallback(async () => {
    if (!token || !customerKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Pass conversationId so the backend can hit the linked CRM record
      // and pull cross-platform identifiers (phone, email, every gotcha_psid_*)
      // - that's what makes WhatsApp / Instagram / Messenger / voice history
      // for the same person show up together.
      const res = await getConversationHistory(token, customerKey, conversationId);
      setHistory(res.data);
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoading(false);
    }
  }, [token, customerKey, conversationId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const loadSummary = useCallback(async (opts: { refresh?: boolean } = {}) => {
    if (!token || !conversationId) return;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const data = await fetchCustomerSummary(token, conversationId, {
        ...opts,
        locale,
      });
      setSummary(data);
    } catch (err: any) {
      setSummaryError(err?.message || "Failed to load AI summary");
    } finally {
      setSummaryLoading(false);
    }
  }, [token, conversationId, locale]);

  useEffect(() => {
    setSummary(null);
    loadSummary();
  }, [loadSummary]);

  async function handlePostCrmNote() {
    if (!token || !conversation?.id) return;
    const body = crmNoteText.trim();
    if (!body) return;
    setPostingCrmNote(true);
    setCrmNoteMsg(null);
    try {
      await postCrmNote(token, conversation.id, body);
      setCrmNoteText("");
      setCrmNoteMsg({ kind: "ok", text: t("crmPanel.notePosted") || "Note added to CRM." });
      onCrmNotePosted?.();
    } catch (err: any) {
      setCrmNoteMsg({ kind: "err", text: err?.message || "failed_to_post_note" });
    } finally {
      setPostingCrmNote(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto w-full md:w-[340px] bg-white flex flex-col h-full animate-slide-in-right">
      {/* Header */}
      <div className="px-4 py-3 shadow-subtle flex items-center gap-2.5">
        <div className="w-8 h-8 bg-gradient-to-br from-primary-500 to-primary-600 rounded-xl flex items-center justify-center shadow-sm">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">{t("conversations.historyButton")}</p>
          <p className="text-[10px] text-gray-400 truncate">
            {crmContext?.vendor ? `${crmContext.vendor} · ` : ""}{conversation?.customerExternalId}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
            aria-label={t("conversations.historyPanel.closeHistory")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {/* Customer Intelligence snapshot (V2) - structured WHO/WHAT/MISSING/NEXT
            from the three-domain model. Renders nothing until intelligence exists. */}
        <CustomerIntelligenceCard conversationId={conversationId} />
        {/* AI customer brief - highlighted card at the top, gradient border so
            it visually anchors above the structured CRM blocks. Same payload
            will plug into Co-Pilot in a follow-up. */}
        <AISummaryCard
          summary={summary}
          loading={summaryLoading}
          error={summaryError}
          onRefresh={() => loadSummary({ refresh: true })}
          t={t}
        />
        {/* Shopify commerce context - directly UNDER the customer brief. Shown
            when Shopify is the connected system; it self-reports state so the
            generic CRM sections below are hidden while it's active. */}
        <CommerceContextPanel conversationId={conversationId} token={token} onState={setCommerceState} />

        {/* What the WhatsApp history import learned about this person. Above
            past conversations because it is the one-paragraph answer to "who
            am I talking to", which an agent needs before a list of threads. */}
        <ImportedHistoryCard
          customerExternalId={conversation?.customerExternalId}
          token={token}
          t={t}
        />

        {/* Conversation history (collapsible) */}
        <CollapsibleSection title={t("conversations.historyPanel.pastConversations") || "Past conversations"} badge={history.length} defaultOpen>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-gray-200 border-t-primary-500 rounded-full animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-xs text-gray-400">{t("conversations.historyPanel.noHistory")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((conv) => {
                const isExpanded = expandedId === conv.id;
                const isCurrent = conv.id === conversation?.id;
                // CRM-side summary for this prior conversation (sentiment,
                // qualification, action items). Falls back to null when no
                // ConversationIntelligence row exists yet.
                const crmSummary = summaryByConv.get(conv.id);
                return (
                  <div
                    key={conv.id}
                    className={clsx(
                      "rounded-xl transition-all",
                      isCurrent
                        ? "bg-primary-50/40"
                        : "bg-gray-50/50 hover:bg-gray-50/80"
                    )}
                  >
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : conv.id)}
                      className="w-full text-start p-3"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <PlatformBadge channel={conv.channel} />
                          {/* Imported threads are labelled, never passed off as
                              conversations that happened in GOTCHA. They are
                              the customer's real history, from before they
                              connected - and an agent reading one needs to
                              know that. */}
                          {conv.origin === "HISTORICAL_IMPORT" && (
                            <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[9px] font-medium text-violet-700">
                              {t("conversations.historyPanel.imported")}
                            </span>
                          )}
                          <span className="text-[10px] text-gray-400">
                            {format(new Date(conv.createdAt), "MMM d, yyyy")}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <HistoryStatusBadge status={conv.status} t={t} />
                          <svg
                            className={clsx("w-3 h-3 text-gray-400 transition-transform", isExpanded && "rotate-180")}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                          </svg>
                        </div>
                      </div>
                      <p className="text-xs text-gray-600 truncate">
                        {conv.lastMessageBody || t("conversations.historyPanel.noHistory")}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-gray-400">
                          {conv._count?.messages || 0} {t("conversations.historyPanel.messages")}
                        </span>
                        {conv.assignedAgent && (
                          <span className="text-[10px] text-gray-400">
                            &middot; {conv.assignedAgent.name}
                          </span>
                        )}
                        {isCurrent && (
                          <span className="text-[9px] font-semibold text-primary-500 bg-primary-100 px-1.5 py-0.5 rounded-full ms-auto">
                            {t("conversations.historyPanel.current")}
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="px-3 pb-3 border-t border-gray-100/50 pt-2 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-gray-400">{t("conversations.historyPanel.started")}</span>
                          <span className="text-[10px] text-gray-600">
                            {format(new Date(conv.createdAt), "MMM d, yyyy HH:mm")}
                          </span>
                        </div>
                        {conv.closedAt && (
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-gray-400">{t("conversations.historyPanel.closed")}</span>
                            <span className="text-[10px] text-gray-600">
                              {format(new Date(conv.closedAt), "MMM d, yyyy HH:mm")}
                            </span>
                          </div>
                        )}
                        {(conv.aiSummary || crmSummary?.summary) && (
                          <div className="mt-2 p-2.5 bg-violet-50 rounded-lg">
                            <div className="flex items-center gap-1.5 mb-1">
                              <svg className="w-3.5 h-3.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                              </svg>
                              <span className="text-[10px] font-semibold text-violet-600 uppercase tracking-wide">{t("conversations.historyPanel.aiSummary")}</span>
                            </div>
                            <div className="text-xs text-gray-600 leading-relaxed history-summary-md">
                              <ReactMarkdown>
                                {crmSummary?.summary || conv.aiSummary || ""}
                              </ReactMarkdown>
                            </div>
                            {/* Sentiment / qualification / action-item chips
                                that used to live in the now-removed
                                "AI summaries (other channels)" section. */}
                            {(crmSummary?.sentiment || crmSummary?.qualification || (crmSummary?.actionItems && crmSummary.actionItems.length > 0)) && (
                              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                {crmSummary?.sentiment && (
                                  <span className={clsx(
                                    "text-[10px] px-1.5 py-0.5 rounded-full",
                                    crmSummary.sentiment.toLowerCase().includes("positive") && "bg-emerald-50 text-emerald-700",
                                    crmSummary.sentiment.toLowerCase().includes("negative") && "bg-rose-50 text-rose-700",
                                    crmSummary.sentiment.toLowerCase().includes("neutral") && "bg-gray-100 text-gray-600",
                                  )}>
                                    {crmSummary.sentiment}
                                  </span>
                                )}
                                {crmSummary?.qualification && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                                    {crmSummary.qualification}
                                  </span>
                                )}
                                {(crmSummary?.actionItems ?? []).slice(0, 3).map((a, i) => (
                                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 max-w-[200px] truncate" title={a}>
                                    • {a}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {conv.lastMessageAt && (
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-gray-400">{t("conversations.historyPanel.lastActivity")}</span>
                            <span className="text-[10px] text-gray-600">
                              {formatDistanceToNow(new Date(conv.lastMessageAt), { addSuffix: true })}
                            </span>
                          </div>
                        )}
                        {!isCurrent && onSelectConversation && (
                          <button
                            onClick={() => onSelectConversation(conv.id)}
                            className="w-full mt-1 text-[10px] text-primary-600 hover:text-primary-700 font-medium py-1.5 bg-primary-50 hover:bg-primary-100 rounded-lg transition"
                          >
                            {t("conversations.historyPanel.viewConversation")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>

        {/* Open CRM tasks (collapsible) */}
        {!shopifyActive && isLinked && (
          <CollapsibleSection title={t("conversations.historyPanel.openTasks")} badge={openIssues.length} defaultOpen>
            {openIssues.length === 0 ? (
              <div className="text-[11px] text-gray-400 italic">{t("conversations.historyPanel.noOpenTasks")}</div>
            ) : (
              <ul className="space-y-1.5">
                {openIssues.map((iss) => (
                  <li key={iss.id} className="rounded-lg bg-white border border-amber-200 px-2.5 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-amber-800 truncate">{iss.subject}</div>
                        {iss.description && (
                          <div className="text-[11px] text-gray-600 mt-0.5 line-clamp-2">{iss.description}</div>
                        )}
                        <div className="text-[10px] text-gray-500 mt-1 space-x-2">
                          {iss.status && <span className="font-mono">{iss.status}</span>}
                          {iss.due_at && <span>due: {new Date(iss.due_at).toLocaleDateString()}</span>}
                          {iss.priority && <span>priority: {iss.priority}</span>}
                        </div>
                      </div>
                      {iss.is_open && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0">open</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>
        )}

        {/* CRM activity timeline (collapsible) */}
        {!shopifyActive && isLinked && (
          <CollapsibleSection title={t("conversations.historyPanel.crmActivity")} badge={crmActivities.length}>
            {crmActivities.length === 0 ? (
              <div className="text-[11px] text-gray-400 italic">{t("conversations.historyPanel.noCrmActivity")}</div>
            ) : (
              <ul className="space-y-1.5">
                {crmActivities.map((a) => (
                  <li key={a.id} className="rounded-lg bg-white border border-gray-100 px-2.5 py-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-gray-500 uppercase">{a.kind}</span>
                      <span className="text-[10px] text-gray-400">{new Date(a.occurred_at).toLocaleString()}</span>
                    </div>
                    <ExpandableBody body={a.body} maxChars={160} t={t} />
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>
        )}

        {/* CRM notes (read-only, fetched fresh up to 10 from the vendor side) */}
        {!shopifyActive && isLinked && (
          <CollapsibleSection title={t("conversations.historyPanel.crmNotes")} badge={crmNotes.length}>
            {crmNotes.length === 0 ? (
              <div className="text-[11px] text-gray-400 italic">{t("conversations.historyPanel.noCrmNotes")}</div>
            ) : (
              <ul className="space-y-1.5">
                {crmNotes.map((n) => (
                  <li key={n.id} className="rounded-lg bg-white border border-gray-100 px-2.5 py-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-gray-500 uppercase">{n.kind}</span>
                      <span className="text-[10px] text-gray-400">{new Date(n.occurred_at).toLocaleDateString()}</span>
                    </div>
                    <ExpandableBody body={n.body} maxChars={220} t={t} />
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>
        )}

        {/* Manual CRM note composer - kept, since this is a deliberate
            agent action (lands on the vendor's contact timeline). Only
            the local "demo" notes block was removed. */}
        {!shopifyActive && isLinked && (
          <CollapsibleSection title={t("crmPanel.addNote")}>
            <textarea
              value={crmNoteText}
              onChange={(e) => setCrmNoteText(e.target.value)}
              placeholder={t("crmPanel.notePlaceholder") || "Quick note about this conversation…"}
              maxLength={5000}
              rows={3}
              className="w-full text-xs resize-none rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[10px] text-gray-400">{crmNoteText.length}/5000</span>
              <button
                onClick={handlePostCrmNote}
                disabled={postingCrmNote || !crmNoteText.trim()}
                className="text-xs font-medium px-3 py-1 rounded-md bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 transition"
              >
                {postingCrmNote ? (t("crmPanel.posting") || "Posting…") : (t("crmPanel.post") || "Post")}
              </button>
            </div>
            {crmNoteMsg && (
              <div className={clsx(
                "mt-1.5 text-[11px] px-2 py-1 rounded",
                crmNoteMsg.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-600",
              )}>
                {crmNoteMsg.text}
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* CRM status hints (when not linked) */}
        {!shopifyActive && crmContext?.status === "no_crm_configured" && !crmLoading && (
          <div className="text-[11px] px-3 py-2 rounded-lg bg-amber-50 text-amber-700 border border-amber-100">
            {t("crmPanel.noCrm") || "No CRM connected. Connect one under Settings → Integrations."}
          </div>
        )}

        {/* Local "demo" notes section removed - agents add notes from the
            normal conversation compose surface. The CRM notes collapsible
            above is the canonical read-only timeline. */}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 bg-gray-50/30">
        <p className="text-[10px] text-gray-400 text-center">
          {t("conversations.historyPanel.footer")}
        </p>
      </div>
    </div>
  );
}

// Platform pill - uses the same PNG icons (from /public/icons) that the
// inbox conversation cards render, so cross-platform history visually
// matches the inbox. Falls back to a text label for channels that don't
// have a logo (Voice, SMS, WebChat) but keeps the same chip shape.
const CHANNEL_ICONS: Record<string, { logo?: string; label: string }> = {
  WHATSAPP:  { logo: "/icons/wa.png",  label: "WhatsApp" },
  MESSENGER: { logo: "/icons/msn.png", label: "Messenger" },
  FACEBOOK:  { logo: "/icons/msn.png", label: "Messenger" },
  INSTAGRAM: { logo: "/icons/ins.png", label: "Instagram" },
  GMAIL:     { logo: "/icons/gm.png",  label: "Gmail" },
  EMAIL:     { logo: "/icons/gm.png",  label: "Email" },
  OUTLOOK:   { logo: "/icons/ol.png",  label: "Outlook" },
  SLACK:     { logo: "/icons/slk.png", label: "Slack" },
  WEBCHAT:   { label: "Web" },
  VOICE:     { label: "Voice" },
  SMS:       { label: "SMS" },
};

// Collapsible section wrapper - each context category opens/closes
// independently with a chevron and shows a count badge (gray when empty).
function CollapsibleSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isEmpty = typeof badge === "number" && badge === 0;
  return (
    <div className="rounded-lg border border-gray-100 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-start hover:bg-gray-50/60 transition rounded-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-700">{title}</span>
          {typeof badge === "number" && (
            <span className={clsx(
              "text-[10px] px-1.5 py-0.5 rounded-full font-mono",
              isEmpty ? "bg-gray-100 text-gray-400" : "bg-violet-100 text-violet-700",
            )}>
              {badge}
            </span>
          )}
        </div>
        <svg
          className={clsx("w-3.5 h-3.5 text-gray-400 transition-transform", open && "rotate-180")}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1">{children}</div>
      )}
    </div>
  );
}

// Highlighted Customer Brief card pinned at the top of the panel. Persistent
// customer-level behavioral intelligence (NOT scoped to this conversation -
// that lives in Co-Pilot). Gradient shell so it visually anchors above the
// structured CRM blocks.
function AISummaryCard({
  summary,
  loading,
  error,
  onRefresh,
  t,
}: {
  summary: CustomerSummary | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const tone = typeof summary?.meta?.tone === "string" ? (summary.meta.tone as string) : null;
  const mood = typeof summary?.meta?.mood === "string" ? (summary.meta.mood as string) : null;
  const recommendedBehaviors = Array.isArray(summary?.meta?.recommended_behaviors)
    ? (summary!.meta!.recommended_behaviors as string[])
    : [];
  const channels = Array.isArray(summary?.meta?.channels)
    ? (summary!.meta!.channels as string[])
    : [];
  const lastSourceChannel = typeof summary?.meta?.last_source_channel === "string"
    ? (summary!.meta!.last_source_channel as string)
    : null;
  const convCount = typeof summary?.meta?.conversation_count === "number"
    ? (summary!.meta!.conversation_count as number)
    : null;

  return (
    <div className="relative rounded-xl p-[1.5px] bg-gradient-to-br from-violet-500 via-purple-500 to-pink-500 shadow-sm">
      <div className="rounded-[11px] bg-white p-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </span>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold uppercase tracking-wide bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                {t("crmPanel.brief.title")}
              </span>
              <span className="text-[9px] text-gray-400 -mt-0.5">
                {channels.length > 1
                  ? t("crmPanel.brief.acrossN", { count: String(channels.length) })
                  : t("crmPanel.brief.across")}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="text-[10px] text-violet-500 hover:text-violet-700 disabled:opacity-40 transition"
            title={t("crmPanel.brief.refresh")}
          >
            {loading ? "…" : "↻"}
          </button>
        </div>
        {error && <div className="text-[11px] text-rose-600">{error}</div>}
        {!error && loading && !summary && (
          <div className="text-[11px] text-gray-400 italic">{t("crmPanel.brief.generating")}</div>
        )}
        {!error && summary && (
          <>
            <p className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap">
              {summary.summary}
            </p>

            {(mood || tone) && (
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                {mood && (
                  <span className="px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-100">
                    <span className="font-semibold mr-1">{t("crmPanel.brief.mood")}:</span>{mood}
                  </span>
                )}
                {tone && (
                  <span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                    <span className="font-semibold mr-1">{t("crmPanel.brief.tone")}:</span>{tone}
                  </span>
                )}
              </div>
            )}

            {summary.signals && summary.signals.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {summary.signals.map((s, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-100"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}

            {recommendedBehaviors.length > 0 && (
              <div className="mt-2 pt-2 border-t border-gray-100">
                <div className="text-[9px] uppercase tracking-wide text-gray-500 mb-1">{t("crmPanel.brief.howToTreat")}</div>
                <ul className="space-y-0.5">
                  {recommendedBehaviors.map((b, i) => (
                    <li key={i} className="text-[11px] text-gray-700 flex items-start gap-1">
                      <span className="text-emerald-500 mt-0.5">✓</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-1.5 text-[9px] text-gray-400 flex items-center justify-between">
              <span>
                {summary.cached ? t("crmPanel.brief.saved") : t("crmPanel.brief.fresh")} · {new Date(summary.generated_at).toLocaleString()}
              </span>
              <span className="text-right">
                {convCount != null && convCount > 0 && (
                  <span>
                    {convCount === 1
                      ? t("crmPanel.brief.priorConv", { count: String(convCount) })
                      : t("crmPanel.brief.priorConvs", { count: String(convCount) })}
                  </span>
                )}
                {lastSourceChannel && (
                  <span className="ml-1 text-gray-300">· {t("crmPanel.brief.lastChannel", { channel: lastSourceChannel.toLowerCase() })}</span>
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Truncates long CRM note / activity bodies to `maxChars` and surfaces a
 * "See all" link in the bottom-right when there's more. Click reveals the
 * full body inline; "Show less" collapses again. Uses character-count
 * (not CSS line-clamp) so the trigger is deterministic across RTL/LTR and
 * variable line heights.
 */
function ExpandableBody({ body, maxChars, t }: {
  body: string;
  maxChars: number;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState(false);
  const text = (body || "").trim();
  const isLong = text.length > maxChars;
  // When collapsed we slice on raw text so the trigger is deterministic
  // (CSS line-clamp varies with line height + RTL). The slice may cut
  // mid-markdown - that's fine because the collapsed view is preview-only;
  // the full markdown renders cleanly when expanded.
  const visible = open || !isLong ? text : text.slice(0, maxChars).trimEnd() + "…";
  return (
    <div className="mt-0.5">
      <div className="text-xs text-gray-700 leading-relaxed history-summary-md">
        <ReactMarkdown>{visible}</ReactMarkdown>
      </div>
      {isLong && (
        <div className="flex justify-end mt-0.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[10px] text-blue-600 hover:text-blue-800 hover:underline font-medium"
          >
            {open ? t("conversations.historyPanel.showLess") : t("conversations.historyPanel.seeAll")}
          </button>
        </div>
      )}
    </div>
  );
}

function PlatformBadge({ channel }: { channel: string | null | undefined }) {
  const norm = (channel || "").toUpperCase();
  const cfg = CHANNEL_ICONS[norm] || { label: norm || "?" };
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white border border-gray-200 text-[10px] font-medium text-gray-700"
      title={cfg.label}
    >
      {cfg.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cfg.logo} alt={cfg.label} className="w-3 h-3 rounded-sm" />
      ) : (
        <span className="w-3 h-3 rounded-sm bg-gray-200 inline-block" />
      )}
      {cfg.label}
    </span>
  );
}

function HistoryStatusBadge({ status, t }: { status: string; t: (key: string) => string }) {
  const config: Record<string, { class: string; label: string }> = {
    OPEN: { class: "bg-green-50 text-green-600", label: t("conversations.historyPanel.statusOpen") },
    WAITING: { class: "bg-amber-50 text-amber-600", label: t("conversations.historyPanel.statusWaiting") },
    CLOSED: { class: "bg-gray-100 text-gray-500", label: t("conversations.historyPanel.statusClosed") },
  };
  const c = config[status] || config.OPEN;
  return (
    <span className={clsx("text-[9px] px-1.5 py-0.5 rounded-full font-medium", c.class)}>
      {c.label}
    </span>
  );
}
