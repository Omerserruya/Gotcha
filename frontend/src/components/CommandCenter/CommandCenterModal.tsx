"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  executePlan,
  runAgentStream,
  ExecutionPlan,
  PlannedAction,
} from "@/lib/gotcha-api";
import { useI18n } from "@/context/I18nContext";
import SiriAvatar, { OrbState } from "./SiriAvatar";

interface Props {
  open: boolean;
  onClose: () => void;
  token: string;
  context: { conversationId?: string; contactId?: string };
}

type TurnKind = "user" | "assistant" | "system";

interface Turn {
  id: string;
  kind: TurnKind;
  text: string;                      // the textual content (user prompt, assistant answer or plan summary)
  plan?: ExecutionPlan | null;       // present on execution-mode assistant turns
  preview?: unknown[];               // dry-run results from /simulate
  executed?: boolean;                // set after Approve & run succeeds
  executedError?: string;
  executing?: boolean;
}

/**
 * OS-level command palette modal with a Siri-style avatar + threaded
 * conversation. Each user turn adds a row; each /simulate response
 * either chats back (assistant turn with text) or proposes a plan
 * (assistant turn with an inline plan card + Approve/Reject buttons).
 * The composer stays at the top with the orb so the user can always
 * type the next turn without hunting for the input.
 */
export default function CommandCenterModal({ open, onClose, token, context }: Props) {
  const { t, locale, dir } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  // Stable per-open session id — groups memory rows server-side. Reset on close.
  const sessionIdRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);

  // Derive orb state from what's currently happening. If any turn is
  // mid-execute, show that; else thinking if loading; else ready if
  // there's an unresolved plan; else approval if pending; else idle.
  const orbState: OrbState = useMemo(() => {
    if (error) return "error";
    if (loading) return "thinking";
    const anyExec = turns.some((t) => t.executing);
    if (anyExec) return "thinking";
    const last = [...turns].reverse().find((t) => t.kind === "assistant");
    if (last?.plan && !last.executed && !last.executedError) {
      return last.plan.requiresApproval ? "approval" : "ready";
    }
    return "idle";
  }, [turns, loading, error]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
      setError(null);
      // Mint a fresh session id for this modal-open. The backend memory
      // stays per (tenant, user) and is keyed by session for grouping.
      if (!sessionIdRef.current) {
        sessionIdRef.current = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      }
    }
  }, [open]);

  // Reset the session each time the modal closes.
  useEffect(() => {
    if (!open) {
      // Cancel any in-flight stream before tearing down the UI.
      abortRef.current?.abort();
      abortRef.current = null;
      setTurns([]);
      setPrompt("");
      setError(null);
      sessionIdRef.current = "";
    }
  }, [open]);

  // Auto-scroll the transcript on new turns.
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [turns.length, loading]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function addTurn(turn: Omit<Turn, "id">): string {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setTurns((prev) => [...prev, { id, ...turn }]);
    return id;
  }

  function patchTurn(id: string, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function runSimulate() {
    const text = prompt.trim();
    if (!text || loading) return;
    setError(null);
    addTurn({ kind: "user", text });
    setPrompt("");
    setLoading(true);

    // Single in-progress assistant turn that we mutate as tokens arrive.
    const assistantTurnId = addTurn({ kind: "assistant", text: "" });

    const abort = new AbortController();
    abortRef.current = abort;

    let streamed = "";
    let earlyError: string | null = null;
    let proposedPlanSummary: string | null = null;

    try {
      await runAgentStream(
        token,
        {
          message: text,
          sessionId: sessionIdRef.current,
          client: {
            route: typeof window !== "undefined" ? window.location.pathname : null,
            conversationId: context.conversationId ?? null,
            contactId: context.contactId ?? null,
            extras: { locale },
          },
        },
        (ev) => {
          switch (ev.type) {
            case "token":
              streamed += ev.text;
              patchTurn(assistantTurnId, { text: streamed });
              break;
            case "tool_start":
              addTurn({
                kind: "system",
                text: `… ${ev.name.replace(/^integration_/, "")}`,
              });
              break;
            case "tool_end":
              if (!ev.ok) {
                addTurn({
                  kind: "system",
                  text: `✗ ${ev.name.replace(/^integration_/, "")} — ${ev.resultSummary}`,
                });
              }
              break;
            case "plan_proposed":
              proposedPlanSummary = ev.summary;
              addTurn({
                kind: "system",
                text: `📋 ${t("commandCenter.planProposed") || "Plan ready for approval"}: ${ev.summary}`,
              });
              break;
            case "awaiting_approval":
              addTurn({
                kind: "system",
                text: `⏸ ${t("commandCenter.awaitingApproval") || "Action paused for approval"}: ${ev.tool}`,
              });
              break;
            case "denied":
              addTurn({
                kind: "system",
                text: `🚫 ${ev.tool} — ${ev.reason}`,
              });
              break;
            case "error":
              earlyError = ev.message;
              break;
            case "done":
              // Final turn already accumulated via tokens; nothing to do.
              break;
            default:
              break;
          }
        },
        abort.signal,
      );
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        earlyError = e?.message ?? (t("commandCenter.errorSimulate") || "agent error");
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }

    if (earlyError) setError(earlyError);
    // Suppress unused-variable lint for the captured plan summary — used by
    // the system turn above; the modal's PlanCard now lives in the approvals
    // surface, not inline (since propose_plan creates an ApprovalRequest).
    void proposedPlanSummary;
  }

  async function runExecute(turnId: string, plan: ExecutionPlan) {
    patchTurn(turnId, { executing: true });
    setError(null);
    try {
      await executePlan(token, plan, { approved: true });
      patchTurn(turnId, { executing: false, executed: true });
      addTurn({ kind: "system", text: "✓ " + (t("commandCenter.executed") || "Executed") });
    } catch (e: any) {
      const msg = e?.message ?? t("commandCenter.errorExecute");
      patchTurn(turnId, { executing: false, executedError: msg });
      setError(msg);
    }
  }

  function dismissPlan(turnId: string) {
    patchTurn(turnId, { executed: true });
    addTurn({
      kind: "system",
      text: t("commandCenter.dismissed") || "Dismissed — keep chatting to refine.",
    });
  }

  if (!mounted || !open) return null;

  const hasHistory = turns.length > 0;

  const examples = [
    context.conversationId
      ? t("commandCenter.exampleConversation1")
      : t("commandCenter.exampleGlobal1"),
    context.conversationId
      ? t("commandCenter.exampleConversation2")
      : t("commandCenter.exampleGlobal2"),
    context.conversationId
      ? "✨ Draft a reply: apologize for the delay and offer a 10% discount"
      : "✨ Draft a message: friendly renewal reminder with the customer's name",
  ];

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      dir={dir}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,12,20,0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
    >
      <div
        style={{
          width: "min(680px, 94vw)",
          background: "#111317",
          color: "#f2f4f7",
          borderRadius: 16,
          border: "1px solid #242831",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "80vh",
          boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
        }}
      >
        {/* Composer header: orb + input + submit */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSimulate();
          }}
          style={{
            padding: "12px 14px",
            borderBottom: "1px solid #1e222a",
            background: "linear-gradient(180deg,#15181f 0%,#111317 100%)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <SiriAvatar state={orbState} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "#8b95a7",
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  marginBottom: 2,
                }}
              >
                {t("commandCenter.title")}
                {context.conversationId && (
                  <span style={{ marginInlineStart: 8, color: "#64748b" }}>
                    · conv {context.conversationId.slice(0, 8)}
                  </span>
                )}
                {context.contactId && (
                  <span style={{ marginInlineStart: 8, color: "#64748b" }}>
                    · contact {context.contactId.slice(0, 8)}
                  </span>
                )}
              </div>
              <input
                ref={inputRef}
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                dir={dir}
                placeholder={
                  hasHistory
                    ? t("commandCenter.placeholderFollowUp") || "Continue the conversation…"
                    : context.conversationId
                      ? t("commandCenter.placeholderConversation")
                      : context.contactId
                        ? t("commandCenter.placeholderCustomer")
                        : t("commandCenter.placeholderGlobal")
                }
                disabled={loading}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  fontSize: 18,
                  color: "#f2f4f7",
                  padding: 0,
                }}
              />
            </div>
            <button
              type="submit"
              disabled={loading || !prompt.trim()}
              aria-label="Send"
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                border: "none",
                background: prompt.trim() && !loading ? "#6366f1" : "#1e222a",
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: prompt.trim() && !loading ? "pointer" : "default",
                transition: "background 150ms ease",
                flexShrink: 0,
              }}
            >
              {loading ? (
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: "2px solid rgba(255,255,255,0.35)",
                    borderTopColor: "#fff",
                    animation: "cmdSpin 0.8s linear infinite",
                  }}
                />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 5l7 7-7 7" />
                </svg>
              )}
            </button>
          </div>
          <style>{`@keyframes cmdSpin { to { transform: rotate(360deg); } }`}</style>
        </form>

        {/* Transcript */}
        <div ref={scrollerRef} style={{ padding: 14, overflow: "auto", flex: 1 }}>
          {!hasHistory && !loading && !error && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  marginBottom: 10,
                }}
              >
                {t("commandCenter.examplesHeader")}
              </div>
              {examples.map((ex, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setPrompt(ex);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: dir === "rtl" ? "right" : "left",
                    background: "#181b22",
                    border: "1px solid #222631",
                    color: "#cbd5e1",
                    padding: "10px 12px",
                    borderRadius: 10,
                    marginBottom: 6,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          {turns.map((turn) => {
            if (turn.kind === "system") {
              return (
                <div
                  key={turn.id}
                  style={{
                    fontSize: 11,
                    color: "#64748b",
                    textAlign: "center",
                    padding: "8px 0",
                  }}
                >
                  {turn.text}
                </div>
              );
            }
            if (turn.kind === "user") {
              return (
                <div
                  key={turn.id}
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    margin: "6px 0",
                  }}
                >
                  <div
                    dir="auto"
                    style={{
                      maxWidth: "82%",
                      background: "#1f2937",
                      color: "#e5e7eb",
                      padding: "8px 12px",
                      borderRadius: 12,
                      fontSize: 13,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {turn.text}
                  </div>
                </div>
              );
            }
            // assistant
            return (
              <div
                key={turn.id}
                style={{
                  display: "flex",
                  justifyContent: "flex-start",
                  margin: "8px 0",
                }}
              >
                <div style={{ maxWidth: "94%", minWidth: 0 }}>
                  {!turn.plan && (
                    <div
                      dir="auto"
                      style={{
                        background: "#15181f",
                        border: "1px solid #1f242e",
                        color: "#e2e8f0",
                        padding: "10px 12px",
                        borderRadius: 12,
                        fontSize: 13.5,
                        lineHeight: 1.55,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {turn.text}
                    </div>
                  )}
                  {turn.plan && (
                    <PlanCard
                      turn={turn}
                      onApprove={() => runExecute(turn.id, turn.plan!)}
                      onDismiss={() => dismissPlan(turn.id)}
                      labels={{
                        plan: t("commandCenter.plan") || "Plan",
                        requiresApproval:
                          t("commandCenter.requiresApproval") || "Requires approval",
                        approveExecute:
                          t("commandCenter.approveExecute") || "Approve & execute",
                        execute: t("commandCenter.execute") || "Execute",
                        executing: t("commandCenter.executing") || "Running…",
                        dismiss: t("commandCenter.reset") || "Dismiss",
                        dryRun:
                          t("commandCenter.dryRunPreview") || "Dry-run preview",
                        executed: t("commandCenter.executed") || "Executed",
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}

          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 2px",
                color: "#94a3b8",
                fontSize: 12,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#818cf8",
                  animation: "cmdDot 1.2s ease-in-out infinite",
                }}
              />
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#a78bfa",
                  animation: "cmdDot 1.2s ease-in-out 0.15s infinite",
                }}
              />
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#f472b6",
                  animation: "cmdDot 1.2s ease-in-out 0.3s infinite",
                }}
              />
              <span style={{ marginInlineStart: 4 }}>
                {t("commandCenter.planning") || "Thinking…"}
              </span>
              <style>{`@keyframes cmdDot { 0%,100% { opacity: 0.3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }`}</style>
            </div>
          )}

          {error && (
            <div
              style={{
                marginTop: 8,
                background: "#2a1414",
                border: "1px solid #4b1d1d",
                color: "#fecaca",
                padding: "8px 10px",
                borderRadius: 10,
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: "8px 14px",
            borderTop: "1px solid #1e222a",
            fontSize: 11,
            color: "#64748b",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span>{t("commandCenter.hintClose")}</span>
          <span>{t("commandCenter.hintPreview")}</span>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

// ─── Plan card (inline assistant turn) ─────────────────────

function PlanCard({
  turn,
  onApprove,
  onDismiss,
  labels,
}: {
  turn: Turn;
  onApprove: () => void;
  onDismiss: () => void;
  labels: Record<string, string>;
}) {
  const plan = turn.plan!;
  return (
    <div
      style={{
        background: "#161a22",
        border: "1px solid #222a36",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #1f242e",
          background: plan.requiresApproval
            ? "linear-gradient(90deg,#3a1f0b 0%,#1b1510 100%)"
            : "linear-gradient(90deg,#0f2320 0%,#121a19 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: plan.requiresApproval ? "#fbbf24" : "#86efac",
              fontWeight: 700,
            }}
          >
            {labels.plan}
          </span>
          <span
            dir="auto"
            style={{
              fontSize: 13,
              color: "#e5e7eb",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {plan.summary}
          </span>
        </div>
        {plan.requiresApproval && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "#fbbf24",
              background: "#3a2c0a",
              border: "1px solid #553d14",
              padding: "2px 8px",
              borderRadius: 999,
              flexShrink: 0,
            }}
          >
            {labels.requiresApproval}
          </span>
        )}
      </div>

      <ol style={{ listStyle: "none", padding: 10, margin: 0 }}>
        {plan.steps.map((s: PlannedAction, i: number) => (
          <li
            key={i}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "#11151c",
              marginBottom: 6,
              border: "1px solid #1c222c",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <code style={{ fontSize: 12, color: "#93c5fd" }}>{s.tool}</code>
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background:
                    s.riskLevel === "high"
                      ? "#3f1d1d"
                      : s.riskLevel === "medium"
                        ? "#3a2e1a"
                        : "#1a2b22",
                  color:
                    s.riskLevel === "high"
                      ? "#fca5a5"
                      : s.riskLevel === "medium"
                        ? "#fbbf24"
                        : "#86efac",
                }}
              >
                {s.riskLevel}
              </span>
            </div>
            <div
              dir="auto"
              style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}
            >
              {s.reason}
            </div>
          </li>
        ))}
      </ol>

      {turn.preview && (turn.preview as any[]).length > 0 && (
        <details style={{ padding: "0 12px 10px", fontSize: 11, color: "#94a3b8" }}>
          <summary style={{ cursor: "pointer" }}>{labels.dryRun}</summary>
          <pre
            style={{
              fontSize: 11,
              whiteSpace: "pre-wrap",
              background: "#0c0f14",
              padding: 8,
              borderRadius: 6,
              marginTop: 6,
            }}
          >
            {JSON.stringify(turn.preview, null, 2)}
          </pre>
        </details>
      )}

      <div
        style={{
          padding: "10px 12px",
          borderTop: "1px solid #1e222a",
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        {turn.executed ? (
          <span style={{ fontSize: 12, color: "#86efac" }}>
            ✓ {labels.executed}
          </span>
        ) : turn.executedError ? (
          <span style={{ fontSize: 12, color: "#fca5a5" }}>
            ✗ {turn.executedError}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={onDismiss}
              disabled={turn.executing}
              style={{
                background: "transparent",
                border: "1px solid #2d3240",
                color: "#cbd5e1",
                padding: "6px 12px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {labels.dismiss}
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={turn.executing}
              style={{
                background: plan.requiresApproval ? "#b91c1c" : "#2563eb",
                border: "none",
                color: "white",
                padding: "6px 14px",
                borderRadius: 8,
                cursor: turn.executing ? "default" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                opacity: turn.executing ? 0.6 : 1,
              }}
            >
              {turn.executing
                ? labels.executing
                : plan.requiresApproval
                  ? labels.approveExecute
                  : labels.execute}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
