"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/context/AuthContext";
import { overrideConversationStage, type CrmActiveStage } from "@/lib/api-crm";

interface Props {
  stage: CrmActiveStage | null | undefined;
  conversationId: string | null;
  /** Called after a manual override succeeds so the parent can refresh CRM context. */
  onStageChanged?: () => void;
}

interface FrameLike {
  conversationId?: string;
  missingFields?: Array<{ field: string; required?: boolean }>;
}

/**
 * Stage progress card for the live workspace.
 *
 * Shows:
 *   - Current pipeline stage (label + how it was determined)
 *   - Stage goal (what the rep should achieve on this call)
 *   - Checklist of required data fields with ✓ as they get filled.
 *     "Filled" is derived by subtracting whatever's still in the live
 *     ConversationStateFrame.missingFields[] from the configured
 *     exit-criteria field set.
 *   - Required questions checklist (heuristic: a transcript marker
 *     containing the question's key phrase counts as asked).
 *   - "Next: X" pill - the stage we're trying to advance to.
 *
 * Hidden entirely when no funnel is configured (stage = null).
 */
export function StageProgressCard({ stage, conversationId, onStageChanged }: Props) {
  const { token } = useAuth();
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  // Reset the override panel state whenever the active stage changes.
  useEffect(() => {
    setOverrideOpen(false);
    setOverrideTarget("");
    setOverrideReason("");
    setOverrideError(null);
  }, [stage?.id]);

  async function handleOverride() {
    if (!token || !conversationId || !overrideTarget) return;
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      const result = await overrideConversationStage(token, conversationId, {
        to: overrideTarget,
        reason: overrideReason.trim() || undefined,
      });
      if (!result.vendorWriteOk) {
        setOverrideError(result.vendorWriteError || "Vendor write failed");
        return;
      }
      setOverrideOpen(false);
      setOverrideTarget("");
      setOverrideReason("");
      onStageChanged?.();
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : "Override failed");
    } finally {
      setOverrideBusy(false);
    }
  }

  useEffect(() => {
    if (!conversationId) return;
    const socket = getSocket();
    if (!socket) return;
    const onFrame = (data: unknown) => {
      const d = data as { frame?: FrameLike };
      const f = d?.frame;
      if (!f || f.conversationId !== conversationId) return;
      const next = new Set<string>();
      for (const m of f.missingFields || []) {
        if (m?.field) next.add(m.field);
      }
      setMissing(next);
    };
    socket.on("voice.frame.updated", onFrame);
    return () => { socket.off("voice.frame.updated", onFrame); };
  }, [conversationId]);

  // Clear cached "missing" set whenever the active conversation changes
  // so a previous call's state can't leak in.
  useEffect(() => { setMissing(new Set()); }, [conversationId]);

  const progress = useMemo(() => {
    if (!stage) return null;
    const requiredFields = stage.required_data_fields.filter((f) => f.required);
    const requiredQuestions = stage.required_questions.filter((q) => q.required);
    const exitFields = stage.exit_criteria?.mustHaveFields ?? [];

    // Union of "required fields configured ON the stage" + "exit criteria
    // fields". Some setups configure one or the other; we want both checked.
    const fieldKeys = new Set<string>([
      ...requiredFields.map((f) => f.field),
      ...exitFields,
    ]);
    const fieldChecklist = Array.from(fieldKeys).map((field) => ({
      field,
      label:
        requiredFields.find((f) => f.field === field)?.label ?? field,
      filled: !missing.has(field),
    }));

    return {
      fieldChecklist,
      requiredQuestions,
    };
  }, [stage, missing]);

  if (!stage) return null;

  const filledCount = progress?.fieldChecklist.filter((c) => c.filled).length ?? 0;
  const totalCount = progress?.fieldChecklist.length ?? 0;
  const pct = totalCount === 0 ? 0 : Math.round((filledCount / totalCount) * 100);

  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
          <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-700">
            Stage
          </span>
        </div>
        <span
          className="text-[10px] text-gray-400 truncate"
          title={`source: ${stage.source}${stage.vendor_stage ? ` · vendor: ${stage.vendor_stage}` : ""}`}
        >
          {stage.source === "crm-match" ? "from CRM" : stage.source === "crm-fallback-first" ? "first stage" : "no CRM stage"}
        </span>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-sm font-semibold text-gray-900 truncate">{stage.label}</span>
          {stage.next && (
            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-indigo-700 bg-indigo-50 ring-1 ring-indigo-100 px-1.5 py-0.5 rounded-full">
              <span className="opacity-70">next:</span>
              <span className="font-semibold">{stage.next.label}</span>
            </span>
          )}
        </div>
        {stage.goal && (
          <p className="text-[12px] text-gray-700 leading-snug mb-2.5">{stage.goal}</p>
        )}

        {/* Progress bar - fills as required data fields land. */}
        {totalCount > 0 && (
          <div className="mb-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">
                Progress to advance
              </span>
              <span className="text-[10px] text-gray-500 tabular-nums">
                {filledCount}/{totalCount}
              </span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={clsx(
                  "h-full transition-all duration-500 rounded-full",
                  pct >= 80 ? "bg-emerald-400" : pct >= 50 ? "bg-amber-400" : "bg-indigo-400",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Required data fields checklist. */}
        {progress && progress.fieldChecklist.length > 0 && (
          <ul className="space-y-1 mb-2">
            {progress.fieldChecklist.map((c) => (
              <ChecklistRow key={`field:${c.field}`} text={c.label} done={c.filled} />
            ))}
          </ul>
        )}

        {/* Required questions checklist. We can't observe "did the rep
            actually ask this" cheaply, so it renders as an unchecked
            reminder list. The cue projector handles enforcement. */}
        {progress && progress.requiredQuestions.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
              Must-ask questions
            </div>
            <ul className="space-y-1">
              {progress.requiredQuestions.map((q) => (
                <ChecklistRow key={`q:${q.id}`} text={q.text} done={false} muted />
              ))}
            </ul>
          </div>
        )}

        {/* Exit signals - surface negative signals as warnings since they
            block the transition entirely. */}
        {stage.exit_criteria?.negativeSignals && stage.exit_criteria.negativeSignals.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            <div className="text-[10px] uppercase tracking-wider text-rose-600 mb-1">
              Blocks advance if heard
            </div>
            <div className="flex flex-wrap gap-1">
              {stage.exit_criteria.negativeSignals.slice(0, 5).map((s) => (
                <span
                  key={s}
                  className="text-[10px] px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-700 ring-1 ring-rose-100"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Manual override - collapsed by default. Reps use this when the
            post-call automation hasn't fired yet (still mid-call) or to
            correct a wrong auto-advance. Writes immediately to the CRM
            via the same vendor adapter path. */}
        <div className="mt-2 pt-2 border-t border-gray-100">
          {!overrideOpen ? (
            <button
              type="button"
              onClick={() => setOverrideOpen(true)}
              className="text-[11px] text-indigo-700 hover:text-indigo-900 font-medium inline-flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
              Override stage manually
            </button>
          ) : (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">
                Override stage
              </div>
              <select
                value={overrideTarget}
                onChange={(e) => setOverrideTarget(e.target.value)}
                disabled={overrideBusy}
                className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
              >
                <option value="">Choose stage…</option>
                {stage.all_stages
                  .filter((s) => s.id !== stage.id)
                  .map((s) => (
                    <option key={s.id} value={s.id} disabled={!s.crmValue}>
                      {s.label}
                      {!s.crmValue ? "  (no CRM value)" : ""}
                    </option>
                  ))}
              </select>
              <input
                type="text"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Reason (optional)"
                disabled={overrideBusy}
                className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
              />
              {overrideError && (
                <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded px-2 py-1">
                  {overrideError}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleOverride}
                  disabled={overrideBusy || !overrideTarget}
                  className={clsx(
                    "px-2.5 py-1 rounded-md text-[11px] font-semibold transition",
                    overrideBusy || !overrideTarget
                      ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                      : "bg-indigo-600 text-white hover:bg-indigo-700",
                  )}
                >
                  {overrideBusy ? "Applying…" : "Apply"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOverrideOpen(false);
                    setOverrideTarget("");
                    setOverrideReason("");
                    setOverrideError(null);
                  }}
                  disabled={overrideBusy}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium text-gray-600 hover:bg-gray-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({ text, done, muted }: { text: string; done: boolean; muted?: boolean }) {
  return (
    <li className="flex items-start gap-2 text-[12px] leading-snug">
      <span
        className={clsx(
          "shrink-0 mt-0.5 w-3.5 h-3.5 rounded-full inline-flex items-center justify-center text-[10px]",
          done ? "bg-emerald-100 text-emerald-700" : muted ? "bg-gray-100 text-gray-400" : "bg-gray-100 text-gray-400",
        )}
      >
        {done ? "✓" : "·"}
      </span>
      <span className={clsx(done ? "text-gray-500 line-through" : "text-gray-800", muted && "text-gray-600")}>
        {text}
      </span>
    </li>
  );
}
