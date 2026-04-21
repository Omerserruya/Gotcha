"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getAISuggestions, getAISummary, sendCopilotChat, getConversationIntelligence } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import clsx from "clsx";

interface CoPilotPanelProps {
  conversation: any;
  messages: any[];
  onInsertReply: (text: string) => void;
  onClose?: () => void;
  onAiLoadingChange?: (loading: boolean) => void;
  onTopSuggestion?: (suggestion: { text: string; label: string; confidence: number } | null) => void;
  onScrollToReplies?: () => void;
  repliesRef?: React.RefObject<HTMLDivElement>;
}

interface ThinkingStep {
  id: string;
  label: string;
  status: "completed" | "active" | "pending";
  detail?: string;
}

// NOTE: deriveConversationIntelligence() used to live here as a client-side
// English-keyword regex fallback. It produced the "generic English placeholder
// suggestions" that flashed before the real backend intelligence arrived —
// regardless of tenant system language (Hebrew/Arabic/etc) — which the product
// owner called "worst UX ever". Deleted. Downstream values (effectiveIntent,
// effectiveSentiment, effectivePriority) now come from realIntelligence only.
// When realIntelligence is null the sidebar shows a loading skeleton instead
// of fake data. See memory/bug_f5_copilot_not_mounted.md Bug 11.

const INITIAL_THINKING_STEPS: ThinkingStep[] = [
  { id: "read", label: "readingConversation", status: "pending" },
  { id: "intent", label: "analyzingIntent", status: "pending" },
  { id: "kb", label: "searchingKB", status: "pending" },
  { id: "data", label: "fetchingData", status: "pending" },
  { id: "gen", label: "generatingSuggestions", status: "pending" },
];

export function CoPilotPanel({ conversation, messages, onInsertReply, onClose, onAiLoadingChange, onTopSuggestion, repliesRef }: CoPilotPanelProps) {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<"suggest" | "chat">("suggest");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [customerContextCollapsed, setCustomerContextCollapsed] = useState(false);

  // Chat mode state
  type ChatMsg = { role: "user" | "assistant"; content: string };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // AI-powered state
  const [aiSuggestions, setAiSuggestions] = useState<{ text: string; label: string; confidence: number; type: "reply" | "action" | "info" }[] | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [copilotMode, setCopilotMode] = useState<string>("READY_MESSAGE");
  const [paused, setPaused] = useState(false);

  // Whether a real AI provider is configured (not stub)
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);

  // Real intelligence from backend
  const [realIntelligence, setRealIntelligence] = useState<{
    detectedIntent: string;
    intentConfidence: number;
    sentiment: string;
    sentimentScore: number;
    customerEffort: number;
    resolutionOutcome: string;
    toolsUsed: number[];
  } | null>(null);

  // Thinking process state
  const [thinkingSteps, setThinkingSteps] = useState<ThinkingStep[]>(INITIAL_THINKING_STEPS);
  const [thinkingVisible, setThinkingVisible] = useState(false);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [visibleStepIds, setVisibleStepIds] = useState<Set<string>>(new Set());


  // Reset stale state when conversation changes so mock data doesn't flash
  useEffect(() => {
    setRealIntelligence(null);
    setAiSuggestions(null);
    setAiSummary(null);
    setAiConfigured(null);
    setThinkingVisible(false);
    setAnalysisComplete(false);
    setVisibleStepIds(new Set());
    setThinkingSteps(INITIAL_THINKING_STEPS);
    setChatMessages([]);
  }, [conversation?.id]);

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

  // realIntelligence populated asynchronously from the backend — no local
  // English-keyword fallback. Downstream effective* values are null-safe.

  // Only show real AI suggestions — no demo/mock fallback
  const suggestions = aiSuggestions || [];
  const summary = aiSummary || null;

  // Expose top suggestion to parent for smart popup (only when AI is configured)
  useEffect(() => {
    if (aiConfigured === false) {
      onTopSuggestion?.(null);
      return;
    }
    if (onTopSuggestion && suggestions.length > 0) {
      const best = suggestions.reduce((a, b) => a.confidence > b.confidence ? a : b);
      onTopSuggestion(best.confidence > 85 ? best : null);
    } else {
      onTopSuggestion?.(null);
    }
  }, [suggestions, onTopSuggestion, aiConfigured]);

  // Helper: update a single thinking step status
  const completeStep = useCallback((stepId: string) => {
    setThinkingSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, status: "completed" } : s))
    );
  }, []);

  const activateStep = useCallback((stepId: string) => {
    setVisibleStepIds((prev) => { const next = new Set(prev); next.add(stepId); return next; });
    setThinkingSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, status: "active" } : s))
    );
  }, []);

  // Fetch AI suggestions when conversation/messages change
  const fetchAI = useCallback(async () => {
    if (!token || !conversation?.id || paused) return;
    setAiLoading(true);

    try {
      // Step 1: Check suggestions first to detect if AI is configured
      const suggestionsRes = await getAISuggestions(token, conversation.id, locale).catch(() => null);

      if (suggestionsRes?.data && suggestionsRes.data.length > 0) {
        const isStub = suggestionsRes.data.length === 1 && suggestionsRes.data[0].type === "info";
        if (isStub) {
          // No AI employee configured — skip all other calls
          setAiConfigured(false);
          setAiLoading(false);
          return;
        }
        setAiConfigured(true);
        setAiSuggestions(suggestionsRes.data.map((s: any, i: number) => ({
          text: s.text,
          type: (s.type as "reply" | "action" | "info") || "reply",
          label: s.type === "reply" ? `${t("copilot.panel.aiReplyLabel")} ${i + 1}` : s.type === "action" ? t("copilot.panel.actionLabel") : t("copilot.panel.infoLabel"),
          confidence: Math.round(s.confidence * 100),
        })));
      } else {
        setAiConfigured(false);
        setAiLoading(false);
        return;
      }

      if (suggestionsRes?.copilotMode) setCopilotMode(suggestionsRes.copilotMode);

      // AI is configured — now fetch intelligence + summary in parallel with real thinking steps
      setThinkingVisible(true);
      setAnalysisComplete(false);
      setVisibleStepIds(new Set(["read"]));
      setThinkingSteps(INITIAL_THINKING_STEPS.map((s) => (s.id === "read" ? { ...s, status: "active" } : { ...s, status: "pending" })));

      activateStep("intent");
      activateStep("kb");
      const [intelligenceRes, summaryRes] = await Promise.all([
        getConversationIntelligence(token, conversation.id).catch(() => null),
        getAISummary(token, conversation.id, locale).catch(() => null),
      ]);

      // Intelligence result
      completeStep("read");
      activateStep("data");
      if (intelligenceRes?.data) {
        setRealIntelligence({
          detectedIntent: intelligenceRes.data.detectedIntent || "general",
          intentConfidence: intelligenceRes.data.intentConfidence || 0,
          sentiment: intelligenceRes.data.sentiment || "neutral",
          sentimentScore: intelligenceRes.data.sentimentScore || 0,
          customerEffort: intelligenceRes.data.customerEffort || 0,
          resolutionOutcome: intelligenceRes.data.resolutionOutcome || "open",
          toolsUsed: intelligenceRes.data.toolsUsed || [],
        });
      }
      completeStep("intent");
      completeStep("data");
      completeStep("kb");

      // Summary result
      activateStep("gen");
      if (summaryRes?.copilotMode && !suggestionsRes?.copilotMode) setCopilotMode(summaryRes.copilotMode);
      if (summaryRes?.data?.summary && summaryRes.data.summary !== "AI summarization not configured.") {
        setAiSummary(summaryRes.data.summary);
      }
      completeStep("gen");
    } catch {
      setAiConfigured(false);
    } finally {
      setAiLoading(false);
      // Mark all steps complete and show findings
      setThinkingSteps((prev) => prev.map((s) => ({ ...s, status: "completed" })));
      setVisibleStepIds(new Set(INITIAL_THINKING_STEPS.map((s) => s.id)));
      setAnalysisComplete(true);
    }
  }, [token, conversation?.id, paused, activateStep, completeStep, t, locale]);

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

  function handleInsert(text: string, idx: number) {
    onInsertReply(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }

  async function handleActionExecute(actionText: string, idx: number) {
    // Send the action to copilot chat for AI-driven execution via tools
    if (!token || !conversation?.id || chatLoading) return;
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
    setActiveTab("chat");
    const msg = `Execute action: ${actionText}`;
    const updated = [...chatMessages, { role: "user" as const, content: msg }];
    setChatMessages(updated);
    setChatLoading(true);
    try {
      const res = await sendCopilotChat(token, conversation.id, { message: msg, history: chatMessages, locale });
      setChatMessages([...updated, { role: "assistant" as const, content: res.data.reply }]);
    } catch (_err) {
      setChatMessages([...updated, { role: "assistant" as const, content: t("copilot.panel.chat.failedResponse") }]);
    } finally {
      setChatLoading(false);
    }
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
      const res = await sendCopilotChat(token, conversation.id, { message: msg, history: chatMessages, locale });
      setChatMessages([...updated, { role: "assistant" as const, content: res.data.reply }]);
    } catch (_err) {
      setChatMessages([...updated, { role: "assistant" as const, content: t("copilot.panel.chat.failedResponse") }]);
    } finally {
      setChatLoading(false);
    }
  }

  // Real backend intelligence only — no local keyword fallback. When
  // realIntelligence is null we leave effective* unset so the render path
  // can show a skeleton instead of fake localized-to-English data.
  const effectiveSentiment = realIntelligence?.sentiment ?? null;
  const effectiveIntent = realIntelligence?.detectedIntent ?? null;
  const effectiveConfidence = realIntelligence?.intentConfidence ?? 0;
  const effectiveEffort = realIntelligence?.customerEffort ?? 0;
  const effectivePriority: "high" | "medium" | "low" | null = realIntelligence
    ? (realIntelligence.customerEffort >= 4 ? "high" : realIntelligence.customerEffort >= 2 ? "medium" : "low")
    : null;

  const sentimentLabel = effectiveSentiment === "positive"
    ? t("copilot.panel.sentiments.positive")
    : effectiveSentiment === "negative"
    ? t("copilot.panel.sentiments.slightlyNegative")
    : effectiveSentiment === "neutral"
    ? t("copilot.panel.sentiments.neutral")
    : "";
  const sentimentColor = effectiveSentiment === "positive" ? "text-green-600" : effectiveSentiment === "negative" ? "text-red-500" : "text-gray-400";
  const priorityLabel = effectivePriority === "high"
    ? t("copilot.panel.priorities.high")
    : effectivePriority === "low"
    ? t("copilot.panel.priorities.low")
    : effectivePriority === "medium"
    ? t("copilot.panel.priorities.medium")
    : "";
  const priorityColor = effectivePriority === "high" ? "text-red-500" : effectivePriority === "low" ? "text-gray-400" : "text-amber-500";


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
          <p className="text-sm font-semibold text-gray-900">{t("copilot.panel.title")}</p>
          <p className="text-[10px] text-gray-400">{aiSuggestions ? t("copilot.panel.aiPowered") : aiConfigured === false ? t("copilot.panel.notConfigured") : t("copilot.panel.demoMode")}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Regenerate button (shown when last message is outbound) */}
          {lastIsOutbound && !paused && (
            <button
              onClick={() => fetchAI()}
              className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg bg-violet-50 text-violet-600 hover:bg-violet-100 transition"
              title={t("copilot.panel.regenerate")}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M2.985 14.652" />
              </svg>
              {t("copilot.panel.regenerate")}
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
            title={paused ? t("copilot.panel.resumeCoPilot") : t("copilot.panel.pauseCoPilot")}
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
            {paused ? t("copilot.panel.paused") : t("copilot.panel.pause")}
          </button>

          <div className="flex items-center gap-0.5">
            {paused ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400"></span>
                </span>
                <span className="text-[10px] text-amber-500 font-medium ml-1">{t("copilot.panel.paused")}</span>
              </>
            ) : aiLoading ? (
              <div className="w-3 h-3 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
            ) : (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                <span className="text-[10px] text-green-600 font-medium ml-1">{t("copilot.panel.live")}</span>
              </>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="md:hidden w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
              aria-label={t("copilot.panel.closeCoPilot")}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Tabs — hidden when no AI Employee */}
      {aiConfigured !== false && <div className="flex bg-gray-50/50">
        <button
          onClick={() => setActiveTab("suggest")}
          className={clsx(
            "flex-1 py-2.5 text-xs font-medium transition-all relative",
            activeTab === "suggest"
              ? "text-primary-600"
              : "text-gray-400 hover:text-gray-600"
          )}
        >
          {t("copilot.panel.tabs.suggestions")}
          {activeTab === "suggest" && (
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
          {t("copilot.panel.tabs.aiChat")}
          {activeTab === "chat" && (
            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary-500 rounded-full" />
          )}
        </button>
      </div>}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {aiConfigured === false && !aiLoading ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center max-w-[260px]">
              <div className="w-14 h-14 bg-gradient-to-br from-violet-100 to-purple-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <p className="text-sm font-semibold text-gray-800 mb-1.5">{t("copilot.panel.noAiEmployee.title")}</p>
              <p className="text-xs text-gray-500 leading-relaxed mb-4">{t("copilot.panel.noAiEmployee.description")}</p>
              <a
                href="/ai-studio"
                className="inline-flex items-center gap-1.5 px-5 py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 rounded-xl hover:from-violet-600 hover:to-purple-700 transition-all shadow-md shadow-violet-300/40"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
                {t("copilot.panel.noAiEmployee.setupButton")}
              </a>
            </div>
          </div>
        ) : activeTab === "suggest" ? (
          <div className="p-3 space-y-3">

            {/* AI Analysis / Thinking Process */}
            {thinkingVisible && (
              <div className="rounded-xl border border-violet-100 bg-white shadow-sm overflow-hidden transition-all duration-300">
                {/* Analysis header */}
                <button
                  onClick={() => setAnalysisCollapsed((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2.5 bg-gradient-to-r from-violet-50 to-purple-50 hover:from-violet-100/60 hover:to-purple-100/60 transition-all"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-violet-500 text-sm leading-none">✦</span>
                    <span className="text-[11px] font-semibold text-violet-700">{t("copilot.panel.analysis.title")}</span>
                    {aiLoading && (
                      <div className="w-2.5 h-2.5 border-[1.5px] border-violet-200 border-t-violet-500 rounded-full animate-spin ml-0.5" />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-violet-400 font-medium">
                      {analysisCollapsed ? t("copilot.panel.analysis.show") : t("copilot.panel.analysis.hide")}
                    </span>
                    <svg
                      className={clsx("w-3.5 h-3.5 text-violet-400 transition-transform duration-200", analysisCollapsed ? "-rotate-90" : "rotate-0")}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </div>
                </button>

                {/* Collapsible body */}
                <div className={clsx("transition-all duration-300 overflow-hidden", analysisCollapsed ? "max-h-0" : "max-h-[600px]")}>
                  <div className="px-3 pt-2.5 pb-3 space-y-1.5">
                    {/* Steps */}
                    {INITIAL_THINKING_STEPS.map((step, idx) => {
                      const current = thinkingSteps.find((s) => s.id === step.id);
                      const isVisible = visibleStepIds.has(step.id);
                      return (
                        <div
                          key={step.id}
                          className={clsx(
                            "flex items-center gap-2 transition-all duration-300",
                            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
                          )}
                          style={{ transitionDelay: isVisible ? `${idx * 30}ms` : "0ms" }}
                        >
                          {/* Status icon */}
                          {current?.status === "completed" ? (
                            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                              <svg className="w-3.5 h-3.5 text-green-500 transition-all duration-200 scale-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                              </svg>
                            </span>
                          ) : current?.status === "active" ? (
                            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                              <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse inline-block" />
                            </span>
                          ) : (
                            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                              <span className="w-2 h-2 rounded-full bg-gray-200 inline-block" />
                            </span>
                          )}
                          <span className={clsx(
                            "text-[11px] transition-colors duration-200",
                            current?.status === "completed" ? "text-gray-600" :
                            current?.status === "active" ? "text-violet-700 font-medium" :
                            "text-gray-300"
                          )}>
                            {t(`copilot.panel.thinking.${step.label}`)}
                            {current?.status === "active" && (
                              <span className="text-violet-400">...</span>
                            )}
                          </span>
                        </div>
                      );
                    })}

                    {/* Findings card - shown when analysis is complete */}
                    {analysisComplete && (
                      <div className="mt-3 bg-gradient-to-br from-violet-50 to-purple-50 rounded-xl p-3 transition-all duration-300">
                        <p className="text-[10px] font-semibold text-violet-600 uppercase tracking-wider mb-2">{t("copilot.panel.analysis.findings")}</p>
                        <div className="space-y-1.5">
                          <div className="flex items-baseline justify-between">
                            <span className="text-[11px] text-gray-400">{t("copilot.panel.analysis.intent")}</span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] font-medium text-gray-700">{t(`copilot.panel.intents.${effectiveIntent}`) || effectiveIntent}</span>
                              {effectiveConfidence > 0 && (
                                <span className={clsx("text-[9px] font-semibold px-1.5 py-0.5 rounded-full", effectiveConfidence > 0.7 ? "bg-green-50 text-green-600" : effectiveConfidence > 0.4 ? "bg-yellow-50 text-yellow-600" : "bg-gray-100 text-gray-500")}>
                                  {Math.round(effectiveConfidence * 100)}%
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-baseline justify-between">
                            <span className="text-[11px] text-gray-400">{t("copilot.panel.analysis.sentiment")}</span>
                            <span className={clsx("text-[11px] font-medium", sentimentColor)}>{sentimentLabel}</span>
                          </div>
                          <div className="flex items-baseline justify-between">
                            <span className="text-[11px] text-gray-400">{t("copilot.panel.analysis.priority")}</span>
                            <span className={clsx("text-[11px] font-medium", priorityColor)}>{priorityLabel}</span>
                          </div>
                          {messages.length > 0 && (
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-[11px] text-gray-400 shrink-0">{t("copilot.panel.analysis.context")}</span>
                              <span className="text-[11px] text-gray-600 text-right">{messages.length} {messages.length !== 1 ? t("copilot.panel.analysis.msgs") : t("copilot.panel.analysis.msg")}, {t("copilot.panel.analysis.lastInbound")} {(() => {
                                const li = [...messages].reverse().find((m) => m.direction === "INBOUND");
                                if (!li) return t("copilot.panel.analysis.na");
                                const preview = (li.body || "").slice(0, 28);
                                return `"${preview}${li.body?.length > 28 ? "…" : ""}"`;
                              })()}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                  </div>
                </div>
              </div>
            )}

            {/* Section 2: Context */}
            {/* Context summary card */}
            {summary && <div className="bg-gradient-to-br from-primary-50/80 to-violet-50/80 rounded-xl p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <svg className="w-3.5 h-3.5 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                </svg>
                <span className="text-[10px] font-semibold text-primary-600 uppercase tracking-wider">{t("copilot.panel.contextSection.title")}</span>
              </div>
              <div className="text-xs text-gray-600 leading-relaxed prose prose-xs prose-gray max-w-none [&_ul]:mt-0 [&_ul]:mb-0 [&_li]:my-0.5 [&_p]:my-0.5 [&_strong]:text-gray-800">
                <ReactMarkdown>{summary}</ReactMarkdown>
              </div>
            </div>}

            {/* Suggested replies */}
            {suggestions.length > 0 && <div ref={repliesRef}>
              <div className="flex items-center gap-1.5 mb-2 px-0.5">
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t("copilot.panel.suggestedReplies.title")}</span>
                {aiSuggestions && (
                  <span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full font-medium">AI</span>
                )}
              </div>
              <div className="space-y-2">
                {suggestions.map((s, i) => {
                  const isContextOnly = copilotMode === "CONTEXT_ONLY";
                  const isAction = s.type === "action";
                  const isInfo = s.type === "info";
                  const isReadOnly = isContextOnly || isInfo;
                  const Wrapper = isReadOnly ? "div" : "button";
                  const handleClick = isAction
                    ? () => handleActionExecute(s.text, i)
                    : () => handleInsert(s.text, i);
                  return (
                    <Wrapper
                      key={i}
                      {...(!isReadOnly ? { onClick: handleClick } : {})}
                      className={clsx("w-full text-start", !isReadOnly && "group")}
                    >
                      <div className={clsx(
                        "rounded-xl p-3 transition-all",
                        copiedIdx === i
                          ? "bg-green-50 shadow-subtle"
                          : isReadOnly
                            ? "bg-gray-50"
                            : isAction
                              ? "bg-amber-50/50 shadow-subtle hover:shadow-panel hover:-translate-y-px hover:bg-amber-50"
                              : "bg-white shadow-subtle hover:shadow-panel hover:-translate-y-px hover:bg-primary-50/50"
                      )}>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-1.5">
                            {isAction && (
                              <svg className="w-3 h-3 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                              </svg>
                            )}
                            <span className={clsx("text-[10px] font-semibold", isAction ? "text-amber-600" : "text-primary-500")}>{s.label}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <div className="flex items-center gap-1">
                              <div className="flex items-center gap-0.5">
                                <div className={clsx(
                                  "h-1 rounded-full transition-all",
                                  s.confidence > 80 ? "bg-green-400 w-8" :
                                  s.confidence >= 50 ? "bg-yellow-400 w-5" :
                                  "bg-red-400 w-3"
                                )} />
                              </div>
                              <span className={clsx(
                                "text-[9px] font-semibold px-1.5 py-0.5 rounded-full",
                                s.confidence > 80 ? "bg-green-50 text-green-600" :
                                s.confidence >= 50 ? "bg-yellow-50 text-yellow-600" :
                                "bg-red-50 text-red-500"
                              )}>
                                {s.confidence}% {t("copilot.panel.suggestedReplies.confident")}
                              </span>
                            </div>
                            {!isReadOnly && (
                              copiedIdx === i ? (
                                <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                              ) : isAction ? (
                                <svg className="w-3.5 h-3.5 text-amber-300 group-hover:text-amber-500 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
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
            </div>}

            {/* Section 3: Customer Data */}
            {conversation && (
              <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
                {/* Collapsible header */}
                <button
                  onClick={() => setCustomerContextCollapsed((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2.5 bg-gray-50 hover:bg-gray-100/60 transition-all"
                >
                  <div className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                    </svg>
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t("copilot.panel.customerContext.title")}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-gray-400">{customerContextCollapsed ? t("copilot.panel.customerContext.show") : t("copilot.panel.customerContext.hide")}</span>
                    <svg
                      className={clsx("w-3.5 h-3.5 text-gray-400 transition-transform duration-200", customerContextCollapsed ? "-rotate-90" : "rotate-0")}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </div>
                </button>

                {/* Collapsible body */}
                <div className={clsx("transition-all duration-300 overflow-hidden", customerContextCollapsed ? "max-h-0" : "max-h-[300px]")}>
                  <div className="px-3 pt-2 pb-3 space-y-2">
                    {/* Name */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.name")}</span>
                      <span className="text-[11px] font-medium text-gray-700">{conversation.customerName || t("copilot.panel.customerContext.unknown")}</span>
                    </div>
                    {/* Phone */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.phone")}</span>
                      <span className="text-[11px] font-medium text-gray-700">{conversation.customerPhone || "—"}</span>
                    </div>
                    {/* Total conversations (mock) */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.conversations")}</span>
                      <span className="text-[11px] font-medium text-gray-700">
                        12 <span className="text-[10px] text-violet-500 font-semibold">({t("copilot.panel.customerContext.vip")})</span>
                      </span>
                    </div>
                    {/* Sentiment */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.sentiment")}</span>
                      <div className="flex items-center gap-1">
                        <span className={clsx(
                          "w-2 h-2 rounded-full",
                          effectiveSentiment === "positive" ? "bg-green-500" :
                          effectiveSentiment === "negative" ? "bg-red-500" :
                          "bg-gray-400"
                        )} />
                        <span className={clsx(
                          "text-[11px] font-medium",
                          effectiveSentiment === "positive" ? "text-green-600" :
                          effectiveSentiment === "negative" ? "text-red-500" :
                          "text-gray-500"
                        )}>
                          {effectiveSentiment === "positive" ? t("copilot.panel.customerContext.happy") :
                           effectiveSentiment === "negative" ? t("copilot.panel.customerContext.angry") : t("copilot.panel.customerContext.neutral")}
                        </span>
                      </div>
                    </div>
                    {/* Channel badge */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.channel")}</span>
                      {(() => {
                        const ch = (conversation.channel || conversation.channelType || "").toUpperCase();
                        const isWhatsApp = ch.includes("WHATSAPP");
                        const isInstagram = ch.includes("INSTAGRAM");
                        return (
                          <span className={clsx(
                            "text-[10px] font-semibold px-2 py-0.5 rounded-full",
                            isWhatsApp ? "bg-green-50 text-green-600" :
                            isInstagram ? "bg-pink-50 text-pink-600" :
                            "bg-blue-50 text-blue-600"
                          )}>
                            {isWhatsApp ? "WhatsApp" : isInstagram ? "Instagram" : t("copilot.panel.customerContext.web")}
                          </span>
                        );
                      })()}
                    </div>
                    {/* Status */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.status")}</span>
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
                  <p className="text-xs text-gray-500 font-medium">{t("copilot.panel.chat.askAnything")}</p>
                  <p className="text-[10px] text-gray-400 mt-1">{t("copilot.panel.chat.askHint")}</p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[85%]">
                    <div className={clsx(
                      "rounded-xl px-3 py-2 text-xs leading-relaxed",
                      msg.role === "user"
                        ? "bg-violet-500 text-white rounded-br-sm"
                        : "bg-gray-100 text-gray-700 rounded-bl-sm"
                    )}>
                      {msg.role === "assistant" ? (
                        <div className="prose prose-xs prose-gray max-w-none [&_ul]:mt-0 [&_ul]:mb-0 [&_li]:my-0.5 [&_p]:my-0.5 [&_strong]:text-gray-800">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        msg.content.split("\n").map((line, li) => (
                          <span key={li}>{line}{li < msg.content.split("\n").length - 1 && <br />}</span>
                        ))
                      )}
                    </div>
                    {msg.role === "assistant" && (
                      <button
                        onClick={() => onInsertReply(msg.content)}
                        className="mt-1 flex items-center gap-1 text-[10px] font-medium text-violet-500 hover:text-violet-700 transition px-1"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m0 0l6.75-6.75M12 19.5l-6.75-6.75" />
                        </svg>
                        {t("copilot.panel.chat.useAsReply")}
                      </button>
                    )}
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
                  placeholder={t("copilot.panel.chat.inputPlaceholder")}
                  disabled={chatLoading || aiConfigured === false}
                  className="flex-1 px-3 py-2 bg-gray-50/80 border-0 ring-1 ring-gray-200/60 rounded-lg text-base md:text-xs focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={chatLoading || !chatInput.trim() || aiConfigured === false}
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
          {t("copilot.panel.footer")}
        </p>
      </div>
    </div>
  );
}
