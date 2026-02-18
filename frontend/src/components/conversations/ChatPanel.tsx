"use client";

import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getConversation,
  sendMessage,
  claimConversation,
  releaseConversation,
  closeConversation,
  reassignConversation,
  getAgents,
  getDepartments,
  transferToDepartment,
} from "@/lib/api";
import { getSocket } from "@/lib/socket";
import { format } from "date-fns";
import clsx from "clsx";
import { ChannelBadge } from "./ChannelBadge";
import { CoPilotPanel } from "./CoPilotPanel";
import { HistoryPanel } from "./HistoryPanel";

interface Props {
  conversationId: string;
  onBack: () => void;
}

export function ChatPanel({ conversationId, onBack }: Props) {
  const { token, user } = useAuth();
  const { t, dir } = useI18n();
  const [conversation, setConversation] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTab, setTransferTab] = useState<"agents" | "departments">("agents");
  const [agents, setAgents] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Notify AppLayout to auto-collapse sidebar when panels open
  useEffect(() => {
    const anyPanelOpen = copilotOpen || historyOpen;
    window.dispatchEvent(new CustomEvent("panel:toggle", { detail: { open: anyPanelOpen } }));
    return () => {
      // Restore sidebar when ChatPanel unmounts
      window.dispatchEvent(new CustomEvent("panel:toggle", { detail: { open: false } }));
    };
  }, [copilotOpen, historyOpen]);

  const fetchConversation = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getConversation(token, conversationId);
      setConversation(res.data);
      setMessages(res.data.messages || []);
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  }, [token, conversationId]);

  useEffect(() => {
    fetchConversation();
  }, [fetchConversation]);

  // Mark conversation as read (for unread indicator)
  useEffect(() => {
    if (conversationId) {
      try {
        const key = "chatcenter:lastRead";
        const stored = JSON.parse(localStorage.getItem(key) || "{}");
        stored[conversationId] = new Date().toISOString();
        localStorage.setItem(key, JSON.stringify(stored));
        window.dispatchEvent(new CustomEvent("conversation:read", { detail: { conversationId } }));
      } catch {}
    }
  }, [conversationId, messages.length]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Real-time message updates
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewMessage = (data: any) => {
      if (data.conversationId === conversationId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
      }
    };

    const handleStatusUpdate = (data: any) => {
      if (data.conversationId === conversationId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === data.messageId ? { ...m, status: data.status } : m
          )
        );
      }
    };

    const handleConversationUpdate = (data: any) => {
      if (data.id === conversationId) {
        setConversation((prev: any) => ({ ...prev, ...data }));
      }
    };

    socket.on("message:new", handleNewMessage);
    socket.on("message:status", handleStatusUpdate);
    socket.on("conversation:updated", handleConversationUpdate);

    return () => {
      socket.off("message:new", handleNewMessage);
      socket.off("message:status", handleStatusUpdate);
      socket.off("conversation:updated", handleConversationUpdate);
    };
  }, [conversationId]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!inputText.trim() || !token || sending) return;

    setSending(true);
    try {
      const res = await sendMessage(token, conversationId, inputText.trim());
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.data.id)) return prev;
        return [...prev, res.data];
      });
      setInputText("");
    } catch (err) {
      console.error("Send failed:", err);
    } finally {
      setSending(false);
    }
  }

  async function handleClaim() {
    if (!token) return;
    try {
      await claimConversation(token, conversationId);
      fetchConversation();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleRelease() {
    if (!token) return;
    try {
      await releaseConversation(token, conversationId);
      fetchConversation();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleClose() {
    if (!token) return;
    try {
      await closeConversation(token, conversationId);
      fetchConversation();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleTransfer(agentId: string) {
    if (!token) return;
    try {
      await reassignConversation(token, conversationId, agentId);
      setShowTransfer(false);
      fetchConversation();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleTransferToDept(departmentId: string) {
    if (!token) return;
    try {
      await transferToDepartment(token, conversationId, departmentId);
      setShowTransfer(false);
      fetchConversation();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function openTransferDialog() {
    if (!token) return;
    try {
      const [agentList, deptList] = await Promise.all([
        getAgents(token),
        getDepartments(token),
      ]);
      setAgents(Array.isArray(agentList) ? agentList.filter((a: any) => a.id !== user?.id) : []);
      setDepartments(Array.isArray(deptList) ? deptList : []);
      setTransferTab("agents");
      setShowTransfer(true);
    } catch (err) {
      console.error("Failed to load transfer options:", err);
    }
  }

  const isAssignedToMe = conversation?.assignedAgentId === user?.id;
  const isClosed = conversation?.status === "CLOSED";
  const canSend = isAssignedToMe && !isClosed;
  // Both agents (for their own chats) and admins can transfer
  const canTransfer = !isClosed && (isAssignedToMe || user?.role === "ADMIN");

  return (
    <div className="flex h-full w-full">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 shadow-sm">
          <button onClick={onBack} className="md:hidden text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={dir === "rtl" ? "M8.25 4.5l7.5 7.5-7.5 7.5" : "M15.75 19.5L8.25 12l7.5-7.5"} />
            </svg>
          </button>

          {/* Customer info with channel badge */}
          <div className="w-10 h-10 bg-gradient-to-br from-primary-100 to-primary-200 rounded-xl flex items-center justify-center shrink-0">
            <span className="text-sm font-bold text-primary-600">
              {(conversation?.customerName || conversation?.customerExternalId || conversation?.customerPhone || "?").charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <ChannelBadge channel={conversation?.channel} size="md" showLabel />
              <p className="font-semibold text-sm text-gray-900 truncate">
                {conversation?.customerName || conversation?.customerExternalId || conversation?.customerPhone || "..."}
              </p>
            </div>
            <p className="text-xs text-gray-400">{conversation?.customerExternalId || conversation?.customerPhone}</p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 md:gap-2 overflow-x-auto scrollbar-none">
            {!isClosed && !conversation?.assignedAgentId && (
              <ActionButton onClick={handleClaim} variant="primary">
                {t("conversations.claim")}
              </ActionButton>
            )}
            {isAssignedToMe && !isClosed && (
              <>
                <ActionButton onClick={handleRelease} variant="ghost">
                  <span className="hidden sm:inline">{t("conversations.release")}</span>
                  <svg className="w-3.5 h-3.5 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                </ActionButton>
                <ActionButton onClick={handleClose} variant="danger">
                  <span className="hidden sm:inline">{t("conversations.close")}</span>
                  <svg className="w-3.5 h-3.5 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </ActionButton>
              </>
            )}
            {canTransfer && (
              <ActionButton onClick={openTransferDialog} variant="secondary">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                </svg>
                <span className="hidden sm:inline">{t("conversations.transfer")}</span>
              </ActionButton>
            )}

            {/* History toggle */}
            <button
              onClick={() => { setHistoryOpen(!historyOpen); if (!historyOpen) setCopilotOpen(false); }}
              className={clsx(
                "flex items-center gap-1.5 text-xs px-2 md:px-3 py-1.5 rounded-lg font-medium transition shrink-0",
                historyOpen
                  ? "bg-gradient-to-r from-blue-500 to-cyan-600 text-white shadow-sm shadow-blue-500/25"
                  : "bg-gradient-to-r from-blue-50 to-cyan-50 text-blue-600 hover:from-blue-100 hover:to-cyan-100 border border-blue-200/50"
              )}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="hidden sm:inline">History</span>
            </button>

            {/* Co-Pilot toggle */}
            <button
              onClick={() => { setCopilotOpen(!copilotOpen); if (!copilotOpen) setHistoryOpen(false); }}
              className={clsx(
                "flex items-center gap-1.5 text-xs px-2 md:px-3 py-1.5 rounded-lg font-medium transition shrink-0",
                copilotOpen
                  ? "bg-gradient-to-r from-violet-500 to-purple-600 text-white shadow-sm shadow-purple-500/25"
                  : "bg-gradient-to-r from-violet-50 to-purple-50 text-purple-600 hover:from-violet-100 hover:to-purple-100 border border-purple-200/50"
              )}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
              </svg>
              <span className="hidden sm:inline">Co-Pilot</span>
            </button>
          </div>
        </div>

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto bg-[var(--bg-chat)] p-4 space-y-2">
          {messages.map((msg) =>
            msg.messageType === "system" ? (
              <SystemDivider key={msg.id} metadata={msg.metadata} timestamp={msg.createdAt} t={t} />
            ) : (
            <div
              key={msg.id}
              className={clsx(
                "flex",
                msg.direction === "OUTBOUND" ? "justify-end" : "justify-start"
              )}
            >
              <div
                className={clsx(
                  "max-w-[75%] px-4 py-2.5 text-sm",
                  msg.direction === "OUTBOUND"
                    ? "chat-bubble-outbound"
                    : "chat-bubble-inbound"
                )}
              >
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
                  {msg.direction === "OUTBOUND" && (
                    <MessageStatusIcon status={msg.status} />
                  )}
                </div>
              </div>
            </div>
            )
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        {canSend ? (
          <form onSubmit={handleSend} className="bg-white border-t border-gray-100 p-3 flex items-center gap-3">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={t("conversations.typeMessage")}
              className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
              disabled={sending}
            />
            <button
              type="submit"
              disabled={sending || !inputText.trim()}
              className="w-10 h-10 bg-primary-500 hover:bg-primary-600 text-white rounded-xl flex items-center justify-center transition disabled:opacity-40 shadow-sm"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d={dir === "rtl" ? "M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" : "M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"} />
              </svg>
            </button>
          </form>
        ) : isClosed ? (
          <div className="bg-gray-50 border-t border-gray-100 p-4 text-center text-sm text-gray-400">
            {t("conversations.filterClosed")}
          </div>
        ) : (
          <div className="bg-amber-50 border-t border-amber-100 p-4 text-center text-sm text-amber-600">
            {t("conversations.waitingForAgent")}
          </div>
        )}
      </div>

      {/* History Panel */}
      {historyOpen && (
        <HistoryPanel
          conversation={conversation}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {/* Co-Pilot Panel */}
      {copilotOpen && (
        <CoPilotPanel
          conversation={conversation}
          messages={messages}
          onInsertReply={(text) => setInputText(text)}
          onClose={() => setCopilotOpen(false)}
        />
      )}

      {/* Transfer dialog */}
      {showTransfer && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="font-bold text-gray-900 mb-1">{t("conversations.transfer")}</h3>
            <p className="text-xs text-gray-400 mb-3">Transfer this conversation to an agent or department</p>
            {/* Tabs */}
            <div className="flex border-b border-gray-100 mb-3">
              <button
                onClick={() => setTransferTab("agents")}
                className={clsx("flex-1 py-2 text-xs font-medium transition relative", transferTab === "agents" ? "text-primary-600" : "text-gray-400 hover:text-gray-600")}
              >
                {t("conversations.reassign")}
                {transferTab === "agents" && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary-500 rounded-full" />}
              </button>
              <button
                onClick={() => setTransferTab("departments")}
                className={clsx("flex-1 py-2 text-xs font-medium transition relative", transferTab === "departments" ? "text-primary-600" : "text-gray-400 hover:text-gray-600")}
              >
                {t("conversations.transferToDepartment")}
                {transferTab === "departments" && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary-500 rounded-full" />}
              </button>
            </div>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {transferTab === "agents" ? (
                <>
                  {agents.map((agent: any) => (
                    <button
                      key={agent.id}
                      onClick={() => handleTransfer(agent.id)}
                      disabled={!agent.isActive}
                      className="w-full text-start p-3 rounded-xl border border-gray-100 hover:bg-primary-50 hover:border-primary-200 transition disabled:opacity-40 disabled:hover:bg-white"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-primary-100 to-primary-200 rounded-lg flex items-center justify-center">
                          <span className="text-xs font-bold text-primary-600">{agent.name?.charAt(0).toUpperCase()}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-gray-900">{agent.name}</p>
                          <p className="text-xs text-gray-400">{agent.email}</p>
                        </div>
                        {agent._count?.conversations > 0 && (
                          <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                            {agent._count.conversations} chats
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                  {agents.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-4">{t("common.noResults")}</p>
                  )}
                </>
              ) : (
                <>
                  {departments.map((dept: any) => (
                    <button
                      key={dept.id}
                      onClick={() => handleTransferToDept(dept.id)}
                      className="w-full text-start p-3 rounded-xl border border-gray-100 hover:bg-teal-50 hover:border-teal-200 transition"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-teal-100 to-teal-200 rounded-lg flex items-center justify-center">
                          <svg className="w-4 h-4 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-gray-900">{dept.name}</p>
                          <p className="text-xs text-gray-400">{dept.queueMode === "ROUND_ROBIN" ? "Round Robin" : "Claim"} &middot; {dept._count?.members || 0} members</p>
                        </div>
                      </div>
                    </button>
                  ))}
                  {departments.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-4">{t("common.noResults")}</p>
                  )}
                </>
              )}
            </div>
            <button
              onClick={() => setShowTransfer(false)}
              className="w-full mt-4 py-2.5 text-sm text-gray-500 hover:text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-xl transition"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  variant,
  children,
}: {
  onClick: () => void;
  variant: "primary" | "secondary" | "ghost" | "danger";
  children: React.ReactNode;
}) {
  const styles = {
    primary: "bg-primary-500 text-white hover:bg-primary-600 shadow-sm",
    secondary: "bg-primary-50 text-primary-600 hover:bg-primary-100",
    ghost: "bg-gray-100 text-gray-700 hover:bg-gray-200 ring-1 ring-gray-300",
    danger: "bg-red-50 text-red-600 hover:bg-red-100 ring-1 ring-red-200",
  };
  return (
    <button
      onClick={onClick}
      className={clsx("text-xs px-3 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5", styles[variant])}
    >
      {children}
    </button>
  );
}

function SystemDivider({ metadata, timestamp, t }: { metadata: any; timestamp: string; t: (key: string, vars?: Record<string, string>) => string }) {
  const event = metadata?.systemEvent;
  let icon: React.ReactNode;
  let label: string;
  let colors: string;

  switch (event) {
    case "bot_handover":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      );
      label = t("conversations.systemBotHandover");
      colors = "bg-amber-50 text-amber-600 border-amber-200";
      break;
    case "agent_claimed":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
        </svg>
      );
      label = t("conversations.systemAgentClaimed", { agentName: metadata?.agentName || "Agent" });
      colors = "bg-green-50 text-green-600 border-green-200";
      break;
    case "agent_transferred":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      );
      label = t("conversations.systemAgentTransferred", { fromAgent: metadata?.fromAgentName || "Agent", toAgent: metadata?.toAgentName || "Agent" });
      colors = "bg-blue-50 text-blue-600 border-blue-200";
      break;
    case "department_route":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75" />
        </svg>
      );
      label = t("conversations.systemDepartmentRoute", { departmentName: metadata?.departmentName || "Department" });
      colors = "bg-teal-50 text-teal-600 border-teal-200";
      break;
    case "department_transferred":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75" />
        </svg>
      );
      label = t("conversations.systemDepartmentTransferred", { departmentName: metadata?.departmentName || "Department" });
      colors = "bg-teal-50 text-teal-600 border-teal-200";
      break;
    default:
      icon = null;
      label = event || "System event";
      colors = "bg-gray-50 text-gray-500 border-gray-200";
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-gray-200" />
      <div className={clsx("flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium border", colors)}>
        {icon}
        <span>{label}</span>
        <span className="opacity-50 ml-1">{format(new Date(timestamp), "HH:mm")}</span>
      </div>
      <div className="flex-1 h-px bg-gray-200" />
    </div>
  );
}

function MessageStatusIcon({ status }: { status: string }) {
  const color = status === "READ" ? "text-blue-400" : "opacity-40";
  const tooltips: Record<string, string> = {
    PENDING: "Sending...",
    SENT: "Sent",
    DELIVERED: "Delivered",
    READ: "Read",
    FAILED: "Failed to send",
  };
  if (status === "PENDING") return <span className="text-[10px] opacity-30" title={tooltips.PENDING}>&#9696;</span>;
  if (status === "FAILED") return <span className="text-[10px] text-red-400" title={tooltips.FAILED}>!</span>;
  return (
    <span title={tooltips[status]}>
      <svg className={clsx("w-3.5 h-3.5", color)} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        {status === "SENT" ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        ) : (
          <>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M1 13l4 4L15 7" />
          </>
        )}
      </svg>
    </span>
  );
}
