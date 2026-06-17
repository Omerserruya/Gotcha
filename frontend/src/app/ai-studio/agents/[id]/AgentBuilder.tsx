"use client";

/**
 * AgentBuilder - the dynamic, conversational AI-Employee creation surface.
 *
 * Left: a chat with the builder agent (speaks the platform language). Right:
 * a live draft preview that fills in as the agent captures decisions, PLUS a
 * Knowledge & Tools picker rendered as checkbox cards (selected via UI, not
 * dictated over chat). On finish → the existing agent editor (prefilled).
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { logoForIntegration } from "@/lib/integration-logos";
import { useI18n } from "@/context/I18nContext";
import {
  builderStart,
  builderSaveStep,
  builderComplete,
  builderRunStream,
  builderGetDraft,
  builderGetOptions,
  builderToggleTool,
  builderToggleToolsBulk,
  builderToggleKnowledge,
  builderSaveRefinements,
  builderReadinessTest,
  type BuilderDraftSnapshot,
  type BuilderSSEEvent,
  type BuilderOptionTool,
  type BuilderOptionKb,
  type ReadinessReport,
  type ReadinessQuestion,
  type ReadinessRecommendation,
} from "@/lib/gotcha-api";
import {
  createKnowledgeBase,
  uploadKnowledgeDocument,
  uploadKnowledgeFile,
  processKnowledgeDocument,
} from "@/lib/api";

interface ChatMsg { role: "user" | "assistant"; content: string }

const FUNNEL_ROLES = new Set(["sales", "sdr", "recruiting"]);

// Brand Voice archetypes - keys MUST match services/ai/src/services/brand-archetypes.ts
// and the editor's BRAND_ARCHETYPE_OPTIONS (ai-studio/agents/[id]/page.tsx).
// "" = neutral default. Persisted on persona.brand_archetype.
const BRAND_ARCHETYPE_OPTIONS: { value: string; en: string; he: string }[] = [
  { value: "", en: "Neutral / Professional (default)", he: "ניטרלי / מקצועי (ברירת מחדל)" },
  { value: "trusted_advisor", en: "Trusted Advisor — measured, credible, no hype", he: "יועץ מהימן — שקול, אמין, בלי הייפ" },
  { value: "high_energy_coach", en: "High-Energy Coach — short, fast, motivating", he: "מאמן אנרגטי — קצר, מהיר, מניע לפעולה" },
  { value: "luxury_concierge", en: "Luxury Concierge — refined, formal, deliberate", he: "קונסיירז' יוקרתי — מעודן, רשמי, מדוד" },
  { value: "beauty_consultant", en: "Beauty Consultant — warm, intimate, expressive", he: "יועצת יופי — חמה, אישית, אקספרסיבית" },
];

// Transient "agent is doing X" labels - [en, he].
const TOOL_LABELS: Record<string, [string, string]> = {
  set_company_overview: ["Capturing company overview", "מתעד את סקירת החברה"],
  set_identity: ["Naming the employee", "נותן שם לעובד"],
  set_role: ["Setting the role", "מגדיר תפקיד"],
  set_goal: ["Setting the goal", "מגדיר מטרה"],
  set_success_criteria: ["Defining success criteria", "מגדיר קריטריוני הצלחה"],
  set_personalization: ["Setting languages", "מגדיר שפות"],
  set_escalation: ["Configuring escalation rules", "מגדיר כללי הסלמה"],
  set_conversation_flow: ["Building the conversation flow", "בונה תסריט שיחה"],
  set_rules: ["Writing business rules", "כותב כללים עסקיים"],
  list_funnels: ["Loading your pipelines", "טוען את המשפכים שלך"],
  attach_funnel: ["Attaching the pipeline", "מצרף משפך"],
  create_funnel: ["Creating a new pipeline", "יוצר משפך חדש"],
  list_knowledge_bases: ["Loading knowledge bases", "טוען מאגרי ידע"],
  attach_knowledge_base: ["Linking knowledge", "מקשר ידע"],
  list_available_tools: ["Loading available tools", "טוען כלים זמינים"],
  attach_tool: ["Granting a tool", "מעניק כלי"],
  finalize: ["Finalizing", "מסיים"],
};

export default function AgentBuilder({
  token,
  departmentId,
  onCancel,
  resumeAgentId,
  resumeStep,
}: {
  token: string;
  departmentId?: string | null;
  onCancel: () => void;
  /** When set, resume an existing incomplete DRAFT instead of starting fresh. */
  resumeAgentId?: string;
  resumeStep?: "chat" | "kb" | "refine" | "tools";
}) {
  const router = useRouter();
  const { locale } = useI18n();
  const he = locale === "he";
  const L = useCallback((en: string, hebrew: string) => (he ? hebrew : en), [he]);

  const [agentId, setAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BuilderDraftSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  // Wizard stage: conversational config → KB → Refinements → Tools → readiness.
  const [wizardStep, setWizardStep] = useState<"chat" | "kb" | "refine" | "tools">("chat");
  const [savingRefine, setSavingRefine] = useState(false);
  const [optTools, setOptTools] = useState<BuilderOptionTool[]>([]);
  const [optKbs, setOptKbs] = useState<BuilderOptionKb[]>([]);
  const [optLoading, setOptLoading] = useState(false);
  const [toggleBusy, setToggleBusy] = useState<string | null>(null);

  // In-wizard KB creation + readiness test.
  const [kbModalOpen, setKbModalOpen] = useState(false);
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [showReport, setShowReport] = useState(false);

  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startedRef = useRef(false);

  const focusInput = useCallback(() => {
    // rAF so focus lands after React re-enables the (previously disabled) input.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Bootstrap the builder session once. Resumes an incomplete DRAFT (either
  // passed explicitly via resumeAgentId, or the one /start hands back when it
  // finds the tenant's most-recent unfinished wizard) at its saved step.
  useEffect(() => {
    if (startedRef.current || !token) return;
    startedRef.current = true;

    const resumeInto = async (id: string, step: string, snapshot: BuilderDraftSnapshot | null, greeting: string) => {
      setAgentId(id);
      if (snapshot) setDraft(snapshot);
      const s = (["chat", "kb", "refine", "tools"].includes(step) ? step : "chat") as typeof wizardStep;
      setWizardStep(s);
      setMessages([{ role: "assistant", content: greeting }]);
      if (s !== "chat") {
        try {
          const r = await builderGetOptions(token, id);
          setOptTools(r.data.tools);
          setOptKbs(r.data.knowledgeBases);
        } catch { /* keep empty */ }
      }
    };
    const resumeGreeting = L("Welcome back — let's pick up where we left off.", "ברוכים השבים — נמשיך מהמקום שבו עצרנו.");

    (async () => {
      try {
        if (resumeAgentId) {
          const r = await builderGetDraft(token, resumeAgentId);
          const d = r.data.draft;
          await resumeInto(resumeAgentId, resumeStep || d.builderStep || "chat", d, resumeGreeting);
        } else {
          const res = await builderStart(token, departmentId ?? null, locale);
          const d = res.data.draft;
          if (res.data.resumed && d.builderStep && d.builderStep !== "chat") {
            await resumeInto(res.data.agentId, d.builderStep, d, resumeGreeting);
          } else {
            setAgentId(res.data.agentId);
            setDraft(d);
            setMessages([{ role: "assistant", content: res.data.greeting }]);
          }
        }
      } catch (e: any) {
        setError(e?.message || L("Failed to start the builder.", "ההפעלה נכשלה."));
      } finally {
        setStarting(false);
        focusInput();
      }
    })();
  }, [token, departmentId, locale, L, focusInput, resumeAgentId, resumeStep]);

  // Persist wizard progress on every step change so an abandoned session can
  // resume from exactly here. Skipped until the draft id exists / while booting.
  useEffect(() => {
    if (!agentId || starting) return;
    builderSaveStep(token, agentId, wizardStep).catch(() => {});
  }, [wizardStep, agentId, token, starting]);

  // Keep the input focused whenever it's interactive (incl. after send/enter).
  useEffect(() => {
    if (!starting && !streaming && agentId) focusInput();
  }, [starting, streaming, agentId, focusInput]);

  // Auto-scroll the chat.
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, activity, streaming]);

  const loadOptions = useCallback(async () => {
    if (!agentId) return;
    setOptLoading(true);
    try {
      const r = await builderGetOptions(token, agentId);
      setOptTools(r.data.tools);
      setOptKbs(r.data.knowledgeBases);
    } catch { /* keep prior */ }
    finally { setOptLoading(false); }
  }, [agentId, token]);

  const toggleKb = useCallback(async (id: string, attach: boolean) => {
    if (!agentId) return;
    setToggleBusy("kb:" + id);
    try { const r = await builderToggleKnowledge(token, agentId, id, attach); setDraft(r.data.draft); }
    catch { /* ignore */ } finally { setToggleBusy(null); }
  }, [agentId, token]);

  const toggleTool = useCallback(async (id: string, attach: boolean) => {
    if (!agentId) return;
    setToggleBusy("tool:" + id);
    try { const r = await builderToggleTool(token, agentId, id, attach); setDraft(r.data.draft); }
    catch { /* ignore */ } finally { setToggleBusy(null); }
  }, [agentId, token]);

  // Bulk attach/detach (Select all / per-category select-all). No-op if the
  // list is empty so the buttons can stay enabled without guarding everywhere.
  const toggleToolsBulk = useCallback(async (ids: string[], attach: boolean) => {
    if (!agentId || ids.length === 0) return;
    setToggleBusy("tools:bulk");
    try { const r = await builderToggleToolsBulk(token, agentId, ids, attach); setDraft(r.data.draft); }
    catch { /* ignore */ } finally { setToggleBusy(null); }
  }, [agentId, token]);

  // Persist the optional refinements (name / flow / guardrails) then advance to
  // the Tools step. Everything here is optional - Skip just advances without
  // saving. `onDone` runs after a successful save so the step can move on.
  const saveRefinements = useCallback(async (
    refine: { name?: string; conversationFlow?: Array<{ action: string; details?: string }>; customGuardrails?: string[]; brandArchetype?: string },
    onDone: () => void,
  ) => {
    if (!agentId) { onDone(); return; }
    setSavingRefine(true);
    setError(null);
    try {
      const r = await builderSaveRefinements(token, agentId, refine);
      setDraft(r.data.draft);
      onDone();
    } catch (e: any) {
      setError(e?.message || L("Couldn't save the refinements.", "שמירת ההגדרות נכשלה."));
    } finally {
      setSavingRefine(false);
    }
  }, [agentId, token, L]);

  // Conversational config is "done enough" to move to the KB/Tools steps -
  // knowledge is NOT part of this (it's collected in the KB step).
  const configComplete = !!draft
    && !!draft.name.trim() && draft.name !== "Untitled AI Employee"
    && !!draft.role.trim()
    && (FUNNEL_ROLES.has(draft.role.toLowerCase()) ? !!draft.funnel : !!(draft.goal && draft.goal.trim()));

  const goToKbStep = useCallback(() => {
    setWizardStep((s) => (s === "chat" ? "kb" : s));
    loadOptions();
  }, [loadOptions]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !agentId || streaming) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setStreaming(true);
    setActivity(null);

    const onEvent = (ev: BuilderSSEEvent) => {
      switch (ev.type) {
        case "token":
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, content: last.content + ev.text };
            return copy;
          });
          break;
        case "tool_start": {
          const lbl = TOOL_LABELS[ev.name];
          setActivity(lbl ? (he ? lbl[1] : lbl[0]) : L("Working", "עובד"));
          break;
        }
        case "tool_end":
          setActivity(null);
          break;
        case "draft_update":
          setDraft(ev.draft);
          break;
        case "finalized":
          setDraft(ev.draft);
          setReady(ev.ready);
          setMissing(ev.missing);
          // The interview wrapped up → move straight into the KB step.
          goToKbStep();
          break;
        case "error":
          setError(ev.message);
          break;
      }
    };

    try {
      await builderRunStream(token, { agentId, message: text, locale }, onEvent);
    } catch (e: any) {
      setError(e?.message || L("The builder stopped unexpectedly.", "הבונה נעצר באופן בלתי צפוי."));
    } finally {
      setStreaming(false);
      setActivity(null);
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last && last.role === "assistant" && !last.content.trim()) return m.slice(0, -1);
        return m;
      });
      focusInput();
    }
  }, [input, agentId, streaming, token, locale, he, L, focusInput, goToKbStep]);

  // Hand the finished wizard off to the editor. Finalize first (clear the
  // resume pointer + promote DRAFT → ACTIVE) so the editor page renders the
  // real editor instead of re-entering the builder at the last saved step.
  async function goReview() {
    if (!agentId) return;
    try { await builderComplete(token, agentId); } catch { /* editor save is a backstop */ }
    router.push(`/ai-studio/agents/${agentId}`);
  }

  // After the KB modal attaches/creates a KB: re-read the draft (so the
  // mandatory-knowledge gate flips) and force the picker to refetch options.
  const refreshAfterKb = useCallback(async () => {
    setKbModalOpen(false);
    await loadOptions();
    if (!agentId) return;
    try {
      const d = await builderGetDraft(token, agentId);
      setDraft(d.data.draft);
    } catch { /* keep current draft */ }
  }, [agentId, token, loadOptions]);

  const runReadiness = useCallback(async () => {
    if (!agentId) return;
    setTesting(true);
    setError(null);
    try {
      const r = await builderReadinessTest(token, agentId, locale);
      setReport(r.data);
      setShowReport(true);
    } catch (e: any) {
      setError(e?.message || L("Couldn't run the readiness test.", "לא ניתן להריץ את בדיקת המוכנות."));
    } finally {
      setTesting(false);
    }
  }, [agentId, token, locale, L]);

  const reviewEnabled = !!draft && (ready || draftLooksReady(draft));

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] md:h-[calc(100vh-16px)]">
      {/* Header */}
      <div className="shrink-0 px-3 md:px-6 pt-3 md:pt-6 pb-3 flex items-center gap-3">
        <button onClick={onCancel} className="flex items-center gap-2 text-gray-400 hover:text-gray-700 text-sm transition">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {L("Back to AI Studio", "חזרה ל-AI Studio")}
        </button>
        <div className="ml-auto flex items-center gap-2">
          {reviewEnabled && !showReport && (
            <button
              onClick={goReview}
              className="px-3 py-2 rounded-xl text-sm font-medium text-gray-500 hover:text-gray-700 transition"
              title={L("Skip the test and go to the editor", "דלגו על הבדיקה ועברו לעורך")}
            >
              {L("Skip to editor", "דלג לעורך")}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-3 md:mx-6 mb-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700" aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Two panes */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-0 lg:gap-4 px-3 md:px-6 pb-3 md:pb-6">
        {/* Chat */}
        <div className="flex flex-col min-h-0 bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {starting && <ThinkingBubble label={L("Starting the builder…", "מפעיל את הבונה…")} />}
            {messages.map((m, i) =>
              m.role === "assistant" ? (
                <div key={i} className="flex items-start gap-3">
                  <BotAvatar />
                  <div className="bg-gray-50 border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[85%]">
                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{m.content || <span className="text-gray-300">…</span>}</p>
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-end">
                  <div className="bg-violet-600 text-white rounded-2xl rounded-tr-sm px-4 py-3 max-w-[85%]">
                    <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                  </div>
                </div>
              ),
            )}
            {activity && (
              <div className="flex items-center gap-2 text-xs text-violet-500 pl-11">
                <span className="w-3 h-3 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
                {activity}…
              </div>
            )}

            {/* Once the interview is done, offer to move into the picker steps. */}
            {wizardStep === "chat" && configComplete && !streaming && (
              <div className="flex items-start gap-3">
                <BotAvatar />
                <button
                  onClick={goToKbStep}
                  className="bg-violet-50 border border-violet-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm font-medium text-violet-700 hover:bg-violet-100 transition text-left"
                >
                  {L("Looks good - let's add Knowledge & Tools →", "נראה טוב - נוסיף ידע וכלים ←")}
                </button>
              </div>
            )}

            {wizardStep === "kb" && (
              <StepKnowledge
                kbs={optKbs}
                attached={new Set((draft?.knowledge || []).map((k) => k.id))}
                loading={optLoading}
                busyId={toggleBusy}
                onToggle={toggleKb}
                onCreate={() => setKbModalOpen(true)}
                onNext={() => setWizardStep("refine")}
                canNext={(draft?.knowledge?.length || 0) > 0}
                L={L}
              />
            )}

            {wizardStep === "refine" && draft && (
              <StepRefine
                key={draft.id}
                draft={draft}
                saving={savingRefine}
                onBack={() => setWizardStep("kb")}
                onSkip={() => setWizardStep("tools")}
                onSave={(refine) => saveRefinements(refine, () => setWizardStep("tools"))}
                L={L}
              />
            )}

            {wizardStep === "tools" && (
              <StepTools
                tools={optTools}
                attached={new Set((draft?.tools || []).map((t) => t.tenantToolId))}
                loading={optLoading}
                busyId={toggleBusy}
                onToggle={toggleTool}
                onBulkToggle={toggleToolsBulk}
                onBack={() => setWizardStep("refine")}
                onFinish={runReadiness}
                finishing={testing}
                L={L}
              />
            )}
          </div>

          {/* Input - only during the conversational step. Once we move to the
              KB/Tools steps the actions live inside the step cards. */}
          {wizardStep === "chat" && (
            <div className="shrink-0 border-t border-gray-100 p-3 bg-white">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder={streaming ? L("The builder is responding…", "הבונה עונה…") : L("Type your answer…", "כתבו את התשובה…")}
                  disabled={starting || !agentId}
                  autoFocus
                  className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition disabled:opacity-60"
                />
                <button
                  onClick={send}
                  disabled={!input.trim() || streaming || starting}
                  className="px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-medium transition disabled:opacity-40"
                >
                  {L("Send", "שלח")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live draft preview + Knowledge/Tools picker */}
        <div className="hidden lg:flex flex-col min-h-0 bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">{L("Live configuration", "תצורה חיה")}</h3>
            <p className="text-xs text-gray-400">{L("Fills in as you talk. Nothing is live until you Save.", "מתמלא תוך כדי השיחה. שום דבר לא פעיל עד השמירה.")}</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {draft ? <DraftPreview draft={draft} missing={missing} L={L} /> : <p className="text-sm text-gray-400">{L("Starting…", "מתחיל…")}</p>}
          </div>
        </div>
      </div>

      {testing && !showReport && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-50/95">
          <div className="text-center">
            <div className="animate-spin w-12 h-12 border-4 border-violet-500 border-t-transparent rounded-full mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-gray-900">{L("Generating readiness report…", "מייצר דוח מוכנות…")}</h2>
            <p className="text-sm text-gray-500 mt-1">{L("Simulating the questions your customers will ask.", "מדמה את השאלות שהלקוחות שלכם ישאלו.")}</p>
          </div>
        </div>
      )}

      {showReport && report && agentId && (
        <ReadinessReportPanel
          report={report}
          busy={testing}
          onRerun={runReadiness}
          onClose={() => setShowReport(false)}
          onAddKnowledge={() => setKbModalOpen(true)}
          onSaveLive={goReview}
          L={L}
        />
      )}

      {kbModalOpen && agentId && (
        <KnowledgeModal
          token={token}
          agentId={agentId}
          onClose={() => setKbModalOpen(false)}
          onAttached={refreshAfterKb}
          L={L}
        />
      )}
    </div>
  );
}

function draftLooksReady(d: BuilderDraftSnapshot): boolean {
  if (!d.name.trim() || d.name === "Untitled AI Employee" || !d.role.trim()) return false;
  // Knowledge is mandatory for every AI employee.
  if (!d.knowledge || d.knowledge.length === 0) return false;
  if (FUNNEL_ROLES.has(d.role.toLowerCase())) return !!d.funnel;
  return !!(d.goal && d.goal.trim());
}

function BotAvatar() {
  return (
    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white shrink-0">
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
      </svg>
    </div>
  );
}

function ThinkingBubble({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <BotAvatar />
      <div className="bg-gray-50 border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
        <span className="w-4 h-4 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
        <span className="text-sm text-gray-500">{label}</span>
      </div>
    </div>
  );
}

type Tr = (en: string, he: string) => string;

// ─── Live draft preview ─────────────────────────────────────

function DraftPreview({ draft, missing, L }: { draft: BuilderDraftSnapshot; missing: string[]; L: Tr }) {
  const isPipeline = FUNNEL_ROLES.has(draft.role.toLowerCase());
  const name = draft.name && draft.name !== "Untitled AI Employee" ? draft.name : "";
  const notSet = <Dim>{L("not set", "לא הוגדר")}</Dim>;

  return (
    <div className="space-y-4 text-sm">
      <Row label={L("Name", "שם")} done={!!name}>{name || notSet}</Row>
      <Row label={L("Role", "תפקיד")} done={!!draft.role}>
        <span className="capitalize">{draft.role.replace(/_/g, " ")}</span>
        {isPipeline && <span className="ml-2 text-[10px] uppercase tracking-wide text-violet-500">pipeline</span>}
      </Row>
      <Row label={L("Company", "חברה")} done={!!draft.companyOverview}>
        {draft.companyOverview ? <span className="text-gray-600">{draft.companyOverview}</span> : <Dim>{L("discovery pending", "ממתין לאפיון")}</Dim>}
      </Row>

      {isPipeline ? (
        <Row label={L("Pipeline", "משפך")} done={!!draft.funnel} required={!draft.funnel}>
          {draft.funnel ? `${draft.funnel.funnelId} · ${draft.funnel.stageCount} ${L("stages", "שלבים")}` : <Dim>{L("pick or build one", "בחרו או בנו")}</Dim>}
        </Row>
      ) : (
        <Row label={L("Goal", "מטרה")} done={!!draft.goal} required={!draft.goal}>
          {draft.goal ? <span className="text-gray-600">{draft.goal}</span> : <Dim>{L("required", "חובה")}</Dim>}
        </Row>
      )}

      <Row label={L("Success", "הצלחה")} done={!!draft.successCriteria}>
        {draft.successCriteria ? <span className="text-gray-600">{draft.successCriteria}</span> : <Dim>{L("optional", "רשות")}</Dim>}
      </Row>

      <Row label={L("Escalation", "הסלמה")} done={draft.escalationRules.length > 0}>
        {draft.escalationRules.length
          ? <ul className="text-gray-600 list-disc pl-4 space-y-0.5">{draft.escalationRules.slice(0, 4).map((r, i) => <li key={i}>{r.label}</li>)}</ul>
          : notSet}
      </Row>

      <Row label={L("Flow", "תסריט")} done={draft.conversationFlow.length > 0}>
        {draft.conversationFlow.length
          ? <ol className="text-gray-600 list-decimal pl-4 space-y-0.5">{draft.conversationFlow.slice(0, 6).map((s, i) => <li key={i}>{s.action}</li>)}</ol>
          : notSet}
      </Row>

      <Row label={L("Rules", "כללים")} done={draft.customGuardrails.length > 0}>
        {draft.customGuardrails.length
          ? <ul className="text-gray-600 list-disc pl-4 space-y-0.5">{draft.customGuardrails.slice(0, 5).map((r, i) => <li key={i}>{r}</li>)}</ul>
          : <Dim>{L("none", "אין")}</Dim>}
      </Row>

      <Row label={L("Knowledge", "ידע")} done={draft.knowledge.length > 0} required={draft.knowledge.length === 0}>
        {draft.knowledge.length
          ? <div className="flex flex-wrap gap-1">{draft.knowledge.map((k) => <Chip key={k.id}>{k.name}</Chip>)}</div>
          : <Dim>{L("required - attach at least one", "חובה - צרפו לפחות אחד")}</Dim>}
      </Row>

      {missing.length > 0 && (
        <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          {L("Still needed", "עוד חסר")}: {missing.join(", ")}
        </div>
      )}
    </div>
  );
}

// ─── Knowledge & Tools picker (checkbox cards) ──────────────

// ─── In-chat step cards (KB → Tools) ────────────────────────

function StepKnowledge({ kbs, attached, loading, busyId, onToggle, onCreate, onNext, canNext, L }: {
  kbs: BuilderOptionKb[];
  attached: Set<string>;
  loading: boolean;
  busyId: string | null;
  onToggle: (id: string, attach: boolean) => void;
  onCreate: () => void;
  onNext: () => void;
  canNext: boolean;
  L: Tr;
}) {
  return (
    <div className="ml-11 bg-white border border-violet-200 rounded-2xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-violet-500">{L("Step 1 of 3", "שלב 1 מתוך 3")}</div>
          <h4 className="text-sm font-semibold text-gray-900">{L("Choose knowledge", "בחירת ידע")} <span className="text-red-400">*</span></h4>
        </div>
        <button onClick={onCreate} className="text-xs font-medium text-violet-600 hover:text-violet-700">{L("+ Create / upload", "+ צור / העלה")}</button>
      </div>
      <p className="text-xs text-gray-500">{L("Attach at least one knowledge base - the AI answers from it. Required.", "צרפו לפחות מאגר ידע אחד - ה-AI עונה ממנו. חובה.")}</p>
      {loading ? (
        <div className="h-8 rounded-lg bg-gray-100 animate-pulse" />
      ) : kbs.length === 0 ? (
        <button onClick={onCreate} className="w-full py-2.5 border border-dashed border-violet-300 rounded-xl text-sm text-violet-600 hover:bg-violet-50 transition">
          {L("Create your first knowledge base", "צרו מאגר ידע ראשון")}
        </button>
      ) : (
        <div className="space-y-1.5">
          {kbs.map((k) => (
            <CardCheckbox key={k.id} checked={attached.has(k.id)} busy={busyId === "kb:" + k.id} onClick={() => onToggle(k.id, !attached.has(k.id))} title={k.name} />
          ))}
        </div>
      )}
      <div className="flex justify-end pt-1">
        <button onClick={onNext} disabled={!canNext}
          className={clsx("px-4 py-2 rounded-xl text-sm font-medium transition", canNext ? "bg-violet-600 hover:bg-violet-700 text-white" : "bg-gray-100 text-gray-400 cursor-not-allowed")}>
          {L("Next: Tools", "הבא: כלים")} →
        </button>
      </div>
    </div>
  );
}

// Step 2 - optional refinements: name, conversation flow, custom guardrails.
// Everything here is skippable; the builder may have pre-filled some of it over
// chat, so we seed from the live draft. Skip advances without saving.
function StepRefine({ draft, saving, onBack, onSkip, onSave, L }: {
  draft: BuilderDraftSnapshot;
  saving: boolean;
  onBack: () => void;
  onSkip: () => void;
  onSave: (refine: { name?: string; conversationFlow: Array<{ action: string; details?: string }>; customGuardrails: string[]; brandArchetype: string }) => void;
  L: Tr;
}) {
  const seedName = draft.name && draft.name !== "Untitled AI Employee" ? draft.name : "";
  const [name, setName] = useState(seedName);
  const seedArchetype = typeof (draft.persona as any)?.brand_archetype === "string" ? (draft.persona as any).brand_archetype : "";
  const [archetype, setArchetype] = useState<string>(seedArchetype);
  const [flow, setFlow] = useState<Array<{ action: string; details: string }>>(
    (draft.conversationFlow || []).map((s) => ({ action: s.action || "", details: s.details || "" })),
  );
  const [rules, setRules] = useState<string[]>(draft.customGuardrails || []);

  const setFlowAt = (i: number, patch: Partial<{ action: string; details: string }>) =>
    setFlow((f) => f.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const removeFlow = (i: number) => setFlow((f) => f.filter((_, j) => j !== i));
  const addFlow = () => setFlow((f) => [...f, { action: "", details: "" }]);

  const setRuleAt = (i: number, v: string) => setRules((r) => r.map((x, j) => (j === i ? v : x)));
  const removeRule = (i: number) => setRules((r) => r.filter((_, j) => j !== i));
  const addRule = () => setRules((r) => [...r, ""]);

  const submit = () => {
    const conversationFlow = flow
      .map((s) => ({ action: s.action.trim(), details: s.details.trim() }))
      .filter((s) => s.action);
    const customGuardrails = rules.map((r) => r.trim()).filter(Boolean);
    onSave({ name: name.trim() || undefined, conversationFlow, customGuardrails, brandArchetype: archetype });
  };

  const inputCls = "w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-300 transition";

  return (
    <div className="ml-11 bg-white border border-violet-200 rounded-2xl p-4 shadow-sm space-y-4">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-violet-500">{L("Step 2 of 3", "שלב 2 מתוך 3")}</div>
        <h4 className="text-sm font-semibold text-gray-900">{L("Refine (optional)", "שיוף (רשות)")}</h4>
        <p className="text-xs text-gray-500 mt-0.5">{L("Fine-tune the name, a step-by-step flow, and hard guardrails - or skip and do it later.", "כווננו את השם, תסריט שלב-אחר-שלב וכללים נוקשים - או דלגו ועשו זאת בהמשך.")}</p>
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-gray-700">{L("Name", "שם")}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={L("e.g. Maya - Support", "למשל מאיה - תמיכה")}
          className={inputCls}
        />
      </div>

      {/* Brand voice / personalization - shapes HOW the employee sounds.
          Mirrors the editor's Brand Voice control (persona.brand_archetype). */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-gray-700">{L("Brand voice", "קול המותג")}</label>
        <select
          value={archetype}
          onChange={(e) => setArchetype(e.target.value)}
          className={inputCls}
        >
          {BRAND_ARCHETYPE_OPTIONS.map((opt) => (
            <option key={opt.value || "neutral"} value={opt.value}>{L(opt.en, opt.he)}</option>
          ))}
        </select>
        <p className="text-[11px] text-gray-400">{L("Shapes pace, warmth and vocabulary - layered on the central personality, never changes what it does.", "מעצב קצב, חום ואוצר מילים - נשען על האישיות המרכזית, לא משנה את מה שהוא עושה.")}</p>
      </div>

      {/* Conversation flow */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-gray-700">{L("Conversation flow", "תסריט שיחה")}</label>
          <button type="button" onClick={addFlow} className="text-xs font-medium text-violet-600 hover:text-violet-700">{L("+ Add step", "+ הוסף שלב")}</button>
        </div>
        {flow.length === 0 ? (
          <p className="text-xs text-gray-400">{L("No scripted flow - the employee improvises from its goal.", "אין תסריט - העובד מאלתר לפי המטרה.")}</p>
        ) : (
          <div className="space-y-2">
            {flow.map((s, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="mt-2 text-xs text-gray-400 w-4 shrink-0">{i + 1}.</span>
                <div className="flex-1 space-y-1">
                  <input
                    value={s.action}
                    onChange={(e) => setFlowAt(i, { action: e.target.value })}
                    placeholder={L("Step action, e.g. Greet & ask the order number", "פעולת השלב, למשל ברכה ובקשת מספר הזמנה")}
                    className={inputCls}
                  />
                  <input
                    value={s.details}
                    onChange={(e) => setFlowAt(i, { details: e.target.value })}
                    placeholder={L("Details (optional)", "פרטים (רשות)")}
                    className={clsx(inputCls, "text-xs")}
                  />
                </div>
                <button type="button" onClick={() => removeFlow(i)} className="mt-1.5 text-gray-300 hover:text-red-500 shrink-0" aria-label={L("Remove", "הסר")}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Custom guardrails */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-gray-700">{L("Custom guardrails", "כללים נוקשים")}</label>
          <button type="button" onClick={addRule} className="text-xs font-medium text-violet-600 hover:text-violet-700">{L("+ Add rule", "+ הוסף כלל")}</button>
        </div>
        {rules.length === 0 ? (
          <p className="text-xs text-gray-400">{L("No hard rules. e.g. \"Never promise a refund\".", "אין כללים נוקשים. למשל \"אף פעם אל תבטיח החזר\".")}</p>
        ) : (
          <div className="space-y-2">
            {rules.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-violet-400 shrink-0">•</span>
                <input
                  value={r}
                  onChange={(e) => setRuleAt(i, e.target.value)}
                  placeholder={L("e.g. Never quote a price without a formal quote", "למשל אל תנקוב במחיר ללא הצעת מחיר רשמית")}
                  className={inputCls}
                />
                <button type="button" onClick={() => removeRule(i)} className="text-gray-300 hover:text-red-500 shrink-0" aria-label={L("Remove", "הסר")}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-1">
        <button onClick={onBack} disabled={saving} className="text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">← {L("Back", "חזרה")}</button>
        <div className="flex items-center gap-2">
          <button onClick={onSkip} disabled={saving} className="px-3 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">{L("Skip", "דלג")}</button>
          <button onClick={submit} disabled={saving}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white transition disabled:opacity-50">
            {saving ? L("Saving…", "שומר…") : L("Save & continue", "שמור והמשך")} →
          </button>
        </div>
      </div>
    </div>
  );
}

function StepTools({ tools, attached, loading, busyId, onToggle, onBulkToggle, onBack, onFinish, finishing, L }: {
  tools: BuilderOptionTool[];
  attached: Set<string>;
  loading: boolean;
  busyId: string | null;
  onToggle: (id: string, attach: boolean) => void;
  onBulkToggle: (ids: string[], attach: boolean) => void;
  onBack: () => void;
  onFinish: () => void;
  finishing: boolean;
  L: Tr;
}) {
  // Group tools by their integration so the picker reads as categories
  // (integration header + its actions) instead of one flat list.
  const groups = useMemo(() => {
    const m = new Map<string, BuilderOptionTool[]>();
    for (const t of tools) {
      const key = t.integration || L("Other", "אחר");
      const arr = m.get(key);
      if (arr) arr.push(t);
      else m.set(key, [t]);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools, L]);

  // Filter by integration (chips). "all" shows every category.
  const [filter, setFilter] = useState<string>("all");
  const integrations = useMemo(() => groups.map(([name]) => name), [groups]);
  const activeFilter = filter !== "all" && !integrations.includes(filter) ? "all" : filter;
  const visibleGroups = activeFilter === "all" ? groups : groups.filter(([name]) => name === activeFilter);

  const bulkBusy = busyId === "tools:bulk";
  const allIds = useMemo(() => tools.map((t) => t.tenantToolId), [tools]);
  const allSelected = allIds.length > 0 && allIds.every((id) => attached.has(id));

  return (
    <div className="ml-11 bg-white border border-violet-200 rounded-2xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-violet-500">{L("Step 3 of 3", "שלב 3 מתוך 3")}</div>
          <h4 className="text-sm font-semibold text-gray-900">{L("Choose tools", "בחירת כלים")}</h4>
        </div>
        <a href="/integrations" target="_blank" rel="noreferrer" className="text-xs font-medium text-violet-600 hover:text-violet-700">{L("+ Connect", "+ חבר")}</a>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500">{L("Grant the actions this employee may take. Optional - add more later.", "הענקת הפעולות שהעובד יכול לבצע. רשות - אפשר להוסיף בהמשך.")}</p>
        {!loading && tools.length > 0 && (
          <button
            type="button"
            onClick={() => onBulkToggle(allIds, !allSelected)}
            disabled={bulkBusy}
            className="shrink-0 text-xs font-medium text-violet-600 hover:text-violet-700 disabled:opacity-50"
          >
            {allSelected ? L("Clear all", "נקה הכל") : L("Select all tools", "בחר את כל הכלים")}
          </button>
        )}
      </div>
      {loading ? (
        <div className="h-8 rounded-lg bg-gray-100 animate-pulse" />
      ) : tools.length === 0 ? (
        <p className="text-xs text-gray-300">{L("No connected tools yet.", "אין עדיין כלים מחוברים.")}</p>
      ) : (
        <>
          {integrations.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              <FilterChip active={activeFilter === "all"} onClick={() => setFilter("all")} label={L("All", "הכל")} />
              {integrations.map((name) => (
                <FilterChip key={name} active={activeFilter === name} onClick={() => setFilter(name)} label={name} icon={<IntegrationIcon name={name} size={12} />} />
              ))}
            </div>
          )}
          <div className="space-y-3 max-h-[22rem] overflow-y-auto pr-1 -mr-1">
          {visibleGroups.map(([integration, items]) => {
            const attachedCount = items.filter((t) => attached.has(t.tenantToolId)).length;
            const catIds = items.map((t) => t.tenantToolId);
            const catAllSelected = attachedCount === items.length;
            return (
              <div key={integration} className="space-y-1.5">
                {/* Category header - integration icon + name + selected count + per-category select-all */}
                <div className="flex items-center gap-2 px-0.5">
                  <IntegrationIcon name={integration} size={18} />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 truncate">{integration}</span>
                  <span className="ml-auto text-[10px] tabular-nums text-gray-400">
                    {attachedCount > 0 ? `${attachedCount}/${items.length}` : items.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => onBulkToggle(catIds, !catAllSelected)}
                    disabled={bulkBusy}
                    className="text-[10px] font-medium text-violet-600 hover:text-violet-700 disabled:opacity-50"
                  >
                    {catAllSelected ? L("Clear", "נקה") : L("Select all", "בחר הכל")}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {items.map((t) => (
                    <CardCheckbox
                      key={t.tenantToolId}
                      checked={attached.has(t.tenantToolId)}
                      busy={busyId === "tool:" + t.tenantToolId}
                      onClick={() => onToggle(t.tenantToolId, !attached.has(t.tenantToolId))}
                      title={t.name}
                      icon={<IntegrationIcon name={t.integration} size={16} />}
                      risk={t.risk}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          </div>
        </>
      )}
      <div className="flex items-center justify-between pt-1">
        <button onClick={onBack} disabled={finishing} className="text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50">← {L("Back", "חזרה")}</button>
        <button onClick={onFinish} disabled={finishing}
          className="px-4 py-2 rounded-xl text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white transition disabled:opacity-50">
          {finishing ? L("Generating…", "מייצר…") : L("Finish - generate readiness", "סיום - בדיקת מוכנות")} →
        </button>
      </div>
    </div>
  );
}

function CardCheckbox({ checked, busy, onClick, title, subtitle, icon, risk }: {
  checked: boolean; busy: boolean; onClick: () => void; title: string; subtitle?: string; icon?: React.ReactNode; risk?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={clsx(
        "w-full flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition",
        checked ? "border-violet-300 bg-violet-50/60" : "border-gray-200 bg-white hover:border-violet-200 hover:bg-violet-50/30",
      )}
    >
      <span className={clsx("w-4 h-4 rounded-md border flex items-center justify-center shrink-0", checked ? "bg-violet-500 border-violet-500" : "bg-white border-gray-300")}>
        {busy ? (
          <span className="w-2.5 h-2.5 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
        ) : checked ? (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
        ) : null}
      </span>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-gray-800 truncate">{title}</span>
        {subtitle && <span className="block text-[11px] text-gray-400 truncate">{subtitle}</span>}
      </span>
      {risk && risk.toUpperCase() === "HIGH" && (
        <span className="text-[9px] uppercase tracking-wide text-red-500 border border-red-200 rounded-full px-1.5 py-0.5 shrink-0">risk</span>
      )}
    </button>
  );
}

// Integration logo for a tool/category. Falls back to a violet first-letter
// badge when there's no known logo (e.g. built-in/internal tools).
function IntegrationIcon({ name, size = 16 }: { name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const url = logoForIntegration(name);
  if (url && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        onError={() => setBroken(true)}
        className="rounded-sm object-contain shrink-0 bg-white"
        style={{ width: size, height: size }}
      />
    );
  }
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="rounded-sm bg-violet-100 text-violet-600 font-bold flex items-center justify-center shrink-0"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    >
      {letter}
    </span>
  );
}

function FilterChip({ active, onClick, label, icon }: {
  active: boolean; onClick: () => void; label: string; icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border transition max-w-[10rem]",
        active ? "bg-violet-600 border-violet-600 text-white" : "bg-white border-gray-200 text-gray-600 hover:border-violet-300 hover:text-violet-700",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function Row({ label, done, required, children }: { label: string; done?: boolean; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className={clsx("mt-0.5 shrink-0 w-4", done ? "text-emerald-500" : required ? "text-amber-500" : "text-gray-300")}>
        {done ? "✓" : required ? "!" : "○"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
        <div className="text-gray-800">{children}</div>
      </div>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-gray-300">{children}</span>;
}

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span className={clsx("px-2 py-0.5 rounded-full text-[11px] capitalize", muted ? "bg-gray-100 text-gray-600" : "bg-violet-50 text-violet-600")}>
      {children}
    </span>
  );
}

// ─── In-wizard Knowledge creation (create KB + add file/text/URL) ──

function KnowledgeModal({ token, agentId, onClose, onAttached, L }: {
  token: string; agentId: string; onClose: () => void; onAttached: () => void; L: Tr;
}) {
  const [name, setName] = useState("");
  const [kbId, setKbId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<"file" | "text" | "url">("file");
  const [docTitle, setDocTitle] = useState("");
  const [docText, setDocText] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);

  async function createKb() {
    if (!name.trim()) return;
    setCreating(true); setErr(null);
    try {
      const r = await createKnowledgeBase(token, { name: name.trim() });
      const id = (r.data as any).id as string;
      setKbId(id);
      // Attach immediately so the mandatory-knowledge gate is satisfied even
      // before documents finish processing.
      await builderToggleKnowledge(token, agentId, id, true);
    } catch (e: any) {
      setErr(e?.message || L("Couldn't create the knowledge base.", "יצירת מאגר הידע נכשלה."));
    } finally { setCreating(false); }
  }

  async function addText() {
    if (!kbId || !docText.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await uploadKnowledgeDocument(token, kbId, { title: docTitle.trim() || "Note", content: docText.trim(), sourceType: "text" });
      await processKnowledgeDocument(token, kbId, (r.data as any).id).catch(() => {});
      setAdded((a) => [...a, docTitle.trim() || L("Pasted text", "טקסט שהודבק")]);
      setDocTitle(""); setDocText("");
    } catch (e: any) { setErr(e?.message || L("Couldn't add the text.", "הוספת הטקסט נכשלה.")); }
    finally { setBusy(false); }
  }

  async function addUrl() {
    if (!kbId || !docUrl.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await uploadKnowledgeDocument(token, kbId, { title: docUrl.trim(), content: "", sourceType: "url", sourceUrl: docUrl.trim() });
      await processKnowledgeDocument(token, kbId, (r.data as any).id).catch(() => {});
      setAdded((a) => [...a, docUrl.trim()]);
      setDocUrl("");
    } catch (e: any) { setErr(e?.message || L("Couldn't fetch the URL.", "שליפת הכתובת נכשלה.")); }
    finally { setBusy(false); }
  }

  async function onFile(file: File | null | undefined) {
    if (!kbId || !file) return;
    setBusy(true); setErr(null);
    try {
      const r = await uploadKnowledgeFile(token, kbId, file, file.name);
      await processKnowledgeDocument(token, kbId, (r.data as any).id).catch(() => {});
      setAdded((a) => [...a, file.name]);
    } catch (e: any) { setErr(e?.message || L("Upload failed.", "ההעלאה נכשלה.")); }
    finally { setBusy(false); }
  }

  const TabBtn = ({ id, label }: { id: "file" | "text" | "url"; label: string }) => (
    <button type="button" onClick={() => setTab(id)}
      className={clsx("px-3 py-1.5 text-sm rounded-lg transition", tab === id ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}>
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">{L("Add knowledge", "הוספת ידע")}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-4">
          {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{err}</div>}

          {!kbId ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">{L("Name this knowledge base (e.g. \"Policies\", \"Product FAQ\").", "תנו שם למאגר הידע (למשל \"מדיניות\", \"שאלות נפוצות\").")}</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createKb(); }}
                placeholder={L("Knowledge base name", "שם מאגר הידע")}
                autoFocus
                className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none"
              />
              <button onClick={createKb} disabled={creating || !name.trim()}
                className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-xl transition disabled:opacity-50">
                {creating ? L("Creating…", "יוצר…") : L("Create & attach", "צור וצרף")}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
                {L("Knowledge base created and attached. Add content below - or close and continue.", "מאגר הידע נוצר וצורף. הוסיפו תוכן למטה - או סגרו והמשיכו.")}
              </div>

              <div className="flex gap-2">
                <TabBtn id="file" label={L("Upload file", "העלאת קובץ")} />
                <TabBtn id="text" label={L("Paste text", "הדבקת טקסט")} />
                <TabBtn id="url" label={L("Add URL", "הוספת כתובת")} />
              </div>

              {tab === "file" && (
                <div>
                  <input type="file" disabled={busy}
                    onChange={(e) => onFile(e.target.files?.[0])}
                    className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100" />
                  <p className="text-xs text-gray-400 mt-1">{L("PDF, DOCX, TXT, MD…", "PDF, DOCX, TXT, MD…")}</p>
                </div>
              )}
              {tab === "text" && (
                <div className="space-y-2">
                  <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder={L("Title (optional)", "כותרת (רשות)")}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-violet-200" />
                  <textarea value={docText} onChange={(e) => setDocText(e.target.value)} rows={5} placeholder={L("Paste policy / FAQ / any text…", "הדביקו מדיניות / שאלות נפוצות / טקסט…")}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-violet-200 resize-none" />
                  <button onClick={addText} disabled={busy || !docText.trim()}
                    className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm rounded-lg disabled:opacity-50">{busy ? L("Adding…", "מוסיף…") : L("Add text", "הוסף טקסט")}</button>
                </div>
              )}
              {tab === "url" && (
                <div className="flex gap-2">
                  <input value={docUrl} onChange={(e) => setDocUrl(e.target.value)} placeholder="https://…"
                    className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-violet-200" />
                  <button onClick={addUrl} disabled={busy || !docUrl.trim()}
                    className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm rounded-lg disabled:opacity-50">{busy ? L("Fetching…", "שולף…") : L("Add", "הוסף")}</button>
                </div>
              )}

              {added.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{L("Added", "נוסף")}</div>
                  <ul className="text-sm text-gray-600 space-y-0.5">{added.map((t, i) => <li key={i} className="truncate">✓ {t}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">{L("Cancel", "ביטול")}</button>
          {kbId && (
            <button onClick={onAttached} className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-xl">{L("Done", "סיום")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Readiness Report ───────────────────────────────────────

function ReadinessReportPanel({ report, busy, onRerun, onClose, onAddKnowledge, onSaveLive, L }: {
  report: ReadinessReport;
  busy: boolean;
  onRerun: () => void;
  onClose: () => void;
  onAddKnowledge: () => void;
  onSaveLive: () => void;
  L: Tr;
}) {
  const scoreColor = report.score >= 80 ? "text-emerald-600" : report.score >= 50 ? "text-amber-600" : "text-red-600";
  const cov = (c: ReadinessQuestion["coverage"]) =>
    c === "full" ? { icon: "✅", cls: "text-emerald-600" } : c === "partial" ? { icon: "⚠️", cls: "text-amber-600" } : { icon: "❌", cls: "text-red-600" };

  function recAction(r: ReadinessRecommendation) {
    if (r.type === "add_knowledge" || r.type === "add_faq" || r.type === "add_business_data") {
      return <button onClick={onAddKnowledge} className="text-xs font-medium text-violet-600 hover:text-violet-700 shrink-0">{L("Add knowledge", "הוסף ידע")}</button>;
    }
    if (r.type === "connect_tool") {
      return <a href="/integrations" target="_blank" rel="noreferrer" className="text-xs font-medium text-violet-600 hover:text-violet-700 shrink-0">{L("Connect", "חבר")}</a>;
    }
    if (r.type === "create_workflow") {
      return <a href="/ai-studio" target="_blank" rel="noreferrer" className="text-xs font-medium text-violet-600 hover:text-violet-700 shrink-0">{L("Open", "פתח")}</a>;
    }
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 bg-gray-50 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex items-center gap-4 mb-6">
          <div className={clsx("text-5xl font-bold", scoreColor)}>{report.score}<span className="text-2xl">%</span></div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">{L("Readiness report", "דוח מוכנות")}</h2>
            <p className="text-sm text-gray-500">
              <span className="text-emerald-600">✅ {report.totals.full}</span>{" · "}
              <span className="text-amber-600">⚠️ {report.totals.partial}</span>{" · "}
              <span className="text-red-600">❌ {report.totals.none}</span>{" "}
              {L("of", "מתוך")} {report.totals.total} {L("questions", "שאלות")}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto text-sm text-gray-500 hover:text-gray-800">{L("← Back to editing", "→ חזרה לעריכה")}</button>
        </div>

        {report.recommendations.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 mb-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">{L("Recommended to close the gaps", "מומלץ לסגירת הפערים")}</h3>
            <ul className="space-y-2.5">
              {report.recommendations.map((r, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-0.5 text-violet-500">•</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-800">{r.title}</div>
                    {r.detail && <div className="text-xs text-gray-500">{r.detail}</div>}
                  </div>
                  {recAction(r)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 mb-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">{L("Questions customers will ask", "שאלות שלקוחות ישאלו")}</h3>
          <ul className="divide-y divide-gray-100">
            {report.questions.map((q, i) => {
              const c = cov(q.coverage);
              return (
                <li key={i} className="py-2.5 flex items-start gap-3">
                  <span className={clsx("shrink-0", c.cls)}>{c.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-800">{q.question}</div>
                    {q.reason && <div className="text-xs text-gray-500 mt-0.5">{q.reason}</div>}
                  </div>
                  {q.coverage !== "full" && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded-full px-2 py-0.5">{q.gapType}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex items-center justify-between gap-3">
          <button onClick={onRerun} disabled={busy}
            className="px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50">
            {busy ? L("Re-running…", "מריץ מחדש…") : L("↻ Re-run test", "↻ הרצה מחדש")}
          </button>
          <button onClick={onSaveLive}
            className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-xl shadow-sm">
            {L("Save & go live", "שמירה והפעלה")} →
          </button>
        </div>
      </div>
    </div>
  );
}
