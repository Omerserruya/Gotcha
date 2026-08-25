"use client";

import { renderMessageText } from "@/lib/whatsapp-text";
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
  returnConversationToAi,
  closeConversation,
  reassignConversation,
  getAgents,
  getAIAgent,
  getDepartments,
  transferToDepartment,
} from "@/lib/api";
import { getSocket } from "@/lib/socket";
import { format } from "date-fns";
import clsx from "clsx";
import { ChannelBadge } from "./ChannelBadge";
import { CustomerAvatar } from "./CustomerAvatar";
import { CoPilotPanel } from "./CoPilotPanel";
import { isAiManaged, isFlowManaged } from "@/lib/conversation-ownership";
import { HistoryPanel } from "./HistoryPanel";
import { CampaignBadge } from "./CampaignBadge";
import { DecisionTimelinePanel } from "./DecisionTimelinePanel";
import { MessageSignals } from "./MessageSignals";
import { AIComposeScope, AIComposeTrigger, AIComposePanel } from "@/components/ai/AIComposeInline";
import { VoiceCallButton } from "@/components/voice/VoiceCallButton";
import { ProductCard, ProductCarousel, type ProductView } from "@/components/shopify/ProductCard";
import { ProductPicker } from "@/components/shopify/ProductPicker";
import { StorefrontContextStrip } from "@/components/shopify/StorefrontContextStrip";
import { fetchCrmContext, syncCloseToCrm, type CrmContextEnvelope } from "@/lib/api-crm";

const SHOPIFY_COMMERCE_TYPES = ["shopify_product", "shopify_product_carousel"];

/**
 * Pull the commerce payload off a message, if it has one.
 *
 * The snapshot the server persisted is what we render, exactly as the
 * shopper sees it. There is no second fetch here on purpose: an agent
 * scrolling back through a conversation should see the card as it was
 * SENT, not a silently re-priced version of it.
 */
function commerceOf(message: any): { products: ProductView[] } | null {
  if (!message || !SHOPIFY_COMMERCE_TYPES.includes(message.messageType)) return null;
  const payload = message.metadata?.shopify;
  if (!payload || payload.kind !== "shopify_commerce") return null;
  const products = Array.isArray(payload.products) ? payload.products : [];
  if (!products.length) return null;
  return {
    products: products.map((p: any) => ({
      productId: p.productId,
      handle: p.handle,
      title: p.title,
      imageUrl: p.imageUrl,
      productUrl: p.productUrl,
      currency: p.currency,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      available: p.available,
      published: p.status === "active",
      status: p.status,
      vendor: p.vendor,
      selectedVariantId: p.selectedVariantId,
      optionNames: p.optionNames || [],
      variants: p.variants || [],
      reason: p.reason,
    })),
  };
}

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
  /**
   * The message the agent is replying to.
   *
   * Held here rather than on the bubble so there is exactly one at a time and
   * the composer can show it: a reply target that is only visible on the
   * message you scrolled away from is a reply target you forget you set.
   */
  const [replyTo, setReplyTo] = useState<any | null>(null);
  /**
   * Email only: continue the customer's thread, or deliberately start a new one.
   *
   * Defaults to replying because that is what answering an email means. The
   * alternative exists for the real case it serves - raising a separate matter
   * with the same customer - and not as a coin flip the agent has to make on
   * every message.
   */
  const [emailMode, setEmailMode] = useState<"reply" | "new">("reply");
  const [emailSubject, setEmailSubject] = useState("");
  /** Mail channels: the only ones where a send has a thread and a subject. */
  const isEmailConversation =
    conversation?.channel === "GMAIL" ||
    conversation?.channel === "OUTLOOK" ||
    conversation?.channel === "EMAIL";
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTab, setTransferTab] = useState<"agents" | "departments">("agents");
  const [agents, setAgents] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // CRM context is fetched once at the chat level and fed to both the Co-Pilot
  // (identity / deals / tickets / open issues) and the Context panel (activity
  // / CRM notes / recent summaries). The old standalone CRM panel was removed
  // - one less button, no surface duplication.
  const [crmContext, setCrmContext] = useState<CrmContextEnvelope | null>(null);
  const [crmLoading, setCrmLoading] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [topSuggestion, setTopSuggestion] = useState<{ text: string; label: string; confidence: number } | null>(null);
  const [popupDismissed, setPopupDismissed] = useState(false);
  // Mark text inside a customer message → floating "Ask Co-Pilot" action.
  // Anchor is in viewport coordinates so the bubble follows the page on scroll
  // (we clear the selection on scroll anyway, so this is good enough).
  const [askSelection, setAskSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  // When the agent clicks "Ask Co-Pilot", we forward the quoted text to the
  // CoPilot panel as a prefill. The panel switches to its chat tab and seeds
  // the composer with a quoted block - the agent types their question and hits
  // send. Versioned so the same quote can be re-sent if the agent clicks twice.
  const [askPrefill, setAskPrefill] = useState<{ quote: string; version: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  /** Briefly highlighted after jumping to it, so the eye lands on the right one. */
  const [flashedMessageId, setFlashedMessageId] = useState<string | null>(null);

  /**
   * Scroll to the message a reply is quoting.
   *
   * The scroll alone is not enough: in a dense thread it lands the reader
   * somewhere plausible with no idea which line they were sent to, so the
   * target flashes for a moment. The flash is time-boxed rather than cleared on
   * the next click, because the reader may simply scroll away and a permanently
   * highlighted message would look like a selection they cannot dismiss.
   *
   * A quoted message can legitimately be outside the loaded page - somebody
   * replying to something from weeks ago. Nothing happens then, which is the
   * honest outcome; jumping to the wrong place would be worse.
   */
  const jumpToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashedMessageId(messageId);
    window.setTimeout(() => setFlashedMessageId((cur) => (cur === messageId ? null : cur)), 1600);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const repliesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Enter sends, Shift+Enter breaks the line.
   *
   * `isComposing` is the load-bearing part and the reason this is not a
   * one-liner. While an IME candidate window is open - Chinese, Japanese,
   * Korean, and some Hebrew/Arabic input methods - Enter CONFIRMS the
   * candidate. Sending on it would fire the message mid-word, every time,
   * for those users only.
   */
  const handleComposerKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.nativeEvent.isComposing || (e as any).keyCode === 229) return;
    e.preventDefault();
    // Reuse the form's own submit path so attachments, the AI-managed claim
    // and the sending guard all behave identically to the button.
    void handleSend(e as unknown as FormEvent);
  }, [handleSend]);

  // Grow with the message, then scroll. Measured from `scrollHeight`, which
  // needs the height reset first or the box can only ever get taller - it
  // would never shrink back after the text is sent or deleted.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [inputText]);

  // Notify AppLayout to auto-collapse sidebar when panels open
  useEffect(() => {
    const anyPanelOpen = copilotOpen || historyOpen || timelineOpen;
    window.dispatchEvent(new CustomEvent("panel:toggle", { detail: { open: anyPanelOpen } }));
    return () => {
      // Restore sidebar when ChatPanel unmounts
      window.dispatchEvent(new CustomEvent("panel:toggle", { detail: { open: false } }));
    };
  }, [copilotOpen, historyOpen, timelineOpen]);

  // Selection inside a customer message → show floating "Ask Co-Pilot" bubble.
  // We only react to selections initiated on the inbound message itself (the
  // <p onMouseUp> handler wires this), so selections in agent replies, headers,
  // or the input area are ignored.
  const handleMessageMouseUp = useCallback(() => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    const text = sel?.toString().trim() ?? "";
    if (!sel || !text || sel.rangeCount === 0) {
      setAskSelection(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setAskSelection(null);
      return;
    }
    // Anchor centered above the selection so the bubble sits directly over
    // the marked text. The consumer renders with `transform: translateX(-50%)`
    // and clamps the X back inside the viewport with `max(...)` so a selection
    // near the screen edge doesn't push the bubble off-screen.
    setAskSelection({
      text,
      x: rect.left + rect.width / 2,
      y: Math.max(8, rect.top - 40),
    });
  }, []);

  // Clear the floating bubble on outside-click, escape, scroll, or any new
  // selection event that produced no text (collapsed click).
  useEffect(() => {
    if (!askSelection) return;
    const dismiss = () => setAskSelection(null);
    const onSelectionChange = () => {
      const txt = window.getSelection()?.toString().trim() ?? "";
      if (!txt) setAskSelection(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAskSelection(null); };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [askSelection]);

  // Single CRM context fetch shared by Co-Pilot (identity/deals/tickets/issues)
  // and Context panel (activity/notes/summaries). Refetches on conversation
  // change. Failures are silent - both panels gracefully show conversation-only
  // data when CRM isn't connected.
  const refetchCrm = useCallback(async () => {
    if (!token || !conversationId) return;
    setCrmLoading(true);
    try {
      const data = await fetchCrmContext(token, conversationId);
      setCrmContext(data);
    } catch {
      setCrmContext(null);
    } finally {
      setCrmLoading(false);
    }
  }, [token, conversationId]);

  useEffect(() => {
    setCrmContext(null);
    refetchCrm();
  }, [refetchCrm]);

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

  // Is an AI employee (or a flow) driving this conversation right now?
  // Same predicate the inbox list files rows by, so the section a conversation
  // sits in and the behaviour of opening it can never disagree.
  const aiManaged = isAiManaged(conversation);

  // Auto-open copilot when entering a conversation where last message is inbound.
  // Mobile constraint: the panel is `fixed inset-0` and takes the whole screen,
  // so auto-opening hides the chat. Only auto-open on desktop (md+). On mobile
  // the AI still runs in the background and surfaces via the floating suggestion
  // bubble above the input - the agent taps it to expand the full panel.
  //
  // NEVER on an AI-managed conversation. The trigger is "last message is
  // inbound", which is precisely the state an AI-handled thread sits in for the
  // seconds before the employee answers - so opening one to see what the AI is
  // doing would greet you with a co-pilot drafting a reply nobody asked you to
  // send, over a reply already on its way. Reading along must stay read-only.
  const hasAutoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (messages.length > 0 && hasAutoOpenedRef.current !== conversationId) {
      hasAutoOpenedRef.current = conversationId;
      if (aiManaged) return;
      const lastMsg = messages[messages.length - 1];
      const isDesktop = typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
      if (lastMsg?.direction === "INBOUND" && isDesktop) {
        setCopilotOpen(true);
      }
    }
  }, [messages, conversationId, aiManaged]);

  // Taking over mid-thread must also close a co-pilot the agent opened by hand
  // BEFORE the AI took the conversation back (returnToAi), which would
  // otherwise keep drafting against a thread that is no longer theirs.
  useEffect(() => {
    if (aiManaged) setCopilotOpen(false);
  }, [aiManaged]);

  // Which employee is answering. Fetched only when the banner will actually
  // show it - Conversation carries `assignedAiAgentId` but has no AI-agent
  // relation, and a schema migration for one label is not worth it.
  const [aiAgentName, setAiAgentName] = useState<string | null>(null);
  useEffect(() => {
    const agentId = conversation?.assignedAiAgentId;
    if (!token || !aiManaged || !agentId) { setAiAgentName(null); return; }
    let cancelled = false;
    getAIAgent(token, agentId)
      .then((res) => { if (!cancelled) setAiAgentName(res.data?.name ?? null); })
      .catch(() => { if (!cancelled) setAiAgentName(null); });
    return () => { cancelled = true; };
  }, [token, aiManaged, conversation?.assignedAiAgentId]);

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
            m.id === data.messageId
              ? {
                  ...m,
                  status: data.status,
                  // Carry the failure reason so a FAILED message can be
                  // diagnosed live from the Inbox, not just after a reload.
                  ...(data.error ? { errorMessage: data.error } : {}),
                  ...(data.sendError
                    ? { metadata: { ...(m.metadata ?? {}), sendError: data.sendError } }
                    : {}),
                }
              : m
          )
        );
      }
    };

    const handleConversationUpdate = (data: any) => {
      if (data.id === conversationId) {
        setConversation((prev: any) => ({ ...prev, ...data }));
      }
    };

    // Copilot annotation event - used to drop intent-signal chips under a
    // customer message after the suggestion call finishes analysing it.
    const handleMessageUpdate = (data: any) => {
      if (data.conversationId !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === data.messageId ? { ...m, ...data.patch, metadata: { ...(m.metadata ?? {}), ...(data.patch?.metadata ?? {}) } } : m,
        ),
      );
    };

    socket.on("message:new", handleNewMessage);
    socket.on("message:status", handleStatusUpdate);
    socket.on("message:updated", handleMessageUpdate);
    socket.on("conversation:updated", handleConversationUpdate);

    return () => {
      socket.off("message:new", handleNewMessage);
      socket.off("message:status", handleStatusUpdate);
      socket.off("message:updated", handleMessageUpdate);
      socket.off("conversation:updated", handleConversationUpdate);
    };
  }, [conversationId]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if ((!inputText.trim() && attachedFiles.length === 0) || !token || sending) return;

    setSending(true);
    try {
      // Typing a reply into a conversation the AI owns IS the takeover, so
      // claim before sending. Without this the agent's message goes out
      // alongside whatever the employee was already composing, and the
      // customer gets two answers from one business.
      //
      // Claim first, send second: a failed claim must not produce a sent
      // message in a thread the AI still believes is its own.
      if (isAiManaged(conversation)) {
        await claimConversation(token, conversationId);
        await fetchConversation();
      }

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
        const res = await sendMessage(
          token,
          conversationId,
          inputText.trim(),
          replyTo?.id,
          isEmailConversation ? { mode: emailMode, subject: emailSubject.trim() || undefined } : undefined,
        );
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.data.id)) return prev;
          return [...prev, res.data];
        });
      }

      // Cleared on success only. A failed send keeps the quote, because
      // re-selecting the right message out of a long thread is exactly the
      // fiddly step the agent would have to repeat.
      setReplyTo(null);
      setInputText("");
      setAttachedFiles([]);
      // Back to replying. Starting a new thread is a per-message decision, not
      // a mode the agent gets stuck in without noticing.
      setEmailMode("reply");
      setEmailSubject("");
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

  async function handleReturnToAi() {
    if (!token) return;
    try {
      await returnConversationToAi(token, conversationId);
      fetchConversation();
    } catch (err: any) {
      alert(err.message);
    }
  }

  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
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
      // Best-effort CRM sync - summary + engagement projected to the linked
      // CRM contact. Failures must NOT block close.
      syncCloseToCrm(token, conversationId).catch((err) => {
        console.warn("[ChatPanel] CRM close-sync failed:", err?.message || err);
      });
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
            {/* Where this lead came from. Directly under the phone number
                because "who is this" and "how did they get here" are the same
                question for an agent opening a chat. */}
            <CampaignBadge conversation={conversation} t={t} />
          </div>

          {/* Actions */}
          <div className="flex flex-col items-end gap-1 shrink-0" data-tour="chat-actions">
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
              {/* Hand the conversation back to the AI employee - shown when a
                  human owns it (handed over / assigned) and an AI employee is
                  bound. This is the only exit from the one-way handover latch. */}
              {!isClosed && conversation?.assignedAiAgentId && (conversation?.isHandedOver || conversation?.assignedAgentId) && (
                <button
                  onClick={handleReturnToAi}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition shrink-0 bg-violet-50 text-violet-600 hover:bg-violet-100"
                  title={t("conversations.returnToAiTitle")}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  <span className="hidden sm:inline">{t("conversations.returnToAi")}</span>
                </button>
              )}
              {isAssignedToMe && !isClosed && (
                <ActionButton onClick={handleClose} variant="danger">
                  {t("conversations.close")}
                </ActionButton>
              )}

              <VoiceCallButton
                to={conversation?.customerPhone || conversation?.customerExternalId}
                contactName={conversation?.customerName}
                conversationId={conversation?.id}
              />


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
                <span className="hidden sm:inline">{t("conversations.historyButton")}</span>
              </button>

              <button
                data-tour="chat-copilot-toggle"
                onClick={() => { setCopilotOpen(!copilotOpen); if (!copilotOpen) { setHistoryOpen(false); setTimelineOpen(false); } }}
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
                <span className="hidden sm:inline">{t("conversations.copilotButton")}</span>
              </button>

              {/* Decision Timeline (P1-5) - admin-only "why did the AI do that?" trace. */}
              {user?.role === "ADMIN" && (
                <button
                  onClick={() => { setTimelineOpen(!timelineOpen); if (!timelineOpen) { setHistoryOpen(false); setCopilotOpen(false); } }}
                  className={clsx(
                    "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition shrink-0",
                    timelineOpen
                      ? "bg-slate-700 text-white shadow-sm"
                      : "bg-slate-50 text-slate-500 hover:bg-slate-100"
                  )}
                  title={t("conversations.decisionTimeline.title")}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                  </svg>
                  <span className="hidden sm:inline">{t("conversations.decisionTimeline.button")}</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Reading along on a conversation an AI employee owns.
            States who is answering and why the co-pilot is not here, because
            an agent who opens one of these and finds the panel missing will
            otherwise read it as the co-pilot being broken. */}
        {aiManaged && (
          <div className="flex items-center gap-2.5 px-4 py-2 bg-purple-50/70 border-b border-purple-100">
            <svg className="w-4 h-4 text-purple-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-purple-700 truncate">
                {isFlowManaged(conversation)
                  ? t("conversations.aiWatchingBannerFlow")
                  : t("conversations.aiWatchingBanner", {
                      name: aiAgentName || t("conversations.aiHandledByAgent"),
                    })}
              </p>
              <p className="text-[11px] text-purple-500/80 leading-snug hidden sm:block">
                {t("conversations.aiWatchingBannerDesc")}
              </p>
            </div>
            <button
              onClick={handleClaim}
              className="text-xs px-2.5 py-1 rounded-lg font-medium bg-white text-purple-600 ring-1 ring-purple-200 hover:bg-purple-100 transition shrink-0"
            >
              {t("conversations.aiWatchingTakeOver")}
            </button>
          </div>
        )}

        {/* Where the shopper is standing right now, for Shopify chats */}
        <StorefrontContextStrip
          channel={conversation?.channel}
          messages={messages}
          // The channel's display name is the store label the merchant
          // chose. Reading the raw platformMeta blob here would drag the
          // whole install config into the inbox payload for one string.
          shopDomain={conversation?.channelAccount?.displayName ?? null}
        />

        {/* Messages area */}
        <div
          className={clsx("flex-1 overflow-y-auto bg-[var(--bg-chat)] p-4 space-y-1 relative", isDragging && "ring-2 ring-inset ring-primary-400 bg-primary-50/30")}
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
                <span className="text-sm font-medium">{t("conversations.dropFilesHere")}</span>
              </div>
            </div>
          )}
          {/* F4: in-conversation approval card - shown when the bot
              hit a REQUIRE_APPROVAL tool and paused waiting for a
              human. Polls /api/approvals itself. */}
          {token && <ApprovalCard token={token} conversationId={conversationId} />}
          {messages.map((msg) =>
            msg.messageType === "system" ? (
              <SystemDivider key={msg.id} metadata={msg.metadata} timestamp={msg.createdAt} t={t} />
            ) : commerceOf(msg) ? (
              // Commerce messages render as the card itself, not as a
              // chat bubble around a URL. An agent needs to see what the
              // customer saw to answer the next question about it.
              <div key={msg.id} className="flex flex-col items-end">
                <p className="text-[10px] text-gray-400 mb-0.5 pe-1">
                  {msg.senderName || t("shopifyChat.productMessageLabel")}
                </p>
                <div className="max-w-[85%] md:max-w-[75%]">
                  {commerceOf(msg)!.products.length > 1 ? (
                    <ProductCarousel products={commerceOf(msg)!.products} />
                  ) : (
                    <ProductCard product={commerceOf(msg)!.products[0]} />
                  )}
                </div>
                <span className="text-[10px] text-gray-400 mt-1">
                  {format(new Date(msg.createdAt), "HH:mm")}
                </span>
              </div>
            ) : (
            <div
              key={msg.id}
              className={clsx(
                "flex flex-col",
                msg.direction === "OUTBOUND" ? "items-end" : "items-start"
              )}
            >
              <div
                id={`msg-${msg.id}`}
                className={clsx(
                  "group/msg flex items-center gap-1 max-w-[85%] md:max-w-[75%] rounded-2xl transition-shadow duration-500",
                  flashedMessageId === msg.id && "ring-2 ring-primary-400 ring-offset-2",
                )}
              >
              {/*
                Reply.

                Revealed on hover rather than always drawn: it sits on every
                bubble in a thread that can be thousands long, and a permanent
                icon on each one turns the transcript into a wall of controls.
                On touch there is no hover, so it stays visible below md.
              */}
              {msg.direction === "OUTBOUND" && (
                <button
                  type="button"
                  onClick={() => setReplyTo(msg)}
                  className="order-first shrink-0 rounded-full p-1 text-gray-300 opacity-100 transition hover:bg-gray-100 hover:text-gray-600 md:opacity-0 md:group-hover/msg:opacity-100"
                  aria-label={t("conversations.reply.action")}
                  title={t("conversations.reply.action")}
                >
                  <svg className="h-3.5 w-3.5 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                </button>
              )}
              <div
                className={clsx(
                  "min-w-0 px-2.5 py-1 md:py-1.5 text-sm",
                  msg.direction === "OUTBOUND"
                    ? "chat-bubble-outbound"
                    : "chat-bubble-inbound"
                )}
              >
                {msg.senderName && msg.direction === "OUTBOUND" && (
                  <p className="text-[10px] opacity-70 mb-0.5 font-medium flex items-center gap-1">
                    {msg.senderName}
                    {msg.metadata?.source === "ai_bot" && (
                      <span
                        className="text-[8px] font-bold uppercase tracking-wider px-1 py-px rounded bg-white/25 ring-1 ring-white/30"
                        title={t("conversations.aiBadgeTitle")}
                      >
                        AI
                      </span>
                    )}
                  </p>
                )}
                {/*
                  What this message is replying to.

                  Shown for BOTH directions: a customer's "yes, that one" is
                  unreadable without it, and an agent needs to see which of
                  their own messages they quoted. `replyTo` is included by the
                  API with the message, because the quoted message is very
                  often outside the page being rendered.
                */}
                {(msg.replyTo || msg.replyToMessageId || msg.replyToExternalId) && (
                  <QuotedMessage
                    // Two sources, because they cover different moments. The
                    // API includes `replyTo` on the page it returns, but a
                    // message that has just arrived over the socket carries
                    // only the id - which is why every live reply read as "an
                    // earlier message" until the page was reloaded. The thread
                    // is already in state, so resolve from there first.
                    quoted={msg.replyTo || messages.find((m: any) => m.id === msg.replyToMessageId) || null}
                    onJump={msg.replyToMessageId ? () => jumpToMessage(msg.replyToMessageId) : undefined}
                    t={t}
                  />
                )}
                {msg.messageType === "contact" && msg.metadata?.contacts && (
                  <ContactCard contacts={msg.metadata.contacts} t={t} />
                )}
                <MessageMedia msg={msg} t={t} />
                {msg.body && !isRedundantMediaCaption(msg) && (
                  <p
                    className="whitespace-pre-wrap break-words"
                    onMouseUp={msg.direction === "INBOUND" ? handleMessageMouseUp : undefined}
                  >
                    {/*
                      WhatsApp senders write *bold*, _italic_, ~strike~ and
                      ```mono```, and Meta's own onboarding messages are full of
                      it. Printing the raw characters made every one of those
                      look broken, and left links as dead text to copy by hand.
                      renderMessageText builds NODES - a message body is written
                      by whoever messages the business, so it never becomes
                      markup.
                    */}
                    {renderMessageText(msg.body)}
                  </p>
                )}
                <div className={clsx(
                  "flex items-center gap-1 mt-1",
                  msg.direction === "OUTBOUND" ? "justify-end" : "justify-start"
                )}>
                  <span className="text-[10px] opacity-50">
                    {format(new Date(msg.createdAt), "HH:mm")}
                  </span>
                  {msg.direction === "OUTBOUND" && (
                    <MessageStatusIcon status={msg.status} t={t} />
                  )}
                </div>
                {msg.direction === "OUTBOUND" && msg.status === "FAILED" && (
                  <MessageFailureDetail
                    errorMessage={msg.errorMessage}
                    sendError={msg.metadata?.sendError}
                    t={t}
                  />
                )}
              </div>
              {/* The inbound side's reply button, mirrored to the far edge. */}
              {msg.direction === "INBOUND" && (
                <button
                  type="button"
                  onClick={() => setReplyTo(msg)}
                  className="shrink-0 rounded-full p-1 text-gray-300 opacity-100 transition hover:bg-gray-100 hover:text-gray-600 md:opacity-0 md:group-hover/msg:opacity-100"
                  aria-label={t("conversations.reply.action")}
                  title={t("conversations.reply.action")}
                >
                  <svg className="h-3.5 w-3.5 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                </button>
              )}
              </div>
              {msg.direction === "INBOUND" && (
                <MessageSignals signals={msg.metadata?.signals} />
              )}
            </div>
            )
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        {canSend ? (
          <div className="px-2 md:px-4 pb-3 md:pb-4 pt-2 bg-[var(--bg-chat)] relative">
            {/* Smart AI Suggestion Popup - floating overlay.
                Shown whenever co-pilot has a high-confidence suggestion, regardless
                of whether the full panel is open. On mobile this is the *only* AI
                surface visible until the agent taps "All Suggestions" to expand. */}
            {topSuggestion && topSuggestion.confidence > 85 && !popupDismissed && (
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
                        <span className="text-[11px] font-bold text-violet-700 uppercase tracking-wider">{t("conversations.suggestion.aiRecommendation")}</span>
                      </div>
                      <button
                        onClick={() => {
                          if (!copilotOpen) setCopilotOpen(true);
                          setTimeout(() => repliesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                        }}
                        className="text-[10px] font-medium text-violet-400 hover:text-violet-600 transition"
                      >
                        {t("conversations.suggestion.allSuggestions")}
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
                        {t("conversations.suggestion.dismiss")}
                      </button>
                      <button
                        onClick={() => { setInputText(topSuggestion.text); setPopupDismissed(true); }}
                        className="px-3.5 py-1.5 text-[11px] font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 rounded-lg hover:from-violet-600 hover:to-purple-700 transition-all shadow-sm shadow-violet-300/40"
                      >
                        {t("conversations.suggestion.applyToInput")}
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

            <AIComposeScope
              surface="inbox"
              conversationId={conversationId}
              channel={conversation?.channel}
              currentValue={inputText}
              onApply={(text) => setInputText(text)}
            >
              <AIComposePanel />
            {/*
              What the next message will quote, shown ON the composer.

              Above the input rather than on the bubble, because that is where
              the agent is looking when they type. A reply target visible only
              on a message they have scrolled past is one they forget they set,
              and the customer gets a quote of something unrelated.
            */}
            {/* Email: reply in thread, or start a new one.
                Shown only on mail conversations, because it is meaningless
                anywhere else - every other channel has one continuous thread
                and no concept of a subject. */}
            {isEmailConversation && (
              <div className="mb-1.5 rounded-xl bg-white px-3 py-2 ring-1 ring-gray-200/80">
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg bg-gray-100 p-0.5">
                    {(["reply", "new"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setEmailMode(mode)}
                        className={clsx(
                          "px-2.5 py-1 rounded-md text-[11px] font-medium transition",
                          emailMode === mode ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
                        )}
                      >
                        {mode === "reply"
                          ? t("conversations.email.replyInThread")
                          : t("conversations.email.newEmail")}
                      </button>
                    ))}
                  </div>
                  <span className="text-[11px] text-gray-400 truncate">
                    {emailMode === "reply"
                      ? t("conversations.email.replyHint")
                      : t("conversations.email.newHint")}
                  </span>
                </div>
                {emailMode === "new" && (
                  <input
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                    maxLength={200}
                    placeholder={t("conversations.email.subjectPlaceholder")}
                    className="mt-2 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-primary-300 focus:ring-2 focus:ring-primary-100"
                  />
                )}
              </div>
            )}

            {replyTo && (
              <div className="mb-1.5 flex items-start gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-gray-200/80">
                <div className="w-0.5 self-stretch rounded bg-primary-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium text-gray-500">
                    {replyTo.direction === "OUTBOUND"
                      ? t("conversations.reply.replyingToYou")
                      : t("conversations.reply.replyingToCustomer")}
                  </div>
                  <div className="truncate text-xs text-gray-700">
                    {replyTo.messageType === "image"
                      ? t("conversations.reply.photo")
                      : replyTo.messageType === "audio"
                        ? t("conversations.reply.voice")
                        : replyTo.messageType === "video"
                          ? t("conversations.reply.video")
                          : replyTo.messageType === "document"
                            ? replyTo.fileName || t("conversations.reply.file")
                            : replyTo.body}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  aria-label={t("conversations.reply.cancel")}
                  title={t("conversations.reply.cancel")}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            <div className={clsx("rounded-2xl transition-all relative", aiGenerating ? "p-[2px] ai-border-glow" : "p-0")}>
            <form onSubmit={handleSend} className={clsx("flex items-end gap-2 bg-white rounded-2xl shadow-lg shadow-gray-200/50 px-3 py-1.5 transition", aiGenerating ? "" : "ring-1 ring-gray-200/80 focus-within:ring-2 focus-within:ring-primary-300")}>
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

              {/* Product picker - Shopify Live Chat conversations only.
                  Every other channel has nowhere to render a card, so
                  offering the button there would promise something the
                  customer would never receive. */}
              {conversation?.channel === "SHOPIFY_LIVE_CHAT" && (
                <button
                  type="button"
                  onClick={() => setProductPickerOpen(true)}
                  className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition flex-shrink-0"
                  title={t("shopifyChat.products")}
                  aria-label={t("shopifyChat.products")}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 8h12l-1 12H7L6 8Z" />
                    <path d="M9 8V6a3 3 0 0 1 6 0v2" />
                  </svg>
                </button>
              )}

              {/* AI compose trigger - panel opens above the input */}
              <AIComposeTrigger compact />

              {/* Text input.
                  A textarea rather than an <input>, because an input cannot
                  hold a newline at all - Shift+Enter had nothing to insert.
                  Enter still sends; Shift+Enter breaks the line. It grows with
                  the message and stops at ~6 lines, after which it scrolls,
                  so a long paste cannot push the composer off the screen. */}
              <textarea
                ref={inputRef}
                rows={1}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={attachedFiles.length > 0 ? t("conversations.addCaption") : t("conversations.typeMessage")}
                className="flex-1 py-2 bg-transparent border-0 text-base md:text-sm outline-none placeholder:text-gray-400 resize-none max-h-[9rem] overflow-y-auto leading-6"
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
            </AIComposeScope>
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

      {/* Context Panel (formerly History) - past conversations + CRM activity
          + CRM notes + AI summaries + local notes. CRM data is reused from the
          chat-level fetch so opening this panel is instant. */}
      {historyOpen && (
        <HistoryPanel
          conversation={conversation}
          crmContext={crmContext}
          crmLoading={crmLoading}
          onCrmNotePosted={refetchCrm}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {/* Decision Timeline (P1-5) - admin-only kernel loop trace. */}
      {timelineOpen && conversationId && (
        <DecisionTimelinePanel
          conversationId={conversationId}
          onClose={() => setTimelineOpen(false)}
        />
      )}

      {/* Floating "Ask Co-Pilot" action - shown when the agent marks any text
          inside an inbound customer message. Click → opens CoPilot panel with
          the quote pre-filled in the chat composer. */}
      {askSelection && (
        <button
          type="button"
          style={{
            position: "fixed",
            left: `${askSelection.x}px`,
            top: `${askSelection.y}px`,
            transform: "translateX(-50%)",
            zIndex: 60,
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 shadow-lg shadow-violet-300/40 hover:from-violet-600 hover:to-purple-700 transition-all animate-fade-in-up whitespace-nowrap"
          onMouseDown={(e) => e.preventDefault() /* keep the text selection alive while we read it */}
          onClick={() => {
            const quote = askSelection.text;
            setAskPrefill({ quote, version: Date.now() });
            setCopilotOpen(true);
            setAskSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
          {t("conversations.askCopilot")}
        </button>
      )}

      {/* Co-Pilot Panel - always mounted while a conversation is loaded so the
          suggestion + intelligence fetch runs in the background even when the
          panel is closed. Visibility is controlled by `isOpen`; when closed it
          renders nothing visually but its effects keep the floating
          "AI Recommendation" popup (above) populated. */}
      {conversation && (
        <CoPilotPanel
          isOpen={copilotOpen}
          conversation={conversation}
          messages={messages}
          crmContext={crmContext}
          crmLoading={crmLoading}
          onRefetchCrm={refetchCrm}
          onInsertReply={(text) => setInputText(text)}
          onClose={() => setCopilotOpen(false)}
          onOpen={() => setCopilotOpen(true)}
          onAiLoadingChange={setAiGenerating}
          onTopSuggestion={(s) => { setTopSuggestion((prev) => { if (s?.text !== prev?.text) setPopupDismissed(false); return s; }); }}
          repliesRef={repliesRef}
          prefillQuote={askPrefill}
        />
      )}

      {productPickerOpen && conversation?.channel === "SHOPIFY_LIVE_CHAT" && (
        <ProductPicker
          conversationId={conversationId}
          maxProducts={5}
          channel={conversation.channel}
          onClose={() => setProductPickerOpen(false)}
          onSent={() => { /* the message arrives over the socket like any other */ }}
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
            <p className="text-xs text-gray-400 mb-3">{t("conversations.transferSubtitle")}</p>
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

/**
 * Adapters fill an empty caption with a placeholder - "[Image]", "[Document]" -
 * so a media message is never a blank row in a list preview. Once the picture
 * itself is on screen that placeholder is noise printed under it, and it is
 * the thing that made an attachment look like the customer had typed the word
 * "[Document]" at us. Hidden in the bubble, kept everywhere the body is the
 * only thing shown.
 */
const MEDIA_PLACEHOLDER_BODIES = new Set([
  "[Image]", "[Video]", "[Document]", "[Audio message]", "[Voice message]", "[Sticker]",
  "[Contact]",
]);

/**
 * The message a bubble is replying to, rendered above it.
 *
 * `quoted` is null when the customer replied to something we do not hold - a
 * message from before GOTCHA was connected, or one since deleted. That is a
 * normal outcome and NOT an error, so it says "an earlier message" rather than
 * rendering nothing: the fact that this IS a reply changes how the text above
 * it reads, and hiding that is worse than an unresolved preview.
 */
function QuotedMessage({
  quoted,
  onJump,
  t,
}: {
  quoted: any | null | undefined;
  onJump?: () => void;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const label = quoted
    ? quoted.direction === "OUTBOUND"
      ? quoted.senderName || t("conversations.reply.you")
      : t("conversations.reply.customer")
    : null;

  // Media has no body worth quoting, so the preview names the kind instead of
  // printing a placeholder like "[Image]" that reads as literal text.
  const preview = !quoted
    ? t("conversations.reply.unavailable")
    : quoted.messageType === "image"
      ? t("conversations.reply.photo")
      : quoted.messageType === "audio"
        ? t("conversations.reply.voice")
        : quoted.messageType === "video"
          ? t("conversations.reply.video")
          : quoted.messageType === "contact"
            ? t("conversations.reply.contact")
            : quoted.messageType === "document"
              ? quoted.fileName || t("conversations.reply.file")
              : (quoted.body || "").slice(0, 140);

  // A thumbnail when the quoted message was a photo. WhatsApp does this and it
  // is the fastest way to know which of five images is meant, which is exactly
  // the case where a text label helps least.
  const thumb = quoted?.messageType === "image" && quoted?.mediaUrl ? quoted.mediaUrl : null;

  const jumpable = !!onJump && !!quoted;
  const Tag: any = jumpable ? "button" : "div";

  return (
    <Tag
      type={jumpable ? "button" : undefined}
      onClick={jumpable ? onJump : undefined}
      className={[
        "mb-1 flex w-full items-center gap-2 rounded-md border-s-2 border-current/40 bg-black/5 px-2 py-1 text-start",
        // Only offer the affordance when there is somewhere to go. An
        // unresolved quote that looked clickable and did nothing would read as
        // a broken button rather than as a message we do not hold.
        jumpable ? "cursor-pointer hover:bg-black/10 transition" : "",
      ].join(" ")}
    >
      <div className="min-w-0 flex-1">
        {label && <div className="text-[10px] font-medium opacity-70">{label}</div>}
        <div className="text-[11px] opacity-80 line-clamp-2 break-words">{preview}</div>
      </div>
      {thumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
      )}
    </Tag>
  );
}

/**
 * A contact somebody shared through the WhatsApp attach menu.
 *
 * Rendered as something actionable rather than as text. The whole reason a
 * customer sends a contact is so the business can ring it - a partner's number
 * for a delivery, an accountant's for an invoice - and until now it arrived as
 * the dead string "[contacts message]", which lost both the number and the
 * point.
 */
function ContactCard({
  contacts,
  t,
}: {
  contacts: any[];
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  return (
    <div className="mb-1 space-y-1.5">
      {contacts.map((c, i) => (
        <div key={i} className="rounded-lg bg-black/5 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/10 text-[11px] font-semibold">
              {(c.name || "?").trim().charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">
                {c.name || t("conversations.reply.contact")}
              </div>
              {c.organization && (
                <div className="truncate text-[10px] opacity-70">{c.organization}</div>
              )}
            </div>
          </div>
          {(c.phones ?? []).map((p: any, j: number) => (
            <div key={j} className="mt-1 flex items-center justify-between gap-2 ps-9">
              <span className="truncate text-[11px] opacity-90" dir="ltr">
                {p.number}
              </span>
              <span className="flex shrink-0 gap-1.5">
                {/*
                  `wa_id` is present only when Meta knows the number is on
                  WhatsApp. Offering the WhatsApp link without it would send the
                  agent to a dead end, so it is conditional while `tel:` - which
                  always works - is not.
                */}
                {p.waId && (
                  <a
                    href={`https://wa.me/${String(p.waId).replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium underline opacity-80 hover:opacity-100"
                  >
                    {t("conversations.reply.openWhatsapp")}
                  </a>
                )}
                <a
                  href={`tel:${String(p.number).replace(/[^\d+]/g, "")}`}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium underline opacity-80 hover:opacity-100"
                >
                  {t("conversations.reply.call")}
                </a>
              </span>
            </div>
          ))}
          {(c.emails ?? []).map((e: any, j: number) => (
            <div key={j} className="mt-1 ps-9">
              <a
                href={`mailto:${e.address}`}
                className="truncate text-[11px] underline opacity-80 hover:opacity-100"
                dir="ltr"
              >
                {e.address}
              </a>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function isRedundantMediaCaption(msg: any): boolean {
  // A shared contact has no mediaUrl but its body IS the card's headline - the
  // name - so printing it above the card says the same thing twice.
  if (msg.messageType === "contact" && msg.metadata?.contacts?.length) return true;
  if (!msg.mediaUrl) return false;
  const body = String(msg.body ?? "").trim();
  // The sender's own filename is used as the document caption, and it is
  // already the label on the download link.
  return MEDIA_PLACEHOLDER_BODIES.has(body) || (!!msg.fileName && body === msg.fileName);
}

/**
 * The media part of a message bubble: image, video, voice note, or a file to
 * download. Identical for inbound, outbound and business-app echoes - a photo
 * is a photo whoever sent it.
 *
 * Two things this has to get right that the previous inline version did not.
 *
 * Audio fell through to the generic file link, so a voice note - the single
 * most common attachment on WhatsApp - was a download rather than something
 * you could listen to without leaving the inbox.
 *
 * And an attachment that failed to download rendered as nothing at all,
 * leaving a bubble whose whole content was the literal text "[Document]". That
 * reads as the customer having typed it. WhatsApp media expires a few days
 * after it is sent and the id is the only handle on it, so this state is
 * permanent and has to say so rather than look like a rendering glitch.
 */
function MessageMedia({ msg, t }: { msg: any; t: (key: string, vars?: Record<string, string>) => string }) {
  const url: string | undefined = msg.mediaUrl || undefined;
  const type: string = msg.messageType || "";
  const mediaError: string | undefined = msg.metadata?.mediaError;

  if (!url) {
    if (!mediaError) return null;
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg mb-1 bg-black/5 ring-1 ring-black/10">
        <svg className="w-4 h-4 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
        <span className="text-xs opacity-80">{t("conversations.mediaUnavailable")}</span>
      </div>
    );
  }

  // messageType is authoritative; the extension is the fallback for rows
  // written before the type was recorded, and for pass-through CDN URLs.
  const isImage = type === "image" || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url);
  const isVideo = type === "video" || /\.(mp4|webm|mov|m4v)$/i.test(url);
  const isAudio = type === "audio" || type === "voice" || /\.(ogg|oga|mp3|m4a|aac|wav|opus)$/i.test(url);

  if (isImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={msg.fileName || ""}
        loading="lazy"
        // Bounded in BOTH directions, and `object-contain` so nothing is
        // cropped. Width alone was not enough: a tall photo from a phone
        // camera is far taller than it is wide, so `max-w-full` left a single
        // message occupying several screens and the agent had to scroll past
        // one image to reach the next message. Capped at 320px it stays a
        // glance, and the full picture is one click away.
        className="max-h-[320px] w-auto max-w-full rounded-lg mb-1 cursor-pointer object-contain"
        onClick={() => window.open(url, "_blank")}
      />
    );
  }
  if (isVideo) {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-[320px] w-auto max-w-full rounded-lg mb-1"
      />
    );
  }
  if (isAudio) {
    return (
      <div className="mb-1">
        <audio src={url} controls preload="metadata" className="max-w-full w-[240px]" />
      </div>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      // `download` is what makes a PDF save instead of taking over the tab.
      // The browser only honours it same-origin, which uploads are - they are
      // served from /api/uploads on this host.
      download={msg.fileName || undefined}
      className="flex items-center gap-2 px-3 py-2 bg-white/20 rounded-lg mb-1 hover:bg-white/30 transition"
    >
      <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      <span className="text-xs truncate">{msg.fileName || t("conversations.downloadFile")}</span>
    </a>
  );
}

function SystemDivider({ metadata, timestamp, t }: { metadata: any; timestamp: string; t: (key: string, vars?: Record<string, string>) => string }) {
  const event = metadata?.systemEvent;
  let icon: React.ReactNode;
  let label: string;
  let colors: string;

  // The specific gate/case that triggered an AI handover, localized. Falls
  // back to the model-authored summary, then to nothing (bare label).
  const escalationReason = (() => {
    const rawCase = typeof metadata?.escalationCase === "string" ? metadata.escalationCase : "";
    // Cases arrive both bare ("agent_paused") and prefixed ("budget_exceeded:tenant_day").
    const caseKey = rawCase.split(":")[0];
    if (caseKey) {
      const translated = t(`conversations.escalationReason.${caseKey}`);
      if (translated && !translated.includes("escalationReason.")) return translated;
    }
    if (typeof metadata?.escalationSummary === "string" && metadata.escalationSummary.trim()) {
      return metadata.escalationSummary.trim();
    }
    return "";
  })();

  switch (event) {
    case "returned_to_ai":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
      );
      label = t("conversations.systemReturnedToAi");
      colors = "bg-violet-50 text-violet-600";
      break;
    case "bot_handover":
    case "ai_bot_escalation":
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      );
      label = event === "ai_bot_escalation" ? t("conversations.systemAiEscalation") : t("conversations.systemBotHandover");
      if (escalationReason) label = `${label} - ${escalationReason}`;
      colors = "bg-amber-50 text-amber-600";
      break;
    case "flow_ended_handoff":
      // A flow stopped without saying what happens next and the conversation
      // was handed to a person rather than left stranded. The reason names the
      // authoring gap, because this divider is the only place anyone will
      // learn the graph has a hole in it.
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      );
      label = t("conversations.systemFlowEndedHandoff");
      {
        const reasonKey = typeof metadata?.flowEndReason === "string" ? metadata.flowEndReason : "";
        const why = reasonKey ? t(`conversations.flowEndReason.${reasonKey}`) : "";
        if (why && !why.includes("flowEndReason.")) label = `${label} - ${why}`;
      }
      colors = "bg-orange-50 text-orange-600";
      break;
    case "whatsapp_app_takeover":
      // The owner answered from the WhatsApp Business app on their phone.
      // Same shape as an escalation - the AI stopped and a person is driving -
      // so it reads with the handover colors, not as a neutral note.
      icon = (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
        </svg>
      );
      label = t("conversations.systemWhatsappAppTakeover");
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

// Surfaces WHY an outbound message failed, directly in the Inbox. Shows the
// human reason inline and, on click, the full structured provider breakdown
// (HTTP status, Meta code/subcode/type, fbtrace_id, request id, retryability)
// so a failed send is diagnosable from the UI alone - no DB query, no logs.
function MessageFailureDetail({
  errorMessage,
  sendError,
  t,
}: {
  errorMessage?: string | null;
  sendError?: any;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState(false);
  const reason = errorMessage || sendError?.message || t("conversations.messageStatus.failed");
  const rows: Array<[string, any]> = sendError
    ? ([
        ["HTTP", sendError.httpStatus],
        [t("conversations.sendError.code"), sendError.code != null ? `${sendError.code}${sendError.subcode ? " / " + sendError.subcode : ""}` : undefined],
        [t("conversations.sendError.type"), sendError.type],
        [t("conversations.sendError.detail"), sendError.detail],
        ["fbtrace_id", sendError.fbtraceId],
        [t("conversations.sendError.requestId"), sendError.requestId],
        [t("conversations.sendError.retryable"), sendError.retryable === undefined ? undefined : (sendError.retryable ? t("common.yes") : t("common.no"))],
        [t("conversations.sendError.at"), sendError.at],
      ].filter(([, v]) => v !== undefined && v !== null && v !== "") as Array<[string, any]>)
    : [];
  const hasDetail = rows.length > 0;
  return (
    <div className="mt-1 flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={clsx(
          "text-[10px] text-red-400 max-w-[240px] text-right leading-tight",
          hasDetail && "cursor-pointer hover:text-red-300 underline decoration-dotted underline-offset-2",
        )}
        title={hasDetail ? t("conversations.sendError.toggle") : undefined}
      >
        {t("conversations.sendError.prefix")}: {reason}
      </button>
      {open && hasDetail && (
        <div className="mt-1 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[10px] text-red-200/90 font-mono max-w-[260px] overflow-x-auto">
          <table className="border-collapse">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} className="align-top">
                  <td className="pr-2 opacity-60 whitespace-nowrap">{k}</td>
                  <td className="break-all">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MessageStatusIcon({ status, t }: { status: string; t: (key: string, vars?: Record<string, string>) => string }) {
  const color = status === "READ" ? "text-blue-400" : "opacity-40";
  const tooltips: Record<string, string> = {
    PENDING: t("conversations.messageStatus.sending"),
    SENT: t("conversations.messageStatus.sent"),
    DELIVERED: t("conversations.messageStatus.delivered"),
    READ: t("conversations.messageStatus.read"),
    FAILED: t("conversations.messageStatus.failed"),
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
