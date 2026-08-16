"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getAISuggestions, getAISummary, sendCopilotChat, getConversationIntelligence } from "@/lib/api";
import { createCrmLeadForConversation, pickCrmCandidate, type CrmContextEnvelope } from "@/lib/api-crm";
import ReactMarkdown from "react-markdown";
import clsx from "clsx";

interface CoPilotPanelProps {
  /** When false, the panel is mounted but rendered as `display:none` so the AI
   *  suggestion + intelligence fetch effects keep running in the background.
   *  The chat surface uses this to show the floating popup without opening the
   *  full panel (especially important on mobile, where the panel is full-screen). */
  isOpen?: boolean;
  conversation: any;
  messages: any[];
  /** Rich CRM context envelope fetched once by ChatPanel - drives the Customer
   *  Context section (identity, deals, tickets, open issues, sentiment trend). */
  crmContext?: CrmContextEnvelope | null;
  crmLoading?: boolean;
  /** Re-fetch CRM context after a side effect (e.g. user clicked "Create lead"
   *  or picked a CRM candidate from the disambiguation list). */
  onRefetchCrm?: () => void | Promise<void>;
  onInsertReply: (text: string) => void;
  onClose?: () => void;
  /** Called when the panel needs to expand from a closed state (e.g. user taps
   *  "All suggestions" on the floating bubble while the panel is hidden). */
  onOpen?: () => void;
  onAiLoadingChange?: (loading: boolean) => void;
  onTopSuggestion?: (suggestion: { text: string; label: string; confidence: number } | null) => void;
  onScrollToReplies?: () => void;
  repliesRef?: React.RefObject<HTMLDivElement>;
  /**
   * Quote forwarded from ChatPanel's "Ask Co-Pilot" selection action.
   * `version` lets us re-trigger the prefill effect when the agent marks
   * the same text twice in a row (without `version`, React would diff the
   * object as equal). When non-null we switch to the chat tab and seed
   * `chatInput` with a markdown blockquote of the customer's words.
   */
  prefillQuote?: { quote: string; version: number } | null;
}

interface ThinkingStep {
  id: string;
  label: string;
  status: "completed" | "active" | "pending";
  detail?: string;
}

// NOTE: deriveConversationIntelligence() used to live here as a client-side
// English-keyword regex fallback. It produced the "generic English placeholder
// suggestions" that flashed before the real backend intelligence arrived -
// regardless of tenant system language (Hebrew/Arabic/etc) - which the product
// owner called "worst UX ever". Deleted. Downstream values (effectiveIntent,
// effectiveSentiment, effectivePriority) now come from realIntelligence only.
// When realIntelligence is null the sidebar shows a loading skeleton instead
// of fake data. See memory/bug_f5_copilot_not_mounted.md Bug 11.

/**
 * Detect the language the agent typed their question in so the AI reply
 * matches. We only look at the question's own characters - the UI locale
 * is the fallback for short / ambiguous input (e.g. emoji-only or pure
 * numbers). Returns a BCP-47-ish code the backend understands.
 */
function detectQuestionLocale(text: string): string | null {
  if (!text || text.trim().length < 2) return null;
  // Hebrew & Arabic detect by Unicode block - most common non-English cases.
  if (/[֐-׿]/.test(text)) return "he";
  if (/[؀-ۿݐ-ݿ]/.test(text)) return "ar";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja";
  // Latin-script: only treat as English when there are actual letters. Pure
  // numbers / punctuation fall back to the UI locale.
  if (/[A-Za-z]/.test(text)) return "en";
  return null;
}

const INITIAL_THINKING_STEPS: ThinkingStep[] = [
  { id: "read", label: "readingConversation", status: "pending" },
  { id: "intent", label: "analyzingIntent", status: "pending" },
  { id: "kb", label: "searchingKB", status: "pending" },
  { id: "data", label: "fetchingData", status: "pending" },
  { id: "gen", label: "generatingSuggestions", status: "pending" },
];

/**
 * Set once the AI service answers "your plan does not include the co-pilot".
 * See the note at `aiSuggestions` for why this is module scope and not state.
 */
let copilotDeniedForSession = false;

/** Exported for tests, and for a future entitlements provider to reset. */
export function __resetCopilotDenial() {
  copilotDeniedForSession = false;
}

export function CoPilotPanel({ isOpen = true, conversation, messages, crmContext, crmLoading, onRefetchCrm, onInsertReply, onClose, onAiLoadingChange, onTopSuggestion, repliesRef, prefillQuote }: CoPilotPanelProps) {
  const { token } = useAuth();
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<"suggest" | "chat">("suggest");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [customerContextCollapsed, setCustomerContextCollapsed] = useState(false);

  // Chat mode state.
  //
  // ChatMsg.referenceQuote is the customer-quoted snippet the agent was asking
  // about (only set when the agent submitted via the "Ask Co-Pilot" handoff).
  // It is rendered as a small gray reference block ABOVE the user bubble - it
  // is NOT part of `content`, so the bubble itself shows only the agent's
  // question. The Context preamble is still woven into the outbound payload
  // (`msg`) so the backend AI sees the snippet.
  type ChatMsg = { role: "user" | "assistant"; content: string; referenceQuote?: string };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // "Ask Co-Pilot on selection" handoff. Each new prefillQuote.version
  // switches the panel to chat mode and pins the quote as a REFERENCE banner
  // above the composer - NOT as text in the textarea. The banner stays until
  // the agent dismisses it (X button), so they can fire multiple follow-up
  // questions about the same snippet. On submit, the quote is woven into the
  // outgoing message as a small "Context:" preamble so the AI sees what the
  // agent is referring to.
  const [referenceQuote, setReferenceQuote] = useState<string | null>(null);
  useEffect(() => {
    if (!prefillQuote || !prefillQuote.quote) return;
    setActiveTab("chat");
    setReferenceQuote(prefillQuote.quote);
  }, [prefillQuote?.version]);

  // AI-powered state
  // A plan denial is a property of the WORKSPACE, not of this conversation, so
  // it is remembered for the session instead of being rediscovered per chat.
  //
  // The panel is mounted for every conversation the agent opens, whether or not
  // it is visible, and `fetchAI` had no idea the co-pilot was unavailable - so
  // a workspace whose plan excludes it fired one suggestions request per
  // conversation, forever, each one travelling to the AI service only to be
  // refused by `requireEntitlement("ai.copilot")`. No AI was spent (the gate
  // runs before the handler), but nothing stopped the asking either.
  //
  // Module scope, not state: it must survive the remount that happens when the
  // agent moves to the next conversation, which is exactly when the repeat
  // request was being made. Cleared on reload, so granting the entitlement
  // takes effect without any invalidation plumbing.
  const [aiSuggestions, setAiSuggestions] = useState<{ text: string; label: string; confidence: number; type: "reply" | "action" | "info"; approach?: string; rationale?: string }[] | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [copilotMode, setCopilotMode] = useState<string>("READY_MESSAGE");
  const [paused, setPaused] = useState(false);

  // Whether a real AI provider is configured (not stub)
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  /**
   * WHY the co-pilot is unavailable, which is not the same question as whether
   * it is. Every failure used to collapse into "no AI employee configured": a
   * plan that does not include the co-pilot, a provider error, the org
   * switching it off, and an actual missing employee all rendered the same
   * panel, telling someone to go and build an employee they already had.
   */
  const [unavailableReason, setUnavailableReason] =
    useState<"plan" | "disabled" | "error" | "no_employee" | null>(null);

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

  // realIntelligence populated asynchronously from the backend - no local
  // English-keyword fallback. Downstream effective* values are null-safe.

  // Only show real AI suggestions - no demo/mock fallback
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

  // Per-panel AbortController for the in-flight fetchAI round. When a new
  // customer message arrives during the 1.5s debounce window we abort the
  // older fetch - without this, two concurrent fetchAI calls race and the
  // slower one stomps the faster one's results into the panel.
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Fetch AI suggestions when conversation/messages change
  const fetchAI = useCallback(async () => {
    if (!token || !conversation?.id || paused) return;
    // Already refused for this workspace - do not ask again for every
    // conversation the agent opens. The panel still explains itself below.
    if (copilotDeniedForSession) {
      setUnavailableReason("plan");
      setAiConfigured(false);
      setAiLoading(false);
      return;
    }
    // Abort any older in-flight fetch BEFORE installing a new controller.
    if (fetchAbortRef.current && !fetchAbortRef.current.signal.aborted) {
      fetchAbortRef.current.abort();
    }
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    const { signal } = ctrl;
    // Per-invocation idempotency key. The backend dedup layer
    // (services/ai/src/services/copilot-dedup.service.ts) collapses
    // concurrent calls for the same conversationId into one execution
    // AND short-circuits repeated requests sharing this id within 60s.
    // A retried request reuses the same id (good - dedup applies). A
    // distinct user-meaningful trigger generates a fresh id.
    const requestInstanceId =
      typeof crypto !== "undefined" && (crypto as any).randomUUID
        ? (crypto as any).randomUUID()
        : `ri_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    setAiLoading(true);

    try {
      // Step 1: Check suggestions first to detect if AI is configured
      // A holder rather than a `let`: assigned inside a callback, TypeScript's
      // flow analysis still believes the variable is null at the point of use
      // and narrows it to `never`.
      const suggestionsErr: { current: (Error & { status?: number; code?: string; body?: any }) | null } = { current: null };
      const suggestionsRes = await getAISuggestions(token, conversation.id, locale, signal, requestInstanceId).catch((e) => {
        suggestionsErr.current = e;
        return null;
      });
      if (signal.aborted) return;

      if (suggestionsRes?.data && suggestionsRes.data.length > 0) {
        // The backend answers several different things with a single `info`
        // item, and they mean different things to the person reading the panel.
        // "no-match" in particular is a real answer - the co-pilot looked and
        // had nothing useful to add - and treating it as a broken setup was
        // telling people to reconfigure a working product.
        const only = suggestionsRes.data.length === 1 && suggestionsRes.data[0].type === "info"
          ? String(suggestionsRes.data[0].id ?? "")
          : null;
        if (only === "no-config" || only === "stub-1") {
          setUnavailableReason("no_employee");
          setAiConfigured(false);
          setAiLoading(false);
          return;
        }
        if (only === "disabled") {
          setUnavailableReason("disabled");
          setAiConfigured(false);
          setAiLoading(false);
          return;
        }
        if (only === "error") {
          setUnavailableReason("error");
          setAiConfigured(false);
          setAiLoading(false);
          return;
        }
        setUnavailableReason(null);
        setAiConfigured(true);
        setAiSuggestions(suggestionsRes.data.map((s: any, i: number) => ({
          text: s.text,
          type: (s.type as "reply" | "action" | "info") || "reply",
          label: s.type === "reply" ? `${t("copilot.panel.aiReplyLabel")} ${i + 1}` : s.type === "action" ? t("copilot.panel.actionLabel") : t("copilot.panel.infoLabel"),
          confidence: Math.round(s.confidence * 100),
          approach: typeof s.approach === "string" ? s.approach : undefined,
          rationale: typeof s.rationale === "string" ? s.rationale : undefined,
        })));
      } else {
        // Nothing came back. The reason is on the error the request threw, and
        // this is where "your plan does not include the co-pilot" used to be
        // rewritten into "you have not built an employee yet".
        const err = suggestionsErr.current;
        const status = err?.status;
        const code = err?.code ?? (err?.body as any)?.code;
        if (status === 402 || code === "PLAN_FEATURE_REQUIRED") {
          copilotDeniedForSession = true;
          setUnavailableReason("plan");
        } else if (err) {
          setUnavailableReason("error");
        } else {
          setUnavailableReason("no_employee");
        }
        setAiConfigured(false);
        setAiLoading(false);
        return;
      }

      if (suggestionsRes?.copilotMode) setCopilotMode(suggestionsRes.copilotMode);

      // AI is configured - now fetch intelligence + summary in parallel with real thinking steps
      setThinkingVisible(true);
      setAnalysisComplete(false);
      setVisibleStepIds(new Set(["read"]));
      setThinkingSteps(INITIAL_THINKING_STEPS.map((s) => (s.id === "read" ? { ...s, status: "active" } : { ...s, status: "pending" })));

      activateStep("intent");
      activateStep("kb");
      const [intelligenceRes, summaryRes] = await Promise.all([
        getConversationIntelligence(token, conversation.id, signal).catch(() => null),
        getAISummary(token, conversation.id, locale, signal).catch(() => null),
      ]);
      if (signal.aborted) return;

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

  // Re-fetch when messages change significantly (only on INBOUND).
  // Debounce: hold for 1500ms after the last inbound. If another inbound
  // arrives within that window, the cleanup clears the prior timer AND
  // the next fetchAI() call aborts any still-running AbortController from
  // the previous round - so we never end up with two concurrent fetches
  // or a stale reply landing on top of a fresh one.
  useEffect(() => {
    if (messages.length > 0 && !lastIsOutbound) {
      const timer = setTimeout(() => {
        // Abort the previous in-flight fetch BEFORE the new one starts -
        // fetchAI installs a fresh controller on entry, but doing it here
        // closes the window between "timer fires" and "fetchAI awaits".
        if (fetchAbortRef.current && !fetchAbortRef.current.signal.aborted) {
          fetchAbortRef.current.abort();
        }
        fetchAI();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [messages.length, lastIsOutbound]);

  // Cancel any in-flight fetch when the panel unmounts so we don't update
  // state on a torn-down component.
  useEffect(() => {
    return () => {
      if (fetchAbortRef.current && !fetchAbortRef.current.signal.aborted) {
        fetchAbortRef.current.abort();
      }
    };
  }, []);

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
    const agentQuestion = chatInput.trim();
    // When a reference quote is pinned, send it as a Context preamble so the
    // backend AI sees both the snippet the agent marked and the question
    // they're asking about it. The user-visible chat bubble shows ONLY the
    // agent's question - the quote is stored on `referenceQuote` and rendered
    // as a separate gray reference block above the bubble.
    const pinnedQuote = referenceQuote;
    const msg = pinnedQuote
      ? `Context - agent marked this customer text for reference:\n"${pinnedQuote}"\n\nAgent's question: ${agentQuestion}`
      : agentQuestion;
    // Reply in whatever language the agent typed in - falls back to the UI
    // locale when the question is too short or ambiguous to detect.
    const replyLocale = detectQuestionLocale(agentQuestion) ?? locale;
    setChatInput("");
    // Clear the pinned banner once the question is sent - the reference is
    // already carried on the user message (rendered as a gray label above the
    // bubble) so the input area resets for the next question. To re-attach
    // the same snippet, the agent re-selects it in the chat and clicks "Ask
    // Co-Pilot" again.
    setReferenceQuote(null);
    const userMsg: ChatMsg = {
      role: "user",
      content: agentQuestion,
      ...(pinnedQuote ? { referenceQuote: pinnedQuote } : {}),
    };
    const updated = [...chatMessages, userMsg];
    setChatMessages(updated);
    setChatLoading(true);
    try {
      const res = await sendCopilotChat(token, conversation.id, {
        message: msg,
        history: chatMessages,
        locale: replyLocale,
      });
      setChatMessages([...updated, { role: "assistant" as const, content: res.data.reply }]);
    } catch (_err) {
      setChatMessages([...updated, { role: "assistant" as const, content: t("copilot.panel.chat.failedResponse") }]);
    } finally {
      setChatLoading(false);
    }
  }

  // Real backend intelligence only - no local keyword fallback. When
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


  // When closed, keep the component mounted (so fetchAI effects continue to
  // populate the floating suggestion bubble in ChatPanel) but render nothing
  // visible. We intentionally do NOT use `display:none` because the panel
  // is also a flex sibling - collapsing it via early-return preserves the
  // chat panel's flex layout exactly as if the panel had never been opened.
  if (!isOpen) {
    return <span data-copilot-hidden aria-hidden style={{ display: "none" }} />;
  }

  return (
    <div className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto w-full md:w-[340px] bg-white flex flex-col h-full animate-slide-in-right" data-tour="copilot-panel">
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

      {/* Tabs - hidden when no AI Employee */}
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
              <p className="text-sm font-semibold text-gray-800 mb-1.5">
                {unavailableReason === "plan"
                  ? t("copilot.panel.planRequired.title")
                  : unavailableReason === "disabled"
                    ? t("copilot.panel.disabled.title")
                    : unavailableReason === "error"
                      ? t("copilot.panel.failed.title")
                      : t("copilot.panel.noAiEmployee.title")}
              </p>
              <p className="text-xs text-gray-500 leading-relaxed mb-4">
                {unavailableReason === "plan"
                  ? t("copilot.panel.planRequired.description")
                  : unavailableReason === "disabled"
                    ? t("copilot.panel.disabled.description")
                    : unavailableReason === "error"
                      ? t("copilot.panel.failed.description")
                      : t("copilot.panel.noAiEmployee.description")}
              </p>
              {/* Each reason gets its own destination, and a transient failure
                  gets no button at all - there is nowhere useful to send
                  someone whose provider call just failed. Sending people to
                  build an employee they already had was the whole bug. */}
              {unavailableReason !== "error" && (
              <a
                href={
                  unavailableReason === "plan"
                    ? "/settings/billing/plan"
                    : unavailableReason === "disabled"
                      ? "/settings/ai"
                      : "/ai-studio"
                }
                className="inline-flex items-center gap-1.5 px-5 py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 rounded-xl hover:from-violet-600 hover:to-purple-700 transition-all shadow-md shadow-violet-300/40"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
                {unavailableReason === "plan"
                  ? t("copilot.panel.planRequired.button")
                  : unavailableReason === "disabled"
                    ? t("copilot.panel.disabled.button")
                    : t("copilot.panel.noAiEmployee.setupButton")}
              </a>
              )}
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
            {suggestions.length > 0 && <div ref={repliesRef} data-tour="copilot-suggestions">
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
                        {(s.rationale || s.approach) && (
                          <p className="mt-1.5 text-[11px] text-gray-400 leading-snug">
                            {s.approach && <span className="font-medium text-gray-500">{s.approach}</span>}
                            {s.approach && s.rationale && <span> · </span>}
                            {s.rationale}
                          </p>
                        )}
                      </div>
                    </Wrapper>
                  );
                })}
              </div>
            </div>}

            {/* Section 3: Customer Context - CRM-backed identity. Shows the
                contact card, stage/owner, open issues, deals, tickets and a
                sentiment trend strip. Falls back to conversation-only data
                when CRM isn't connected or the customer hasn't been linked. */}
            {conversation && (
              <CustomerContextSection
                conversation={conversation}
                crmContext={crmContext}
                crmLoading={crmLoading}
                onRefetchCrm={onRefetchCrm}
                collapsed={customerContextCollapsed}
                onToggleCollapsed={() => setCustomerContextCollapsed((v) => !v)}
                effectiveSentiment={effectiveSentiment}
                t={t}
              />
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
                    {/* Reference block - only on user messages that were
                        submitted with a pinned quote. Renders as small gray
                        text ABOVE the bubble with a return arrow that scrolls
                        the user back to the original snippet in the chat.
                        It is NOT part of the bubble itself, so the bubble
                        shows only the agent's question. */}
                    {msg.role === "user" && msg.referenceQuote && (
                      <button
                        type="button"
                        onClick={() => {
                          // Best-effort "go to reference": surface the full
                          // quote in the active selection range so the agent
                          // sees what they were asking about. The actual chat
                          // panel scroll is owned by ChatPanel; this is the
                          // minimum useful affordance from inside the copilot.
                          try {
                            const evt = new CustomEvent("copilot:goToReference", {
                              detail: { quote: msg.referenceQuote },
                            });
                            window.dispatchEvent(evt);
                          } catch { /* ignore */ }
                        }}
                        className="group mb-1 flex w-full items-start gap-1.5 px-1 text-left text-[10.5px] leading-snug text-gray-400 hover:text-gray-600 transition"
                        title={msg.referenceQuote}
                      >
                        <svg className="w-3 h-3 mt-[2px] shrink-0 text-gray-300 group-hover:text-violet-500 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                        </svg>
                        <span className="italic line-clamp-1 break-words">
                          &ldquo;{msg.referenceQuote}&rdquo;
                        </span>
                      </button>
                    )}
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
              {/* Reference banner - pinned customer quote forwarded by the
                  ChatPanel "Ask Co-Pilot" selection action. Stays visible
                  across multiple questions so the agent can keep asking
                  about the same snippet. Dismiss with the × button. */}
              {referenceQuote && (
                <div className="mb-2 flex items-start gap-2 rounded-lg border border-violet-200/70 bg-gradient-to-br from-violet-50 to-purple-50/60 px-2.5 py-2 shadow-sm">
                  <div className="mt-0.5 shrink-0 w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-violet-700 mb-0.5">
                      {t("conversations.askCopilot")}
                    </div>
                    <div className="text-[12px] text-gray-700 leading-snug line-clamp-3 break-words italic">
                      &ldquo;{referenceQuote}&rdquo;
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReferenceQuote(null)}
                    className="shrink-0 text-gray-400 hover:text-gray-700 transition p-0.5"
                    aria-label="clear reference"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
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

// ─── Customer Context Section ─────────────────────────────────
// Renders the "who is this customer" block at the bottom of the Co-Pilot:
// CRM identity → stage / owner → open issues → deals → tickets → sentiment
// trend. Conversation-side fields (channel, status) anchor the bottom so the
// section is useful even when CRM is unconfigured.

function CustomerContextSection({
  conversation,
  crmContext,
  crmLoading,
  onRefetchCrm,
  collapsed,
  onToggleCollapsed,
  effectiveSentiment,
  t,
}: {
  conversation: any;
  crmContext: CrmContextEnvelope | null | undefined;
  crmLoading: boolean | undefined;
  onRefetchCrm: (() => void | Promise<void>) | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  effectiveSentiment: string | null;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const { token } = useAuth();
  const [creatingLead, setCreatingLead] = useState(false);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const contact = crmContext?.status === "linked" ? crmContext.contact : null;
  const displayName = contact?.display_name || conversation.customerName || t("copilot.panel.customerContext.unknown");
  const phone = contact?.phone || conversation.customerPhone;
  const email = (contact as any)?.email;
  const channel = (conversation.channel || conversation.channelType || "").toUpperCase();
  const channelLabel = channel.includes("WHATSAPP") ? "WhatsApp" : channel.includes("INSTAGRAM") ? "Instagram" : channel.includes("MESSENGER") ? "Messenger" : t("copilot.panel.customerContext.web");
  const channelTone = channel.includes("WHATSAPP") ? "bg-green-50 text-green-600" : channel.includes("INSTAGRAM") ? "bg-pink-50 text-pink-600" : "bg-blue-50 text-blue-600";

  async function handleCreateLead() {
    if (!token || !conversation?.id) return;
    setCreatingLead(true);
    setError(null);
    try {
      await createCrmLeadForConversation(token, conversation.id);
      await onRefetchCrm?.();
    } catch (err: any) {
      setError(err?.message || "create_lead_failed");
    } finally {
      setCreatingLead(false);
    }
  }

  async function handlePickCandidate(id: string, kind: string) {
    if (!token || !conversation?.id) return;
    setPickingId(id);
    setError(null);
    try {
      await pickCrmCandidate(token, conversation.id, id, kind as any);
      await onRefetchCrm?.();
    } catch (err: any) {
      setError(err?.message || "pick_candidate_failed");
    } finally {
      setPickingId(null);
    }
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden" data-tour="customer-context">
      {/* Collapsible header */}
      <button
        onClick={onToggleCollapsed}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-gray-50 hover:bg-gray-100/60 transition-all"
      >
        <div className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{t("copilot.panel.customerContext.title")}</span>
          {crmContext?.vendor && (
            <span className="text-[9px] font-medium text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full ms-1">
              {crmContext.vendor}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-400">{collapsed ? t("copilot.panel.customerContext.show") : t("copilot.panel.customerContext.hide")}</span>
          <svg
            className={clsx("w-3.5 h-3.5 text-gray-400 transition-transform duration-200", collapsed ? "-rotate-90" : "rotate-0")}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </button>

      <div className={clsx("transition-all duration-300 overflow-hidden", collapsed ? "max-h-0" : "max-h-[1200px]")}>
        <div className="px-3 pt-2 pb-3 space-y-3">
          {/* Identity row */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.name")}</span>
              <span className="text-[11px] font-semibold text-gray-800 truncate ms-2">{displayName}</span>
            </div>
            {phone && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.phone")}</span>
                <span className="text-[11px] font-medium text-gray-700 font-mono truncate ms-2">{phone}</span>
              </div>
            )}
            {email && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">Email</span>
                <span className="text-[11px] font-medium text-gray-700 font-mono truncate ms-2">{email}</span>
              </div>
            )}
            {contact?.stage && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">Stage</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{contact.stage}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.channel")}</span>
              <span className={clsx("text-[10px] font-semibold px-2 py-0.5 rounded-full", channelTone)}>{channelLabel}</span>
            </div>
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

          {/* CRM state banners */}
          {crmLoading && !crmContext && (
            <div className="text-[11px] text-gray-400 italic">Loading CRM…</div>
          )}

          {crmContext?.status === "no_crm_configured" && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              {t("crmPanel.noCrm") || "No CRM connected - connect one under Settings → Integrations."}
            </div>
          )}

          {crmContext?.status === "unmapped" && (
            <div className="rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 px-2.5 py-2 space-y-1.5">
              <div className="text-[11px]">{t("crmPanel.unmapped") || "This customer isn't in your CRM yet."}</div>
              <button
                onClick={handleCreateLead}
                disabled={creatingLead}
                className="w-full text-[11px] font-semibold px-2.5 py-1.5 rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
              >
                {creatingLead ? (t("crmPanel.creatingLead") || "Creating…") : (t("crmPanel.createLead") || "Create lead in CRM")}
              </button>
            </div>
          )}

          {crmContext?.status === "needs_approval" && (crmContext.candidates?.length || 0) > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-100 px-2.5 py-2 space-y-1.5">
              <div className="text-[11px] font-semibold text-amber-700">
                {t("crmPanel.needsApproval.title") || "Multiple CRM matches"}
              </div>
              <ul className="space-y-1">
                {(crmContext.candidates || []).map((cand) => (
                  <li key={cand.id} className="rounded-md bg-white border border-amber-100 px-2 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-semibold text-gray-900 truncate">
                          {cand.display_name || "(no name)"} <span className="text-[9px] uppercase font-normal text-gray-400">{cand.kind}</span>
                        </div>
                        <div className="text-[10px] text-gray-500 font-mono truncate">
                          {[cand.email, cand.phone].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <button
                        onClick={() => handlePickCandidate(cand.id, cand.kind)}
                        disabled={pickingId === cand.id}
                        className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 shrink-0"
                      >
                        {pickingId === cand.id ? "…" : (t("crmPanel.needsApproval.useThis") || "Use")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="text-[11px] text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5">{error}</div>
          )}

          {/* Open issues - escalation-worthy, surface near the top of the section */}
          {(crmContext?.open_issues?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Open issues ({crmContext!.open_issues!.length})</div>
              <ul className="space-y-1">
                {crmContext!.open_issues!.map((iss) => (
                  <li key={iss.id} className="rounded-md bg-white border border-amber-200 px-2 py-1.5">
                    <div className="text-[11px] font-semibold text-amber-800 truncate">{iss.subject}</div>
                    {iss.description && (
                      <div className="text-[10px] text-gray-600 line-clamp-2 mt-0.5">{iss.description}</div>
                    )}
                    <div className="text-[10px] text-gray-500 mt-0.5 space-x-2">
                      {iss.status && <span className="font-mono">{iss.status}</span>}
                      {iss.priority && <span>· {iss.priority}</span>}
                      {iss.due_at && <span>· due {new Date(iss.due_at).toLocaleDateString()}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Deals */}
          {(crmContext?.deals?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Deals ({crmContext!.deals!.length})</div>
              <ul className="space-y-1">
                {crmContext!.deals!.map((d) => (
                  <li key={d.id} className="rounded-md bg-white border border-gray-100 px-2 py-1.5">
                    <div className="text-[11px] font-medium text-gray-800 truncate">{d.name}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      {d.stage && <span className="me-2">{d.stage}</span>}
                      {d.amount != null && <span className="font-mono">{d.amount}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Tickets */}
          {(crmContext?.tickets?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Tickets ({crmContext!.tickets!.length})</div>
              <ul className="space-y-1">
                {crmContext!.tickets!.map((tk) => (
                  <li key={tk.id} className="rounded-md bg-white border border-gray-100 px-2 py-1.5">
                    <div className="text-[11px] font-medium text-gray-800 truncate">{tk.subject}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      {tk.status && <span className="me-2">{tk.status}</span>}
                      {tk.priority && <span>priority: {tk.priority}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Sentiment trend */}
          {(crmContext?.sentiment_trend?.length ?? 0) > 0 && (
            <div className="rounded-md bg-white border border-gray-100 px-2.5 py-2">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Sentiment trend</div>
              <div className="flex items-center gap-1">
                {crmContext!.sentiment_trend!.map((v, i) => (
                  <span
                    key={i}
                    title={v}
                    className={clsx(
                      "h-2 flex-1 rounded-sm",
                      v === "positive" && "bg-emerald-400",
                      v === "negative" && "bg-rose-400",
                      v === "neutral"  && "bg-gray-300",
                      v === "unknown"  && "bg-gray-200",
                    )}
                  />
                ))}
              </div>
              <div className="text-[9px] text-gray-400 mt-0.5">most-recent →</div>
            </div>
          )}

          {/* Live sentiment from intent analysis - kept here so the agent sees
              both the historical trend and the right-now read in one place. */}
          {effectiveSentiment && (
            <div className="flex items-center justify-between pt-0.5">
              <span className="text-[11px] text-gray-400">{t("copilot.panel.customerContext.sentiment")} (now)</span>
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
          )}
        </div>
      </div>
    </div>
  );
}
