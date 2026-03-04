"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getConversations, getConversation } from "@/lib/api";
import { ChannelBadge } from "@/components/conversations/ChannelBadge";
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
      // Keep the most recent lastMessageAt
      if (conv.lastMessageAt && conv.lastMessageAt > groups[key].lastMessageAt) {
        groups[key].lastMessageAt = conv.lastMessageAt;
        groups[key].lastMessageBody = conv.lastMessageBody || "";
      }
    }
    // Sort by most recent activity
    return Object.values(groups).sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    );
  }, [conversations]);

  const selectedGroup = customerGroups.find((g) => g.key === selectedCustomer);

  // Load messages when a conversation is selected
  const loadMessages = useCallback(async (convId: string) => {
    if (!token) return;
    setSelectedConvId(convId);
    setMessagesLoading(true);
    try {
      const res = await getConversation(token, convId);
      setConvMessages(res.data?.messages || []);
    } catch (err) {
      console.error(err);
    } finally {
      setMessagesLoading(false);
    }
  }, [token]);

  // Auto-select first conversation when selecting a customer
  useEffect(() => {
    if (selectedGroup && selectedGroup.conversations.length > 0) {
      loadMessages(selectedGroup.conversations[0].id);
    } else {
      setSelectedConvId(null);
      setConvMessages([]);
    }
  }, [selectedCustomer]);

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
        <div className="w-full md:w-[340px] border-e border-gray-100 bg-white flex-shrink-0 flex flex-col md:rounded-2xl md:shadow-subtle md:overflow-hidden">
          {/* Header */}
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
              {/* Channel filter chips */}
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
              {/* Status filter */}
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
        <div className="flex-1 flex flex-col bg-white md:rounded-2xl md:shadow-subtle md:overflow-hidden">
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
              </div>

              <div className="flex-1 flex overflow-hidden">
                {/* Conversation timeline */}
                <div className="w-[260px] border-e border-gray-100 bg-white overflow-y-auto shrink-0">
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
                      {/* Conversation date header */}
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
