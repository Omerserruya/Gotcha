"use client";

import { useState, useEffect, useRef, useCallback, FormEvent, DragEvent, ChangeEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import ApprovalCard from "@/components/approvals/ApprovalCard";
import { useI18n } from "@/context/I18nContext";
import ConfirmModal from "@/components/ConfirmModal";
import {
  getConversation,
  sendMessage,
  sendMediaMessage,
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
import { CustomerAvatar } from "./CustomerAvatar";
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
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [topSuggestion, setTopSuggestion] = useState<{ text: string; label: string; confidence: number } | null>(null);
  const [popupDismissed, setPopupDismissed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const repliesRef = useRef<HTMLDivElement>(null);

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

  // Auto-open copilot when entering a conversation where last message is inbound
  const hasAutoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (messages.length > 0 && hasAutoOpenedRef.current !== conversationId) {
      hasAutoOpenedRef.current = conversationId;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.direction === "INBOUND") {
        setCopilotOpen(true);
      }
    }
  }, [messages, conversationId]);

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
    if ((!inputText.trim() && attachedFiles.length === 0) || !token || sending) return;

    setSending(true);
    try {
      // Send files first
      for (const file of attachedFiles) {
        const res = await sendMediaMessage(token, conversationId, file, inputText.trim() || undefined);
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.data.id)) return prev;
          return [...prev, res.data];
        });
      }

      // Send text only if no files or text remains
      if (attachedFiles.length === 0 && inputText.trim()) {
        const res = await sendMessage(token, conversationId, inputText.trim());
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.data.id)) return prev;
          return [...prev, res.data];
        });
      }

      setInputText("");
      setAttachedFiles([]);
    } catch (err) {
      console.error("Send failed:", err);
    } finally {
      setSending(false);
    }
  }

  function handleFilesSelected(files: FileList | null) {
    if (!files) return;
    const newFiles = Array.from(files).slice(0, 5); // max 5 files
    setAttachedFiles((prev) => [...prev, ...newFiles].slice(0, 5));
  }

  function removeAttachedFile(index: number) {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    handleFilesSelected(e.dataTransfer.files);
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

  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closeLoading, setCloseLoading] = useState(false);

  function handleClose() {
    setShowCloseConfirm(true);
  }

  async function confirmClose() {
    if (!token) return;
    setCloseLoading(true);
    try {
      await closeConversation(token, conversationId);
      setShowCloseConfirm(false);
      fetchConversation();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCloseLoading(false);
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
    <div className="flex h-full w-full bg-white">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-white px-2 md:px-4 py-2 md:py-3 flex items-center gap-2 md:gap-3 shadow-subtle">
          <button onClick={onBack} className="md:hidden text-gray-400 hover:text-gray-600 p-2 rounded-lg hover:bg-gray-100 transition min-w-[44px] min-h-[44px] flex items-center justify-center">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={dir === "rtl" ? "M8.25 4.5l7.5 7.5-7.5 7.5" : "M15.75 19.5L8.25 12l7.5-7.5"} />
            </svg>
          </button>

          {/* Customer info with channel badge */}
          <CustomerAvatar
            name={conversation?.customerName || conversation?.customerExternalId || conversation?.customerPhone}
            avatarUrl={conversation?.customerAvatarUrl}
            channel={conversation?.channel}
            size="md"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 md:gap-2">
              <p className="font-semibold text-xs md:text-sm text-gray-900 truncate">
                {conversation?.customerName || conversation?.customerExternalId || conversation?.customerPhone || "..."}
              </p>
            </div>
            <p className="text-[10px] md:text-xs text-gray-400 truncate">{conversation?.customerExternalId || conversation?.customerPhone}</p>
          </div>

          {/* Actions */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            {/* Top row: Agent name (full width of bottom row) */}
            {!isClosed && (
              <button
                onClick={() => {
                  if (!conversation?.assignedAgentId) {
                    handleClaim();
                  } else {
                    openTransferDialog();
                  }
                }}
                className="w-full flex items-center justify-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition bg-gray-50 text-gray-600 hover:bg-gray-100"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
                <span>
                  {conversation?.assignedAgent?.name || (conversation?.assignedAgentId ? "Agent" : t("conversations.claim"))}
                </span>
                {conversation?.assignedAgentId && (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                )}
              </button>
            )}

            {/* Bottom row: Close, History, Co-Pilot */}
            <div className="flex items-center gap-1.5">
              {isAssignedToMe && !isClosed && (
                <ActionButton onClick={handleClose} variant="danger">
                  {t("conversations.close")}
                </ActionButton>
              )}

              <button
                onClick={() => { setHistoryOpen(!historyOpen); if (!historyOpen) setCopilotOpen(false); }}
                className={clsx(
                  "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition shrink-0",
                  historyOpen
                    ? "bg-primary-500 text-white shadow-sm"
                    : "bg-gray-50 text-gray-500 hover:bg-gray-100"
                )}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="hidden sm:inline">History</span>
              </button>

              <button
                onClick={() => { setCopilotOpen(!copilotOpen); if (!copilotOpen) setHistoryOpen(false); }}
                className={clsx(
                  "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition shrink-0",
                  copilotOpen
                    ? "bg-purple-500 text-white shadow-sm"
                    : "bg-purple-50 text-purple-500 hover:bg-purple-100"
                )}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                </svg>
                <span className="hidden sm:inline">Co-Pilot</span>
              </button>
            </div>
          </div>
        </div>

        {/* Messages area */}
        <div
          className={clsx("flex-1 overflow-y-auto bg-[var(--bg-chat)] p-4 space-y-2 relative", isDragging && "ring-2 ring-inset ring-primary-400 bg-primary-50/30")}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="absolute inset-0 flex items-center justify-center bg-primary-50/60 z-10 pointer-events-none rounded-lg">
              <div className="flex flex-col items-center gap-2 text-primary-600">
                <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <span className="text-sm font-medium">Drop files here</span>
              </div>
            </div>
          )}
          {/* F4: in-conversation approval card — shown when the bot
              hit a REQUIRE_APPROVAL tool and paused waiting for a
              human. Polls /api/approvals itself. */}
          {token && <ApprovalCard token={token} conversationId={conversationId} />}
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
                  "max-w-[85%] md:max-w-[75%] px-3 md:px-4 py-2 md:py-2.5 text-sm",
                  msg.direction === "OUTBOUND"
                    ? "chat-bubble-outbound"
                    : "chat-bubble-inbound"
                )}
              >
                {msg.senderName && msg.direction === "OUTBOUND" && (
                  <p className="text-[10px] opacity-70 mb-0.5 font-medium">{msg.senderName}</p>
                )}
                {msg.mediaUrl && (msg.messageType === "image" || msg.mediaUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) ? (
                  <img src={msg.mediaUrl} alt="" className="max-w-full rounded-lg mb-1 cursor-pointer" onClick={() => window.open(msg.mediaUrl, "_blank")} />
                ) : msg.mediaUrl && (msg.messageType === "video" || msg.mediaUrl.match(/\.(mp4|webm|mov)$/i)) ? (
                  <video src={msg.mediaUrl} controls className="max-w-full rounded-lg mb-1" />
                ) : msg.mediaUrl ? (
                  <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 bg-white/20 rounded-lg mb-1 hover:bg-white/30 transition">
                    <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    <span className="text-xs truncate">{msg.fileName || "Download file"}</span>
                  </a>
                ) : null}
                {msg.body && <p className="whitespace-pre-wrap break-words">{msg.body}</p>}
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
          <div className="px-2 md:px-4 pb-3 md:pb-4 pt-2 bg-[var(--bg-chat)] relative">
            {/* Smart AI Suggestion Popup — floating overlay */}
            {copilotOpen && topSuggestion && topSuggestion.confidence > 85 && !popupDismissed && (
              <div className="absolute bottom-full left-4 right-4 md:right-auto md:left-4 md:w-[420px] mb-2 z-20 animate-fade-in-up">
                <div className="rounded-2xl p-[1px] bg-gradient-to-br from-violet-500/20 via-purple-500/15 to-indigo-500/20 shadow-2xl shadow-violet-300/30">
                  <div className="rounded-[15px] bg-white/5 backdrop-blur-xl border border-white/10 px-3.5 py-3">
                    {/* Header: title + All Suggestions */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
                          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                          </svg>
                        </div>
                        <span className="text-[11px] font-bold text-violet-700 uppercase tracking-wider">AI Recommendation</span>
                      </div>
                      <button
                        onClick={() => {
                          if (!copilotOpen) setCopilotOpen(true);
                          setTimeout(() => repliesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                        }}
                        className="text-[10px] font-medium text-violet-400 hover:text-violet-600 transition"
                      >
                        All suggestions
                      </button>
                    </div>

                    {/* Suggestion body */}
                    <p className="text-[12.5px] text-gray-700 leading-relaxed mb-3">{topSuggestion.text}</p>

                    {/* Footer: dismiss + apply */}
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => setPopupDismissed(true)}
                        className="text-[10px] font-medium text-gray-400 hover:text-gray-600 transition"
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => { setInputText(topSuggestion.text); setPopupDismissed(true); }}
                        className="px-3.5 py-1.5 text-[11px] font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 rounded-lg hover:from-violet-600 hover:to-purple-700 transition-all shadow-sm shadow-violet-300/40"
                      >
                        Apply to input
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {/* File preview strip */}
            {attachedFiles.length > 0 && (
              <div className="flex gap-2 mb-2 overflow-x-auto pt-2 pb-1">
                {attachedFiles.map((file, i) => (
                  <div key={i} className="relative shrink-0 group">
                    {file.type.startsWith("image/") ? (
                      <img
                        src={URL.createObjectURL(file)}
                        alt={file.name}
                        className="w-16 h-16 object-cover rounded-xl ring-1 ring-gray-200"
                      />
                    ) : (
                      <div className="w-16 h-16 flex flex-col items-center justify-center rounded-xl bg-gray-100 ring-1 ring-gray-200 px-1">
                        <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        <span className="text-[9px] text-gray-500 truncate w-full text-center mt-0.5">{file.name.split(".").pop()}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAttachedFile(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition shadow"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className={clsx("rounded-2xl transition-all relative", aiGenerating ? "p-[2px] ai-border-glow" : "p-0")}>
            <form onSubmit={handleSend} className={clsx("flex items-center gap-2 bg-white rounded-2xl shadow-lg shadow-gray-200/50 px-3 py-1.5 transition", aiGenerating ? "" : "ring-1 ring-gray-200/80 focus-within:ring-2 focus-within:ring-primary-300")}>
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar"
                className="hidden"
                onChange={(e: ChangeEvent<HTMLInputElement>) => { handleFilesSelected(e.target.files); e.target.value = ""; }}
              />

              {/* Attachment button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition flex-shrink-0"
                title={t("conversations.attach") || "Attach"}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>

              {/* Text input */}
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={attachedFiles.length > 0 ? "Add a caption..." : t("conversations.typeMessage")}
                className="flex-1 py-2 bg-transparent border-0 text-base md:text-sm outline-none placeholder:text-gray-400"
                disabled={sending}
              />

              {/* Send button */}
              <button
                type="submit"
                disabled={sending || (!inputText.trim() && attachedFiles.length === 0)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-primary-500 hover:bg-primary-600 text-white transition disabled:opacity-30 flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={dir === "rtl" ? "M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" : "M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"} />
                </svg>
              </button>
            </form>
            </div>
          </div>
        ) : isClosed ? (
          <div className="bg-gray-50 shadow-[0_-1px_3px_rgba(0,0,0,0.04)] p-4 text-center text-sm text-gray-400">
            {t("conversations.filterClosed")}
          </div>
        ) : (
          <div className="bg-amber-50 shadow-[0_-1px_3px_rgba(0,0,0,0.04)] p-4 text-center text-sm text-amber-600">
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
          onAiLoadingChange={setAiGenerating}
          onTopSuggestion={(s) => { setTopSuggestion((prev) => { if (s?.text !== prev?.text) setPopupDismissed(false); return s; }); }}
          repliesRef={repliesRef}
        />
      )}

      {/* Close confirmation modal */}
      <ConfirmModal
        isOpen={showCloseConfirm}
        title={t("conversations.closeConfirmTitle")}
        message={t("conversations.closeConfirmMessage")}
        confirmText={t("conversations.closeConfirmButton")}
        danger
        loading={closeLoading}
        onConfirm={confirmClose}
        onCancel={() => setShowCloseConfirm(false)}
      />

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
                      className="w-full text-start p-3 rounded-xl bg-gray-50/50 hover:bg-primary-50/50 transition disabled:opacity-40 disabled:hover:bg-gray-50/50"
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
                      className="w-full text-start p-3 rounded-xl bg-gray-50/50 hover:bg-primary-50/50 transition"
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
    ghost: "bg-gray-100 text-gray-700 hover:bg-gray-200",
    danger: "bg-red-50 text-red-600 hover:bg-red-100",
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
      colors = "bg-amber-50 text-amber-600";
      break;
    case "agent_claimed":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
        </svg>
      );
      label = t("conversations.systemAgentClaimed", { agentName: metadata?.agentName || "Agent" });
      colors = "bg-green-50 text-green-600";
      break;
    case "agent_transferred":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      );
      label = t("conversations.systemAgentTransferred", { fromAgent: metadata?.fromAgentName || "Agent", toAgent: metadata?.toAgentName || "Agent" });
      colors = "bg-blue-50 text-blue-600";
      break;
    case "department_route":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75" />
        </svg>
      );
      label = t("conversations.systemDepartmentRoute", { departmentName: metadata?.departmentName || "Department" });
      colors = "bg-teal-50 text-teal-600";
      break;
    case "department_transferred":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75" />
        </svg>
      );
      label = t("conversations.systemDepartmentTransferred", { departmentName: metadata?.departmentName || "Department" });
      colors = "bg-teal-50 text-teal-600";
      break;
    default:
      icon = null;
      label = event || "System event";
      colors = "bg-gray-50 text-gray-500";
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-gray-200" />
      <div className={clsx("flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium", colors)}>
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
