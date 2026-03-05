"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { getAISuggestions, getAISummary, sendCopilotChat } from "@/lib/api";
import clsx from "clsx";

interface CoPilotPanelProps {
  conversation: any;
  messages: any[];
  onInsertReply: (text: string) => void;
  onClose?: () => void;
  onAiLoadingChange?: (loading: boolean) => void;
}

// Fallback demo suggested replies when AI service returns stub/error
function getDemoSuggestions(messages: any[], conversation: any): { text: string; label: string; confidence: number }[] {
  const lastInbound = [...messages].reverse().find((m) => m.direction === "INBOUND");
  const body = (lastInbound?.body || "").toLowerCase();

  if (body.includes("price") || body.includes("cost") || body.includes("how much")) {
    return [
      { text: "Our pricing starts at $29/month for the basic plan. Would you like me to send you a detailed breakdown of all our plans?", label: "Pricing info", confidence: 95 },
      { text: "I'd be happy to help with pricing! Could you tell me a bit more about your needs so I can recommend the best plan?", label: "Discovery", confidence: 88 },
      { text: "Great question! Let me pull up our current pricing for you. One moment please.", label: "Quick ack", confidence: 82 },
    ];
  }
  if (body.includes("help") || body.includes("issue") || body.includes("problem") || body.includes("broken") || body.includes("not working")) {
    return [
      { text: "I'm sorry to hear you're experiencing an issue. Could you describe what's happening in more detail so I can help resolve this quickly?", label: "Empathize & gather info", confidence: 94 },
      { text: "Thank you for reaching out. Let me look into this right away. Can you share any error messages or screenshots?", label: "Technical follow-up", confidence: 89 },
      { text: "I understand how frustrating that must be. Let me check our system for any known issues and get back to you.", label: "Investigate", confidence: 85 },
    ];
  }
  if (body.includes("thank") || body.includes("thanks") || body.includes("great")) {
    return [
      { text: "You're welcome! Is there anything else I can help you with today?", label: "Positive close", confidence: 96 },
      { text: "Happy to help! Don't hesitate to reach out if you need anything else.", label: "Friendly close", confidence: 92 },
    ];
  }
  if (body.includes("cancel") || body.includes("refund") || body.includes("stop")) {
    return [
      { text: "I understand you'd like to discuss cancellation. Before we proceed, could I learn more about what's not working for you? I'd love the chance to address any concerns.", label: "Retention", confidence: 91 },
      { text: "I'm sorry to hear that. Let me look into your account and see what options are available. Could you provide your account email?", label: "Process request", confidence: 87 },
    ];
  }

  return [
    { text: "Thank you for reaching out! How can I assist you today?", label: "Greeting", confidence: 90 },
    { text: "I'd be happy to help with that. Could you provide a few more details so I can better assist you?", label: "Gather details", confidence: 85 },
    { text: "Let me look into that for you right away. I'll get back to you shortly.", label: "Acknowledge", confidence: 80 },
  ];
}

function getDemoKBResults(query: string): { title: string; snippet: string; source: string }[] {
  const q = query.toLowerCase();
  if (q.includes("refund") || q.includes("cancel")) {
    return [
      { title: "Refund & Cancellation Policy", snippet: "Customers are eligible for a full refund within 30 days of purchase. After 30 days, pro-rated refunds may be issued...", source: "Policies / Refund Policy" },
      { title: "How to Process a Cancellation", snippet: "Navigate to Settings > Subscription > Cancel. Ensure all data exports are completed before...", source: "Internal Docs / Procedures" },
    ];
  }
  if (q.includes("pricing") || q.includes("plan")) {
    return [
      { title: "Pricing Plans Overview", snippet: "Basic ($29/mo) - Up to 500 conversations. Pro ($79/mo) - Up to 2,000 conversations. Enterprise - Custom pricing...", source: "Sales / Pricing" },
      { title: "Feature Comparison Table", snippet: "Compare features across Basic, Pro, and Enterprise plans including automation, integrations, and support levels.", source: "Sales / Plans" },
    ];
  }
  if (q.includes("setup") || q.includes("start") || q.includes("install")) {
    return [
      { title: "Getting Started Guide", snippet: "Follow these steps to set up your WhatsApp Business integration: 1. Connect your phone number 2. Configure webhooks...", source: "Docs / Quick Start" },
    ];
  }
  if (q.length > 0) {
    return [
      { title: "General FAQ", snippet: "Find answers to commonly asked questions about our platform, features, and support options.", source: "Help Center / FAQ" },
    ];
  }
  return [];
}

function getLocalSummary(messages: any[], conversation: any): string {
  if (messages.length === 0) return "No messages yet.";
  const inboundCount = messages.filter((m) => m.direction === "INBOUND").length;
  const outboundCount = messages.filter((m) => m.direction === "OUTBOUND").length;
  const lastInbound = [...messages].reverse().find((m) => m.direction === "INBOUND");

  let summary = `${messages.length} messages (${inboundCount} from customer, ${outboundCount} from agent).`;
  if (lastInbound) {
    const preview = lastInbound.body.length > 80 ? lastInbound.body.slice(0, 80) + "..." : lastInbound.body;
    summary += ` Last customer message: "${preview}"`;
  }
  return summary;
}

export function CoPilotPanel({ conversation, messages, onInsertReply, onClose, onAiLoadingChange }: CoPilotPanelProps) {
  const { token } = useAuth();
  const [kbQuery, setKbQuery] = useState("");
  const [kbResults, setKbResults] = useState<{ title: string; snippet: string; source: string }[]>([]);
  const [activeTab, setActiveTab] = useState<"suggest" | "search" | "chat">("suggest");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Chat mode state
  type ChatMsg = { role: "user" | "assistant"; content: string };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // AI-powered state
  const [aiSuggestions, setAiSuggestions] = useState<{ text: string; label: string; confidence: number }[] | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [copilotMode, setCopilotMode] = useState<string>("READY_MESSAGE");
  const [paused, setPaused] = useState(false);

  // Notify parent of AI loading state
  useEffect(() => {
    onAiLoadingChange?.(aiLoading || chatLoading);
  }, [aiLoading, chatLoading, onAiLoadingChange]);

  // Auto-switch to chat tab when copilotMode is CHAT
  useEffect(() => {
    if (copilotMode === "CHAT") setActiveTab("chat");
  }, [copilotMode]);

  // Determine if last message is outbound (skip auto-fetch in that case)
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastIsOutbound = lastMessage?.direction === "OUTBOUND";

  const demoSuggestions = useMemo(() => getDemoSuggestions(messages, conversation), [messages, conversation]);
  const localSummary = useMemo(() => getLocalSummary(messages, conversation), [messages, conversation]);

  // The suggestions to display: AI-powered if available, otherwise demo
  const suggestions = aiSuggestions || demoSuggestions;
  const summary = aiSummary || localSummary;

  // Fetch AI suggestions when conversation/messages change
  const fetchAI = useCallback(async () => {
    if (!token || !conversation?.id || paused) return;
    setAiLoading(true);
    try {
      const [suggestionsRes, summaryRes] = await Promise.all([
        getAISuggestions(token, conversation.id).catch(() => null),
        getAISummary(token, conversation.id).catch(() => null),
      ]);

      if (suggestionsRes?.data && suggestionsRes.data.length > 0) {
        // Check if it's the stub response
        const isStub = suggestionsRes.data.length === 1 && suggestionsRes.data[0].type === "info";
        if (!isStub) {
          setAiSuggestions(suggestionsRes.data.map((s: any, i: number) => ({
            text: s.text,
            label: s.type === "reply" ? `AI Reply ${i + 1}` : s.type === "action" ? "Action" : "Info",
            confidence: Math.round(s.confidence * 100),
          })));
        }
      }
      // Read copilotMode from either response
      if (suggestionsRes?.copilotMode) setCopilotMode(suggestionsRes.copilotMode);
      else if (summaryRes?.copilotMode) setCopilotMode(summaryRes.copilotMode);

      if (summaryRes?.data?.summary && summaryRes.data.summary !== "AI summarization not configured.") {
        setAiSummary(summaryRes.data.summary);
      }
    } catch {
      // Silently fall back to demo
    } finally {
      setAiLoading(false);
    }
  }, [token, conversation?.id, paused]);

  useEffect(() => {
    if (!lastIsOutbound) fetchAI();
  }, [fetchAI, lastIsOutbound]);

  // Re-fetch when messages change significantly (only on INBOUND)
  useEffect(() => {
    if (messages.length > 0 && !lastIsOutbound) {
      const timer = setTimeout(() => fetchAI(), 1000);
      return () => clearTimeout(timer);
    }
  }, [messages.length, lastIsOutbound]);

  function handleSearch() {
    if (!kbQuery.trim()) return;
    setKbResults(getDemoKBResults(kbQuery));
  }

  function handleInsert(text: string, idx: number) {
    onInsertReply(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }

  async function handleChatSubmit(e: { preventDefault: () => void }) {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading || !token || !conversation?.id) return;
    const msg = chatInput.trim();
    setChatInput("");
    const updated = [...chatMessages, { role: "user" as const, content: msg }];
    setChatMessages(updated);
    setChatLoading(true);
    try {
      const res = await sendCopilotChat(token, conversation.id, { message: msg, history: chatMessages });
      setChatMessages([...updated, { role: "assistant" as const, content: res.data.reply }]);
    } catch (_err) {
      setChatMessages([...updated, { role: "assistant" as const, content: "Failed to get response. Please try again." }]);
    } finally {
      setChatLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto w-full md:w-[340px] bg-white flex flex-col h-full animate-slide-in-right">
      {/* Header */}
      <div className="px-4 py-3 shadow-subtle flex items-center gap-2.5">
        <div className="w-8 h-8 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl flex items-center justify-center shadow-sm">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">AI Co-Pilot</p>
          <p className="text-[10px] text-gray-400">{aiSuggestions ? "AI-Powered" : "Demo Mode"}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Regenerate button (shown when last message is outbound) */}
          {lastIsOutbound && !paused && (
            <button
              onClick={() => fetchAI()}
              className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg bg-violet-50 text-violet-600 hover:bg-violet-100 transition"
              title="Regenerate suggestions"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M2.985 14.652" />
              </svg>
              Regenerate
            </button>
          )}
          {/* Pause / Resume button */}
          <button
            onClick={() => setPaused(!paused)}
            className={clsx(
              "flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg transition",
              paused
                ? "bg-amber-50 text-amber-600 hover:bg-amber-100"
                : "bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            )}
            title={paused ? "Resume Co-Pilot" : "Pause Co-Pilot"}
          >
            {paused ? (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
              </svg>
            ) : (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7.5 0A.75.75 0 0115 4.5h1.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H15a.75.75 0 01-.75-.75V5.25z" clipRule="evenodd" />
              </svg>
            )}
            {paused ? "Paused" : "Pause"}
          </button>

          <div className="flex items-center gap-0.5">
            {paused ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400"></span>
                </span>
                <span className="text-[10px] text-amber-500 font-medium ml-1">Paused</span>
              </>
            ) : aiLoading ? (
              <div className="w-3 h-3 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
            ) : (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                <span className="text-[10px] text-green-600 font-medium ml-1">Live</span>
              </>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="md:hidden w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
              aria-label="Close Co-Pilot"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex bg-gray-50/50">
        <button
          onClick={() => setActiveTab("suggest")}
          className={clsx(
            "flex-1 py-2.5 text-xs font-medium transition-all relative",
            activeTab === "suggest"
              ? "text-primary-600"
              : "text-gray-400 hover:text-gray-600"
          )}
        >
          Suggestions
          {activeTab === "suggest" && (
            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary-500 rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("search")}
          className={clsx(
            "flex-1 py-2.5 text-xs font-medium transition-all relative",
            activeTab === "search"
              ? "text-primary-600"
              : "text-gray-400 hover:text-gray-600"
          )}
        >
          Knowledge Base
          {activeTab === "search" && (
            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary-500 rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("chat")}
          className={clsx(
            "flex-1 py-2.5 text-xs font-medium transition-all relative",
            activeTab === "chat"
              ? "text-primary-600"
              : "text-gray-400 hover:text-gray-600"
          )}
        >
          AI Chat
          {activeTab === "chat" && (
            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary-500 rounded-full" />
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "suggest" ? (
          <div className="p-3 space-y-3">
            {/* Context summary card */}
            <div className="bg-gradient-to-br from-primary-50/80 to-violet-50/80 rounded-xl p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <svg className="w-3.5 h-3.5 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                </svg>
                <span className="text-[10px] font-semibold text-primary-600 uppercase tracking-wider">Context</span>
              </div>
              <p className="text-xs text-gray-600 leading-relaxed">{summary}</p>
            </div>

            {/* Customer info card */}
            {conversation && (
              <div className="bg-gray-50 rounded-xl p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                  </svg>
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Customer</span>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400">Name</span>
                    <span className="text-[11px] font-medium text-gray-700">{conversation.customerName || "Unknown"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400">Phone</span>
                    <span className="text-[11px] font-medium text-gray-700">{conversation.customerPhone}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400">Status</span>
                    <span className={clsx(
                      "text-[10px] font-medium px-2 py-0.5 rounded-full",
                      conversation.status === "OPEN" ? "bg-green-50 text-green-600" :
                      conversation.status === "WAITING" ? "bg-amber-50 text-amber-600" :
                      "bg-gray-100 text-gray-500"
                    )}>
                      {conversation.status}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Suggested replies */}
            <div>
              <div className="flex items-center gap-1.5 mb-2 px-0.5">
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Suggested Replies</span>
                {aiSuggestions && (
                  <span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full font-medium">AI</span>
                )}
              </div>
              <div className="space-y-2">
                {suggestions.map((s, i) => {
                  const isContextOnly = copilotMode === "CONTEXT_ONLY";
                  const Wrapper = isContextOnly ? "div" : "button";
                  return (
                    <Wrapper
                      key={i}
                      {...(!isContextOnly ? { onClick: () => handleInsert(s.text, i) } : {})}
                      className={clsx("w-full text-start", !isContextOnly && "group")}
                    >
                      <div className={clsx(
                        "rounded-xl p-3 transition-all",
                        copiedIdx === i
                          ? "bg-green-50 shadow-subtle"
                          : isContextOnly
                            ? "bg-gray-50"
                            : "bg-white shadow-subtle hover:shadow-panel hover:-translate-y-px hover:bg-primary-50/50"
                      )}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[10px] font-semibold text-primary-500">{s.label}</span>
                          <div className="flex items-center gap-1.5">
                            <div className="flex items-center gap-0.5">
                              <div className={clsx(
                                "h-1 rounded-full transition-all",
                                s.confidence >= 90 ? "bg-green-400 w-4" : s.confidence >= 85 ? "bg-amber-400 w-3" : "bg-gray-300 w-2"
                              )} />
                              <span className="text-[9px] text-gray-400">{s.confidence}%</span>
                            </div>
                            {!isContextOnly && (
                              copiedIdx === i ? (
                                <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                              ) : (
                                <svg className="w-3.5 h-3.5 text-gray-300 group-hover:text-primary-400 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m0 0l6.75-6.75M12 19.5l-6.75-6.75" />
                                </svg>
                              )
                            )}
                          </div>
                        </div>
                        <p className="text-xs text-gray-600 leading-relaxed">{s.text}</p>
                      </div>
                    </Wrapper>
                  );
                })}
              </div>
            </div>
          </div>
        ) : activeTab === "search" ? (
          <div className="p-3 space-y-3">
            {/* Search input */}
            <div className="relative">
              <input
                type="text"
                value={kbQuery}
                onChange={(e) => setKbQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="Search company docs..."
                className="w-full pl-9 pr-3 py-2.5 bg-gray-50/80 border-0 ring-1 ring-gray-200/60 rounded-xl text-base md:text-xs focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition"
              />
              <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
            </div>

            {/* Quick search tags */}
            <div className="flex flex-wrap gap-1.5">
              {["Refund policy", "Pricing plans", "Setup guide"].map((tag) => (
                <button
                  key={tag}
                  onClick={() => { setKbQuery(tag); setKbResults(getDemoKBResults(tag)); }}
                  className="text-[10px] px-2.5 py-1 bg-primary-50 text-primary-600 rounded-lg hover:bg-primary-100 transition font-medium"
                >
                  {tag}
                </button>
              ))}
            </div>

            {/* Results */}
            {kbResults.length > 0 ? (
              <div className="space-y-2">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-0.5">
                  {kbResults.length} result{kbResults.length !== 1 ? "s" : ""} found
                </span>
                {kbResults.map((r, i) => (
                  <div key={i} className="bg-gray-50/50 rounded-xl p-3 hover:bg-gray-50 hover:shadow-subtle transition">
                    <div className="flex items-start gap-2">
                      <div className="w-6 h-6 bg-primary-50 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                        <svg className="w-3 h-3 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900">{r.title}</p>
                        <p className="text-[11px] text-gray-500 leading-relaxed mt-0.5">{r.snippet}</p>
                        <p className="text-[10px] text-primary-400 mt-1">{r.source}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : kbQuery ? (
              <div className="text-center py-8">
                <div className="w-12 h-12 bg-gray-50 rounded-xl flex items-center justify-center mx-auto mb-2">
                  <svg className="w-6 h-6 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                  </svg>
                </div>
                <p className="text-xs text-gray-400">Press Enter to search</p>
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="w-12 h-12 bg-primary-50 rounded-xl flex items-center justify-center mx-auto mb-2">
                  <svg className="w-6 h-6 text-primary-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                  </svg>
                </div>
                <p className="text-xs text-gray-400">Search your company knowledge base</p>
                <p className="text-[10px] text-gray-300 mt-1">Try the quick tags above</p>
              </div>
            )}
          </div>
        ) : activeTab === "chat" ? (
          <div className="flex flex-col h-full">
            {/* Chat messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
              {chatMessages.length === 0 && (
                <div className="text-center py-8">
                  <div className="w-12 h-12 bg-violet-50 rounded-xl flex items-center justify-center mx-auto mb-2">
                    <svg className="w-6 h-6 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                    </svg>
                  </div>
                  <p className="text-xs text-gray-500 font-medium">Ask the AI anything</p>
                  <p className="text-[10px] text-gray-400 mt-1">Questions about the conversation, customer, KB lookups, draft replies...</p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={clsx(
                    "max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed",
                    msg.role === "user"
                      ? "bg-violet-500 text-white rounded-br-sm"
                      : "bg-gray-100 text-gray-700 rounded-bl-sm"
                  )}>
                    {msg.content.split("\n").map((line, li) => (
                      <span key={li}>{line}{li < msg.content.split("\n").length - 1 && <br />}</span>
                    ))}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-xl rounded-bl-sm px-3 py-2">
                    <div className="flex gap-1">
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* Chat input */}
            <div className="bg-gray-50/30 p-2.5">
              <form onSubmit={handleChatSubmit} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask the AI..."
                  disabled={chatLoading}
                  className="flex-1 px-3 py-2 bg-gray-50/80 border-0 ring-1 ring-gray-200/60 rounded-lg text-base md:text-xs focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={chatLoading || !chatInput.trim()}
                  className="w-8 h-8 bg-violet-500 hover:bg-violet-600 text-white rounded-lg flex items-center justify-center transition disabled:opacity-40 shrink-0"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </button>
              </form>
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 bg-gray-50/30">
        <p className="text-[10px] text-gray-400 text-center">
          AI suggestions are for reference only. Always review before sending.
        </p>
      </div>
    </div>
  );
}
