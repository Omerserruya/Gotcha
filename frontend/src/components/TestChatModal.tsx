"use client";

import { useState, useRef, useEffect } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import type { SandboxDiagnostics } from "@/lib/api";

/** One diagnostics row. */
function Diag({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className="min-w-0 flex-1 text-gray-700 break-words">{value}</dd>
    </div>
  );
}

interface TestChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  avatarColor: string;
  token: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  /** The turn proposed an action that was NOT performed. Labelled as such. */
  simulated?: boolean;
}

export default function TestChatModal({ isOpen, onClose, agentId, agentName, avatarColor, token }: TestChatModalProps) {
  const { locale } = useI18n();
  const he = locale === "he";
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // Safe simulation by default. Real execution is an explicit opt-in because it
  // runs the production approval path and can genuinely change a customer's
  // record.
  const [writeMode, setWriteMode] = useState<"safe" | "real">("safe");
  const [diagnostics, setDiagnostics] = useState<SandboxDiagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const firstSendRef = useRef(true);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Customer-style openers: the point of the sandbox is to TALK like a real
  // customer, not to inspect the bot - these make that the default move.
  const STARTERS: Array<[string, string]> = [
    ["What are your prices?", "מה המחירים אצלכם?"],
    ["Do you deliver to my area?", "יש לכם משלוחים לאזור שלי?"],
    ["I need help with my order", "אני צריך עזרה עם הזמנה"],
  ];

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  useEffect(() => {
    if (isOpen) {
      setMessages([{
        id: "welcome",
        role: "assistant",
        content: he
          ? `היי, אני ${agentName}. דברו איתי בדיוק כמו שלקוח היה כותב לכם, ואענה באמת.`
          : `Hi, I'm ${agentName}. Write to me exactly like one of your customers would, and I'll answer for real.`,
        timestamp: new Date(),
      }]);
      setInput("");
      setDiagnostics(null);
      setShowDiagnostics(false);
      setWriteMode("safe");
      firstSendRef.current = true;
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, agentName, he]);

  async function handleSend() {
    const text = input.trim();
    if (!text || thinking) return;

    const userMsg: ChatMessage = { id: `u_${Date.now()}`, role: "user", content: text, timestamp: new Date() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setThinking(true);

    try {
      const { testAgentChat } = await import("@/lib/api");
      // No history is sent: the server keeps the sandbox conversation, so memory
      // is the production memory model rather than an array we pass in. `reset`
      // on the first real message starts the thread clean.
      const res = await testAgentChat(token, agentId, text, {
        writes: writeMode,
        reset: firstSendRef.current,
      });
      firstSendRef.current = false;
      const reply = res.data?.reply || L("No response generated.", "לא נוצרה תשובה.");
      setDiagnostics(res.data?.diagnostics ?? null);
      setMessages(prev => [...prev, {
        id: `a_${Date.now()}`,
        role: "assistant",
        content: reply,
        timestamp: new Date(),
        simulated: (res.data?.diagnostics?.simulatedActions?.length ?? 0) > 0,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        id: `err_${Date.now()}`,
        role: "assistant",
        content: "Error: Failed to get response. Make sure the agent is configured correctly.",
        timestamp: new Date(),
      }]);
    } finally {
      setThinking(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg h-[600px] max-h-[85vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-scale-in">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3 shrink-0">
          <div className={clsx("w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-sm font-bold", avatarColor)}>
            {(agentName || "A").charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 text-sm">{agentName}</h3>
            <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              {L("Online, answering like it would a real customer", "מחובר/ת, עונה כמו ללקוח אמיתי")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-200">
              {L("Sandbox", "ארגז חול")}
            </span>
            <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-gray-50/50">
          {messages.map(msg => (
            <div key={msg.id} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div className={clsx(
                "max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap",
                msg.role === "user"
                  ? "bg-violet-600 text-white rounded-br-md"
                  : "bg-white text-gray-800 border border-gray-100 rounded-bl-md shadow-sm"
              )}>
                {msg.content}
                {/* An action the employee proposed but did NOT perform. Saying
                    nothing here is how a tester comes away believing a refund
                    actually happened. */}
                {msg.simulated && (
                  <span className="mt-1.5 block text-[10px] font-medium text-amber-600">
                    {L("Simulated: no action was actually performed", "סימולציה: לא בוצעה פעולה אמיתית")}
                  </span>
                )}
              </div>
            </div>
          ))}
          {/* Customer-style starter chips - shown until the first real message. */}
          {messages.length === 1 && !thinking && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {STARTERS.map(([en, hebrew]) => (
                <button
                  key={en}
                  type="button"
                  onClick={() => { setInput(L(en, hebrew)); setTimeout(() => inputRef.current?.focus(), 50); }}
                  className="text-xs px-3 py-1.5 rounded-full bg-white border border-gray-200 text-gray-600 hover:border-violet-300 hover:text-violet-700 transition"
                >
                  {L(en, hebrew)}
                </button>
              ))}
            </div>
          )}
          {thinking && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                <div className="flex gap-1.5">
                  <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Diagnostics: "why did it answer this way?" Admin-facing, and
            deliberately free of prompt text and chain of thought - it reports
            the employee, the sources, the tools and the decisions only. */}
        {diagnostics && (
          <div className="border-t border-gray-100 bg-white shrink-0">
            <button
              type="button"
              onClick={() => setShowDiagnostics((v) => !v)}
              data-testid="diagnostics-toggle"
              className="w-full px-4 py-2 flex items-center justify-between text-[11px] font-medium text-gray-500 hover:text-violet-700 hover:bg-gray-50 transition"
            >
              <span>{L("Why did it answer this way?", "למה זו התשובה?")}</span>
              <svg className={clsx("w-3.5 h-3.5 transition", showDiagnostics && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showDiagnostics && (
              <dl className="px-4 pb-3 space-y-1.5 text-[11px]" data-testid="diagnostics-panel">
                <Diag label={L("Employee", "עובד")} value={`${diagnostics.employee.name}${diagnostics.employee.role ? ` (${diagnostics.employee.role})` : ""}`} />
                <Diag label={L("Routing", "ניתוב")} value={diagnostics.routing} />
                {diagnostics.department && <Diag label={L("Department", "מחלקה")} value={diagnostics.department.name} />}
                <Diag
                  label={L("Knowledge used", "ידע שנקרא")}
                  value={diagnostics.knowledgeUsed.length
                    ? diagnostics.knowledgeUsed.map((k) => k.title).join(", ")
                    : L("nothing retrieved for this question", "לא אוחזר ידע לשאלה הזו")}
                />
                <Diag
                  label={L("Tools considered", "כלים שנשקלו")}
                  value={diagnostics.toolsConsidered.length ? diagnostics.toolsConsidered.join(", ") : L("none", "אף אחד")}
                />
                <Diag
                  label={L("Execution", "ביצוע")}
                  value={diagnostics.writeMode === "real"
                    ? L("real, using the production approval policy", "אמיתי, לפי מדיניות האישורים בייצור")
                    : L("safe simulation, writes are not performed", "סימולציה בטוחה, פעולות כתיבה לא מבוצעות")}
                />
                {diagnostics.simulatedActions.length > 0 && (
                  <Diag label={L("Would have run", "היה מריץ")} value={diagnostics.simulatedActions.map((a) => a.tool).join(", ")} />
                )}
                {diagnostics.awaitingApproval && (
                  <Diag label={L("Needs approval", "דורש אישור")} value={`${diagnostics.awaitingApproval.tool} - ${diagnostics.awaitingApproval.reason}`} />
                )}
                {diagnostics.escalated && (
                  <Diag label={L("Handed to a human", "הועבר לאדם")} value={diagnostics.escalated.reason} />
                )}
                <Diag label={L("Turns in this conversation", "תורות בשיחה")} value={String(diagnostics.turnCount)} />
              </dl>
            )}
          </div>
        )}

        {/* Input */}
        <div className="px-4 py-3 border-t border-gray-100 bg-white shrink-0">
          {/* Execution mode. Safe by default; switching to real is a deliberate
              act because it uses the production authorization and approval
              path and can change a customer's record. */}
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] text-gray-400">{L("Actions:", "פעולות:")}</span>
            {(["safe", "real"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setWriteMode(m)}
                data-testid={`write-mode-${m}`}
                className={clsx(
                  "px-2 py-0.5 rounded-full text-[10px] font-medium border transition",
                  writeMode === m
                    ? m === "real"
                      ? "bg-rose-50 text-rose-700 border-rose-300"
                      : "bg-emerald-50 text-emerald-700 border-emerald-300"
                    : "bg-white text-gray-500 border-gray-200 hover:border-gray-300",
                )}
              >
                {m === "safe" ? L("Simulate", "סימולציה") : L("Run for real", "הרצה אמיתית")}
              </button>
            ))}
            {writeMode === "real" && (
              <span className="text-[10px] text-rose-600">
                {L("uses the real approval policy", "לפי מדיניות האישורים האמיתית")}
              </span>
            )}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={L("Write like a customer would…", "כתבו כמו שלקוח היה כותב…")}
              rows={1}
              className="flex-1 resize-none px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition max-h-24"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || thinking}
              className="w-10 h-10 rounded-xl bg-violet-600 text-white flex items-center justify-center hover:bg-violet-700 transition disabled:opacity-40 shrink-0"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
