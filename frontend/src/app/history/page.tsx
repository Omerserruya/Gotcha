"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getConversations, getConversation, getConversationScore } from "@/lib/api";
import { ChannelBadge } from "@/components/conversations/ChannelBadge";
import { ConversationReplay } from "@/components/conversations/ConversationReplay";
import { format, formatDistanceToNow } from "date-fns";
import clsx from "clsx";

interface CustomerGroup {
  key: string; // customerExternalId or customerPhone
  name: string;
  channel: string;
  conversations: any[];
  lastMessageAt: string;
  lastMessageBody: string;
  totalMessages: number;
}

function ScoreBar({ label, score, max = 5 }: { label: string; score: number; max?: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-500 w-32 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-violet-400 to-violet-600 rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, (score / max) * 100)}%` }}
        />
      </div>
      <span className="text-xs font-medium text-gray-700 w-8 shrink-0">{score}/{max}</span>
    </div>
  );
}

function StarRating({ score, max = 100 }: { score: number; max?: number }) {
  const stars = Math.round((score / max) * 5);
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <svg
          key={s}
          className={clsx("w-4 h-4", s <= stars ? "text-amber-400" : "text-gray-200")}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
        </svg>
      ))}
    </div>
  );
}

export default function HistoryPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("CLOSED");
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [convMessages, setConvMessages] = useState<any[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [showReplay, setShowReplay] = useState(false);

  // Score panel state
  const [showScore, setShowScore] = useState(false);
  const [scoreData, setScoreData] = useState<any>(null);
  const [scoreLoading, setScoreLoading] = useState(false);
  const [scoreError, setScoreError] = useState("");

  const canAccess = user?.role === "ADMIN" || user?.departmentRole === "MANAGER";

  const fetchConversations = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: "200", page: String(page) };
      if (search) params.search = search;
      if (channelFilter !== "ALL") params.channel = channelFilter;
      if (statusFilter !== "ALL") params.status = statusFilter;
      const res = await getConversations(token, params);
      setConversations(res.data);
      setTotalPages(res.meta?.totalPages || 1);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [token, search, channelFilter, statusFilter, page]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  // Group conversations by customer
  const customerGroups = useMemo(() => {
    const groups: Record<string, CustomerGroup> = {};
    for (const conv of conversations) {
      const key = conv.customerExternalId || conv.customerPhone || conv.id;
      if (!groups[key]) {
        groups[key] = {
          key,
          name: conv.customerName || conv.customerExternalId || conv.customerPhone || "Unknown",
          channel: conv.channel || "WHATSAPP",
          conversations: [],
          lastMessageAt: conv.lastMessageAt || conv.createdAt,
          lastMessageBody: conv.lastMessageBody || "",
          totalMessages: 0,
        };
      }
      groups[key].conversations.push(conv);
      groups[key].totalMessages += conv._count?.messages || 0;
      if (conv.lastMessageAt && conv.lastMessageAt > groups[key].lastMessageAt) {
        groups[key].lastMessageAt = conv.lastMessageAt;
        groups[key].lastMessageBody = conv.lastMessageBody || "";
      }
    }
    return Object.values(groups).sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    );
  }, [conversations]);

  const selectedGroup = customerGroups.find((g) => g.key === selectedCustomer);

  const loadMessages = useCallback(async (convId: string) => {
    if (!token) return;
    setSelectedConvId(convId);
    setMessagesLoading(true);
    // Reset score panel when switching conversations
    setShowScore(false);
    setScoreData(null);
    setScoreError("");
    try {
      const res = await getConversation(token, convId);
      setConvMessages(res.data?.messages || []);
    } catch (err) {
      console.error(err);
    } finally {
      setMessagesLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (selectedGroup && selectedGroup.conversations.length > 0) {
      loadMessages(selectedGroup.conversations[0].id);
    } else {
      setSelectedConvId(null);
      setConvMessages([]);
    }
  }, [selectedCustomer]);

  async function handleShowScore() {
    if (!token || !selectedConvId) return;
    if (showScore) {
      setShowScore(false);
      return;
    }
    setShowScore(true);
    setShowReplay(false);
    if (scoreData) return; // already loaded for this conv
    setScoreLoading(true);
    setScoreError("");
    try {
      const res = await getConversationScore(token, selectedConvId);
      setScoreData(res.data);
    } catch (err: any) {
      setScoreError(err.message || "Failed to load score");
    } finally {
      setScoreLoading(false);
    }
  }

  if (!canAccess) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <p className="text-sm text-gray-400">{t("common.error")}</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex md:gap-2 h-[calc(100vh-48px)] md:h-[calc(100vh-16px)]">
        {/* Left: Customer list */}
        <div className={clsx(
          "w-full md:w-[340px] border-e border-gray-100 bg-white flex-shrink-0 flex flex-col md:rounded-2xl md:shadow-subtle md:overflow-hidden",
          selectedCustomer ? "hidden md:flex" : "flex"
        )}>
          <div className="p-4 border-b border-gray-100">
            <h1 className="text-lg font-bold text-gray-900 ps-8 md:ps-0">{t("history.title")}</h1>
            <p className="text-xs text-gray-400 mt-0.5 ps-8 md:ps-0">
              {user?.role === "ADMIN" ? t("history.adminDesc") : t("history.managerDesc")}
            </p>
          </div>

          {/* Search & Filters */}
          <div className="p-3 border-b border-gray-100 space-y-2">
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder={t("history.searchPlaceholder")}
                className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
              />
              <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
            </div>
            <div className="flex gap-1.5">
              {["ALL", "WHATSAPP", "MESSENGER", "INSTAGRAM", "GMAIL", "OUTLOOK", "SLACK"].map((ch) => (
                <button
                  key={ch}
                  onClick={() => { setChannelFilter(ch); setPage(1); }}
                  className={clsx(
                    "text-[10px] px-2.5 py-1 rounded-lg font-medium transition",
                    channelFilter === ch
                      ? ch === "WHATSAPP" ? "bg-green-100 text-green-700"
                        : ch === "MESSENGER" ? "bg-blue-100 text-blue-700"
                        : ch === "INSTAGRAM" ? "bg-pink-100 text-pink-700"
                        : ch === "GMAIL" ? "bg-red-100 text-red-700"
                        : ch === "OUTLOOK" ? "bg-blue-100 text-blue-700"
                        : ch === "SLACK" ? "bg-purple-100 text-purple-700"
                        : "bg-primary-100 text-primary-700"
                      : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                  )}
                >
                  {ch === "ALL" ? t("conversations.channelAll") : t(`conversations.channel${ch.charAt(0) + ch.slice(1).toLowerCase()}`)}
                </button>
              ))}
              <div className="ms-auto">
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                  className="text-[10px] px-2 py-1 bg-gray-100 border-0 rounded-lg text-gray-600 font-medium focus:ring-2 focus:ring-primary-200 outline-none"
                >
                  <option value="ALL">{t("conversations.filterAll")}</option>
                  <option value="OPEN">{t("conversations.filterOpen")}</option>
                  <option value="WAITING">{t("conversations.filterWaiting")}</option>
                  <option value="CLOSED">{t("conversations.filterClosed")}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Customer list */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
              </div>
            ) : customerGroups.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-gray-400">{t("common.noResults")}</p>
              </div>
            ) : (
              <div>
                {customerGroups.map((group) => (
                  <button
                    key={group.key}
                    onClick={() => setSelectedCustomer(group.key)}
                    className={clsx(
                      "w-full text-start p-3 border-b border-gray-50 transition hover:bg-gray-50",
                      selectedCustomer === group.key && "bg-primary-50/50 border-s-2 border-s-primary-500"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-primary-100 to-primary-200 rounded-xl flex items-center justify-center shrink-0">
                        <span className="text-sm font-bold text-primary-600">
                          {group.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <ChannelBadge channel={group.channel} size="sm" />
                          <span className="text-sm font-medium text-gray-900 truncate">{group.name}</span>
                        </div>
                        <p className="text-xs text-gray-400 truncate">{group.lastMessageBody || t("common.noResults")}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-gray-400">
                            {group.conversations.length} {t("history.chats")}
                          </span>
                          <span className="text-[10px] text-gray-300">&middot;</span>
                          <span className="text-[10px] text-gray-400">
                            {group.totalMessages} {t("conversations.messages")}
                          </span>
                        </div>
                      </div>
                      <div className="text-end shrink-0">
                        <p className="text-[10px] text-gray-400">
                          {formatDistanceToNow(new Date(group.lastMessageAt), { addSuffix: true })}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 p-3 border-t border-gray-100">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="text-xs px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition disabled:opacity-40"
                >
                  {t("common.back")}
                </button>
                <span className="text-xs text-gray-400">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="text-xs px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition disabled:opacity-40"
                >
                  {t("history.next")}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Conversation timeline & messages */}
        <div className={clsx(
          "flex-1 flex flex-col bg-white md:rounded-2xl md:shadow-subtle md:overflow-hidden",
          selectedCustomer ? "flex" : "hidden md:flex"
        )}>
          {!selectedCustomer ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-300">
                <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                  <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-400">{t("history.selectCustomer")}</p>
              </div>
            </div>
          ) : (
            <>
              {/* Customer header */}
              <div className="bg-white border-b border-gray-100 px-5 py-3 flex items-center gap-3 shadow-sm">
                <button
                  onClick={() => setSelectedCustomer(null)}
                  className="md:hidden w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-600 -ml-1 shrink-0"
                  aria-label="Back"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                  </svg>
                </button>
                <div className="w-10 h-10 bg-gradient-to-br from-primary-100 to-primary-200 rounded-xl flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-primary-600">
                    {selectedGroup?.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <ChannelBadge channel={selectedGroup?.channel} size="md" showLabel />
                    <p className="font-semibold text-sm text-gray-900">{selectedGroup?.name}</p>
                  </div>
                  <p className="text-xs text-gray-400">
                    {selectedGroup?.key} &middot; {selectedGroup?.conversations.length} {t("history.chats")}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Score button */}
                  <button
                    onClick={handleShowScore}
                    className={clsx(
                      "hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition",
                      showScore
                        ? "bg-violet-100 text-violet-700"
                        : "bg-gray-100 text-gray-600 hover:bg-violet-50 hover:text-violet-600"
                    )}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                    </svg>
                    {t("agentScore.score")}
                  </button>
                  {/* Replay toggle */}
                  <button
                    onClick={() => { setShowReplay(!showReplay); if (!showReplay) setShowScore(false); }}
                    className={clsx(
                      "hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition",
                      showReplay
                        ? "bg-amber-100 text-amber-700"
                        : "bg-gray-100 text-gray-600 hover:bg-violet-50 hover:text-violet-600"
                    )}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                    </svg>
                    {showReplay ? "Hide Replay" : "AI Replay"}
                  </button>
                </div>
              </div>

              <div className="flex-1 flex overflow-hidden">
                {/* Conversation timeline */}
                <div className="hidden sm:block w-[200px] md:w-[260px] border-e border-gray-100 bg-white overflow-y-auto shrink-0">
                  <div className="p-2.5">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-2">
                      {t("history.timeline")}
                    </span>
                  </div>
                  {selectedGroup?.conversations
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => loadMessages(conv.id)}
                      className={clsx(
                        "w-full text-start px-3 py-2.5 border-b border-gray-50 transition",
                        selectedConvId === conv.id
                          ? "bg-primary-50 border-s-2 border-s-primary-500"
                          : "hover:bg-gray-50"
                      )}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-gray-500 font-medium">
                          {format(new Date(conv.createdAt), "MMM d, yyyy")}
                        </span>
                        <span className={clsx(
                          "text-[9px] px-1.5 py-0.5 rounded-full font-medium",
                          conv.status === "OPEN" ? "bg-green-50 text-green-600"
                            : conv.status === "WAITING" ? "bg-amber-50 text-amber-600"
                            : "bg-gray-100 text-gray-500"
                        )}>
                          {conv.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 truncate">{conv.lastMessageBody || "No messages"}</p>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-400">
                        <span>{conv._count?.messages || 0} {t("conversations.messages")}</span>
                        {conv.assignedAgent && (
                          <>
                            <span>&middot;</span>
                            <span>{conv.assignedAgent.name}</span>
                          </>
                        )}
                        {conv.department && (
                          <>
                            <span>&middot;</span>
                            <span>{conv.department.name}</span>
                          </>
                        )}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Score Panel */}
                {showScore && selectedConvId && (
                  <div className="w-[300px] border-e border-gray-100 bg-white overflow-y-auto shrink-0 flex flex-col">
                    {/* Panel header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                      <h3 className="text-sm font-semibold text-gray-900">{t("agentScore.title")}</h3>
                      <button
                        onClick={() => setShowScore(false)}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    <div className="flex-1 p-4">
                      {scoreLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
                        </div>
                      ) : scoreError ? (
                        <div className="text-center py-8">
                          <p className="text-sm text-gray-400">{t("agentScore.noScore")}</p>
                          <p className="text-xs text-red-400 mt-1">{scoreError}</p>
                        </div>
                      ) : !scoreData ? (
                        <div className="text-center py-8">
                          <p className="text-sm text-gray-400">{t("agentScore.noScore")}</p>
                        </div>
                      ) : (
                        <div className="space-y-5">
                          {/* Overall score */}
                          <div className="bg-violet-50 rounded-xl p-4 text-center">
                            <p className="text-xs text-gray-500 mb-1">{t("agentScore.overall")}</p>
                            <p className="text-3xl font-bold text-violet-700 mb-1">
                              {scoreData.overallScore ?? scoreData.overall ?? 0}
                              <span className="text-base font-normal text-gray-400">/100</span>
                            </p>
                            <StarRating score={scoreData.overallScore ?? scoreData.overall ?? 0} />
                          </div>

                          {/* Score bars */}
                          <div className="space-y-3">
                            {(scoreData.responseSpeed !== undefined) && (
                              <ScoreBar label={t("agentScore.responseSpeed")} score={scoreData.responseSpeed} />
                            )}
                            {(scoreData.responseQuality !== undefined) && (
                              <ScoreBar label={t("agentScore.responseQuality")} score={scoreData.responseQuality} />
                            )}
                            {(scoreData.resolution !== undefined) && (
                              <ScoreBar label={t("agentScore.resolution")} score={scoreData.resolution} />
                            )}
                            {(scoreData.protocol !== undefined || scoreData.protocolAdherence !== undefined) && (
                              <ScoreBar label={t("agentScore.protocol")} score={scoreData.protocol ?? scoreData.protocolAdherence ?? 0} />
                            )}
                            {(scoreData.customerHandling !== undefined) && (
                              <ScoreBar label={t("agentScore.customerHandling")} score={scoreData.customerHandling} />
                            )}
                          </div>

                          {/* Strengths */}
                          {scoreData.strengths && scoreData.strengths.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-green-700 mb-2 flex items-center gap-1">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                {t("agentScore.strengths")}
                              </p>
                              <ul className="space-y-1">
                                {scoreData.strengths.map((s: string, i: number) => (
                                  <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                                    <span className="text-green-400 mt-0.5 shrink-0">&bull;</span>
                                    {s}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Improvements */}
                          {scoreData.improvements && scoreData.improvements.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-amber-700 mb-2 flex items-center gap-1">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                                </svg>
                                {t("agentScore.improvements")}
                              </p>
                              <ul className="space-y-1">
                                {scoreData.improvements.map((s: string, i: number) => (
                                  <li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
                                    <span className="text-amber-400 mt-0.5 shrink-0">&bull;</span>
                                    {s}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Stats */}
                          <div className="border-t border-gray-100 pt-4 space-y-2">
                            {scoreData.copilotUsage !== undefined && (
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-500">{t("agentScore.copilotUsage")}</span>
                                <span className="text-xs font-medium text-gray-700">{scoreData.copilotUsage}%</span>
                              </div>
                            )}
                            {scoreData.toolsUsed !== undefined && (
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-500">{t("agentScore.toolsUsed")}</span>
                                <span className="text-xs font-medium text-gray-700">{scoreData.toolsUsed}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Replay Panel */}
                {showReplay && selectedConvId && (
                  <ConversationReplay
                    conversation={selectedGroup?.conversations.find((c: any) => c.id === selectedConvId)}
                    messages={convMessages}
                    onClose={() => setShowReplay(false)}
                  />
                )}

                {/* Messages view */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  {messagesLoading ? (
                    <div className="flex-1 flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                    </div>
                  ) : convMessages.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center">
                      <p className="text-sm text-gray-400">{t("common.noResults")}</p>
                    </div>
                  ) : (
                    <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-[var(--bg-chat)]">
                      {selectedConvId && (
                        <div className="flex items-center gap-3 py-2">
                          <div className="flex-1 h-px bg-gray-200" />
                          <span className="text-[10px] text-gray-400 font-medium bg-white px-3 py-1 rounded-full border border-gray-100">
                            {format(new Date(convMessages[0]?.createdAt || Date.now()), "MMMM d, yyyy")}
                          </span>
                          <div className="flex-1 h-px bg-gray-200" />
                        </div>
                      )}
                      {convMessages.map((msg) =>
                        msg.messageType === "system" ? (
                          <div key={msg.id} className="flex items-center gap-3 py-1">
                            <div className="flex-1 h-px bg-gray-200" />
                            <span className="text-[10px] text-gray-400 bg-gray-50 px-2.5 py-1 rounded-full border border-gray-100">
                              {msg.metadata?.systemEvent || "System"}
                            </span>
                            <div className="flex-1 h-px bg-gray-200" />
                          </div>
                        ) : (
                          <div
                            key={msg.id}
                            className={clsx("flex", msg.direction === "OUTBOUND" ? "justify-end" : "justify-start")}
                          >
                            <div className={clsx(
                              "max-w-[75%] px-4 py-2.5 text-sm",
                              msg.direction === "OUTBOUND" ? "chat-bubble-outbound" : "chat-bubble-inbound"
                            )}>
                              {msg.senderName && msg.direction === "OUTBOUND" && (
                                <p className="text-[10px] opacity-70 mb-0.5 font-medium">{msg.senderName}</p>
                              )}
                              <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                              <div className={clsx(
                                "flex items-center gap-1 mt-1",
                                msg.direction === "OUTBOUND" ? "justify-end" : "justify-start"
                              )}>
                                <span className="text-[10px] opacity-50">
                                  {format(new Date(msg.createdAt), "HH:mm")}
                                </span>
                              </div>
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
