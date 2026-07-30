"use client";

// Shared Readiness Report - the employee's ongoing "what am I still missing"
// surface. Used in three places: the hiring wizard's finish step, the AI
// Studio employee cards (score badge → modal), and the employee editor's
// "what this employee can do" section. One component so the report reads the
// same everywhere and every gap is ACTIONABLE in place:
//   • answer a missing question right here (saved into the knowledge base)
//   • paste a URL as a knowledge source (crawled server-side)
//   • jump to connect a knowledge integration (Drive / Confluence)
// Nothing here requires leaving the flow; after resolving, re-run the test.

import { useState } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import KnowledgeDrawer, { type KnowledgeEntryMode } from "./KnowledgeDrawer";
import type { ReadinessReport, ReadinessQuestion, ReadinessRecommendation } from "@/lib/gotcha-api";
import { uploadKnowledgeDocument, processKnowledgeDocument } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";

export function readinessScoreColor(score: number): string {
  return score >= 80 ? "text-emerald-600" : score >= 50 ? "text-amber-600" : "text-red-600";
}
export function readinessBadgeTone(score: number): string {
  return score >= 80
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : score >= 50
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-red-50 text-red-600 border-red-200";
}

// ─── One gap's inline resolver (answer / URL) ───────────────
function GapResolver({ token, kbId, question, onResolved, L, onOpenKnowledge }: {
  token: string;
  kbId: string | null;
  question: string;
  onResolved: () => void;
  L: (en: string, he: string) => string;
  /** Opens the shared Knowledge Manager in place, in the requested mode. */
  onOpenKnowledge?: (mode: KnowledgeEntryMode) => void;
}) {
  const [mode, setMode] = useState<"idle" | "answer" | "url">("idle");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!kbId || !value.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const payload = mode === "answer"
        ? { title: question.slice(0, 140), content: `Q: ${question}\nA: ${value.trim()}`, sourceType: "text" }
        : { title: "", content: "", sourceType: "url", sourceUrl: value.trim() };
      const doc = await uploadKnowledgeDocument(token, kbId, payload as any);
      const docId = (doc as any)?.data?.id;
      // No id means the document was never created - reporting "taught" here
      // would be a lie. The server also auto-processes on create; this call is
      // a belt-and-braces retrigger, so only a hard failure should surface.
      if (!docId) throw new Error(L("The answer wasn't saved. Try again.", "התשובה לא נשמרה. נסו שוב."));
      await processKnowledgeDocument(token, kbId, docId);
      onResolved();
    } catch (err: any) {
      setError(err?.message || L("Couldn't save. Try again.", "לא הצלחתי לשמור. נסו שוב."));
    } finally {
      setSaving(false);
    }
  }

  if (!kbId) {
    return <span className="text-[11px] text-gray-400">{L("Attach a knowledge base to resolve gaps here", "חברו מאגר ידע כדי לסגור פערים מכאן")}</span>;
  }

  if (mode === "idle") {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => { setMode("answer"); setValue(""); }} className="text-xs font-medium text-violet-600 hover:text-violet-700">
          {L("Answer it now", "ענו על זה עכשיו")}
        </button>
        <span className="text-gray-300">·</span>
        <button type="button" onClick={() => { setMode("url"); setValue(""); }} className="text-xs font-medium text-violet-600 hover:text-violet-700">
          {L("Add a link", "הוסיפו קישור")}
        </button>
        <span className="text-gray-300">·</span>
        {/* Opens the shared Knowledge Manager in place. This used to be a
            new-tab link, which meant abandoning the report (and any hiring
            progress behind it) to connect a source. */}
        <button
          type="button"
          onClick={() => onOpenKnowledge?.("drive")}
          className="text-xs font-medium text-violet-600 hover:text-violet-700"
        >
          {L("Connect a source", "חברו מקור ידע")}
        </button>
      </span>
    );
  }

  return (
    <div className="mt-1.5 w-full">
      {mode === "answer" ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={2}
          autoFocus
          placeholder={L("Write the answer the employee should give…", "כתבו את התשובה שהעובד/ת אמור/ה לתת…")}
          className="w-full resize-none rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-200"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          dir="ltr"
          autoFocus
          placeholder="https://…"
          className="w-full rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-200"
        />
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" onClick={save} disabled={!value.trim() || saving}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50">
          {saving ? L("Saving…", "שומר…") : L("Teach the employee", "למדו את העובד/ת")}
        </button>
        <button type="button" onClick={() => { setMode("idle"); setError(""); }} className="text-xs text-gray-400 hover:text-gray-600">
          {L("Cancel", "ביטול")}
        </button>
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    </div>
  );
}

// ─── The report body (reusable everywhere) ──────────────────
export function ReadinessReportView({ report, token, kbId, busy, onRerun, onAddKnowledge, onOpenKnowledge }: {
  report: ReadinessReport;
  token: string;
  /** First attached knowledge base of this employee - target for inline fixes. */
  kbId: string | null;
  busy?: boolean;
  onRerun: () => void;
  /** Optional override for "add knowledge" recommendations (the wizard opens its KB step). */
  onAddKnowledge?: () => void;
  /** Opens the shared Knowledge Manager in place, in the requested mode. */
  onOpenKnowledge?: (mode: KnowledgeEntryMode) => void;
}) {
  const { locale } = useI18n();
  const he = locale === "he";
  const L = (en: string, hebrew: string) => (he ? hebrew : en);
  const [resolved, setResolved] = useState<Set<number>>(new Set());

  const scoreColor = readinessScoreColor(report.score);
  const cov = (c: ReadinessQuestion["coverage"]) =>
    c === "full" ? { icon: "✅", cls: "text-emerald-600" } : c === "partial" ? { icon: "⚠️", cls: "text-amber-600" } : { icon: "❌", cls: "text-red-600" };

  function recAction(r: ReadinessRecommendation) {
    if (r.type === "add_knowledge" || r.type === "add_faq" || r.type === "add_business_data") {
      // No navigation in either branch: the caller's own handler if it has
      // one, otherwise the shared manager in place.
      const open = onAddKnowledge ?? (() => onOpenKnowledge?.("upload"));
      return (
        <button onClick={open} className="text-xs font-medium text-violet-600 hover:text-violet-700 shrink-0">{L("Add knowledge", "הוסיפו ידע")}</button>
      );
    }
    if (r.type === "connect_tool") {
      return <a href="/ai-studio?tab=tools" target="_blank" rel="noreferrer" className="text-xs font-medium text-violet-600 hover:text-violet-700 shrink-0">{L("Connect", "חברו")}</a>;
    }
    if (r.type === "create_workflow") {
      return <a href="/ai-studio?tab=processes" target="_blank" rel="noreferrer" className="text-xs font-medium text-violet-600 hover:text-violet-700 shrink-0">{L("Open", "פתחו")}</a>;
    }
    return null;
  }

  const resolvedCount = resolved.size;

  return (
    <div dir={he ? "rtl" : "ltr"}>
      <div className="flex items-center gap-4 mb-6">
        <div className={clsx("text-5xl font-bold", scoreColor)}>{report.score}<span className="text-2xl">%</span></div>
        <div>
          {/* Re-run lives in the header's trailing corner - right in LTR, left
              in RTL via `ms-auto`, which follows the dir on the wrapper. It was
              a grey text link buried under the whole (long, scrolling) report,
              so the one action that refreshes the score was the hardest to find. */}
          <h2 className="text-xl font-bold text-gray-900">{L("Readiness report", "דוח מוכנות")}</h2>
          <p className="text-sm text-gray-500">
            <span className="text-emerald-600">✅ {report.totals.full}</span>{" · "}
            <span className="text-amber-600">⚠️ {report.totals.partial}</span>{" · "}
            <span className="text-red-600">❌ {report.totals.none}</span>{" "}
            {L("of", "מתוך")} {report.totals.total} {L("questions", "שאלות")}
            {report.generatedAt && (
              <span className="text-gray-400"> · {L("last run", "הרצה אחרונה")} {new Date(report.generatedAt).toLocaleDateString(he ? "he-IL" : "en-US")}</span>
            )}
          </p>
        </div>
        <button
          onClick={onRerun}
          disabled={busy}
          className="ms-auto shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50"
        >
          <svg className={clsx("w-3.5 h-3.5", busy && "animate-spin")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
          </svg>
          {busy ? L("Re-running…", "מריץ מחדש…") : L("Re-run test", "הרצה מחדש")}
        </button>
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
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">{L("Questions customers will ask", "שאלות שלקוחות ישאלו")}</h3>
          {resolvedCount > 0 && (
            <span className="text-[11px] font-medium text-emerald-600">
              {he ? `${resolvedCount} נסגרו - הריצו שוב כדי לעדכן את הציון` : `${resolvedCount} resolved - re-run to refresh the score`}
            </span>
          )}
        </div>
        <ul className="divide-y divide-gray-100">
          {report.questions.map((q, i) => {
            const c = cov(q.coverage);
            const isGap = q.coverage !== "full" && (q.gapType === "knowledge" || q.gapType === "data");
            const done = resolved.has(i);
            return (
              <li key={i} className="py-2.5">
                <div className="flex items-start gap-3">
                  <span className={clsx("shrink-0", done ? "text-emerald-600" : c.cls)}>{done ? "✅" : c.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-800">{q.question}</div>
                    {q.reason && !done && <div className="text-xs text-gray-500 mt-0.5">{q.reason}</div>}
                    {done && <div className="text-xs text-emerald-600 mt-0.5">{L("Taught - will count on the next run", "נלמד - ייספר בהרצה הבאה")}</div>}
                    {isGap && !done && (
                      <div className="mt-1">
                        <GapResolver token={token} kbId={kbId} question={q.question} L={L} onOpenKnowledge={onOpenKnowledge}
                          onResolved={() => setResolved((prev) => new Set(prev).add(i))} />
                      </div>
                    )}
                  </div>
                  {q.coverage !== "full" && !done && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded-full px-2 py-0.5">{q.gapType}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

    </div>
  );
}

// ─── Modal wrapper (AI Studio cards / employee editor) ──────
export function ReadinessReportModal({ open, onClose, report, token, kbId, busy, onRerun, agentName }: {
  open: boolean;
  onClose: () => void;
  report: ReadinessReport | null;
  token: string;
  kbId: string | null;
  busy?: boolean;
  onRerun: () => void;
  agentName?: string;
}) {
  const { locale } = useI18n();
  const he = locale === "he";

  // The shared Knowledge Manager, opened from inside the report. Nothing here
  // navigates: the report (and whatever is behind it, including an in-progress
  // hire) stays exactly where it was, and a successful add re-runs readiness so
  // the score the user is looking at stops being stale.
  const [knowledgeMode, setKnowledgeMode] = useState<KnowledgeEntryMode | null>(null);

  // Scroll lock, focus trap, focus restore, Escape/backdrop and the portal all
  // come from the shared Modal - this component previously hand-rolled the
  // overlay, which is how the page behind it ended up scrolling with the
  // report. Do NOT re-add a local scroll lock here: nesting two locks is what
  // the shared ref-counted implementation exists to prevent.
  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="max-w-3xl"
      dir={he ? "rtl" : "ltr"}
      title={he ? "דוח מוכנות" : "Readiness report"}
      subtitle={agentName}
      data-testid="readiness-report-modal"
    >
      {report ? (
        <ReadinessReportView
          report={report}
          token={token}
          kbId={kbId}
          busy={busy}
          onRerun={onRerun}
          onOpenKnowledge={setKnowledgeMode}
        />
      ) : (
        <div className="py-16 text-center">
          <p className="text-sm text-gray-500 mb-4">{he ? "עוד לא נוצר דוח מוכנות לעובד/ת הזה." : "No readiness report yet for this employee."}</p>
          <button onClick={onRerun} disabled={busy}
            className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-xl shadow-sm disabled:opacity-50">
            {busy ? (he ? "מריץ…" : "Running…") : (he ? "הריצו בדיקת מוכנות" : "Run readiness test")}
          </button>
        </div>
      )}

      {/* ONE shared manager, opened in the mode the report asked for. */}
      <KnowledgeDrawer
        isOpen={knowledgeMode !== null}
        onClose={() => setKnowledgeMode(null)}
        initialMode={knowledgeMode ?? "browse"}
        contextLabel={he ? "מדוח המוכנות" : "From the readiness report"}
        onAdded={() => {
          // The score on screen is now out of date. Re-run rather than leave the
          // user looking at a number that no longer reflects their knowledge.
          onRerun();
        }}
      />
    </Modal>
  );
}
