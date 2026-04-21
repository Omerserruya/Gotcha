"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getConversationHistory } from "@/lib/api";
import { formatDistanceToNow, format } from "date-fns";
import clsx from "clsx";

interface HistoryPanelProps {
  conversation: any;
  onClose?: () => void;
  onSelectConversation?: (id: string) => void;
}

interface Note {
  id: string;
  text: string;
  createdAt: string;
}

export function HistoryPanel({ conversation, onClose, onSelectConversation }: HistoryPanelProps) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState("");

  const customerKey = conversation?.customerExternalId;

  const fetchHistory = useCallback(async () => {
    if (!token || !customerKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await getConversationHistory(token, customerKey);
      setHistory(res.data);
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoading(false);
    }
  }, [token, customerKey]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  function handleAddNote() {
    if (!noteText.trim()) return;
    const note: Note = {
      id: Date.now().toString(),
      text: noteText.trim(),
      createdAt: new Date().toISOString(),
    };
    setNotes((prev) => [note, ...prev]);
    setNoteText("");
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
          <p className="text-sm font-semibold text-gray-900">{t("conversations.historyPanel.title")}</p>
          <p className="text-[10px] text-gray-400 truncate">{conversation?.customerExternalId}</p>
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
      <div className="flex-1 overflow-y-auto">
        {/* Conversation History Section */}
        <div className="p-3">
          <div className="flex items-center gap-1.5 mb-2 px-0.5">
            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
            </svg>
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              {t("conversations.historyPanel.pastConversations")} ({history.length})
            </span>
          </div>

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
                        <span className="text-[10px] text-gray-400">
                          {format(new Date(conv.createdAt), "MMM d, yyyy")}
                        </span>
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
                        {conv.aiSummary && (
                          <div className="mt-2 p-2.5 bg-violet-50 rounded-lg">
                            <div className="flex items-center gap-1.5 mb-1">
                              <svg className="w-3.5 h-3.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                              </svg>
                              <span className="text-[10px] font-semibold text-violet-600 uppercase tracking-wide">{t("conversations.historyPanel.aiSummary")}</span>
                            </div>
                            <p className="text-xs text-gray-600 leading-relaxed">{conv.aiSummary}</p>
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
        </div>

        {/* Notes Section */}
        <div className="p-3 bg-gray-50/30">
          <div className="flex items-center gap-1.5 mb-2 px-0.5">
            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              {t("conversations.historyPanel.notes")}
            </span>
            <span className="text-[9px] text-amber-500 bg-amber-50 px-1.5 py-0.5 rounded-full font-medium ms-auto">
              {t("conversations.historyPanel.demo")}
            </span>
          </div>

          {/* Add note input */}
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
              placeholder={t("conversations.historyPanel.addNotePlaceholder")}
              className="flex-1 px-3 py-2 bg-gray-50/80 border-0 ring-1 ring-gray-200/60 rounded-xl text-xs focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition"
            />
            <button
              onClick={handleAddNote}
              disabled={!noteText.trim()}
              className="px-3 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-xl text-xs font-medium transition disabled:opacity-40"
            >
              {t("conversations.historyPanel.addNote")}
            </button>
          </div>

          {/* Notes timeline */}
          {notes.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-[11px] text-gray-400">{t("conversations.historyPanel.noNotes")}</p>
              <p className="text-[10px] text-gray-300 mt-0.5">{t("conversations.historyPanel.noNotesHint")}</p>
            </div>
          ) : (
            <div className="space-y-0">
              {notes.map((note, idx) => (
                <div key={note.id} className="flex gap-2.5">
                  {/* Timeline line */}
                  <div className="flex flex-col items-center">
                    <div className="w-2 h-2 bg-primary-400 rounded-full mt-1.5 shrink-0" />
                    {idx < notes.length - 1 && <div className="w-px flex-1 bg-gray-200 my-0.5" />}
                  </div>
                  {/* Note content */}
                  <div className="pb-3 flex-1 min-w-0">
                    <p className="text-xs text-gray-700 leading-relaxed">{note.text}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {formatDistanceToNow(new Date(note.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
