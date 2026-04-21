"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  simulateCommand,
  executePlan,
  ExecutionPlan,
  PlannedAction,
} from "@/lib/gotcha-api";
import { useI18n } from "@/context/I18nContext";

interface Props {
  open: boolean;
  onClose: () => void;
  token: string;
  context: { conversationId?: string; contactId?: string };
}

/**
 * OS-level command palette modal.
 * Portal-mounted, overlay, Ctrl/Cmd+K global. Reuses the existing
 * /api/action-planner endpoints via gotcha-api — no backend changes.
 */
export default function CommandCenterModal({ open, onClose, token, context }: Props) {
  const { t, locale, dir } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [chatAnswer, setChatAnswer] = useState<string | null>(null);

  // Derive glow state: thinking (loading), error, approval, ready, idle.
  const glowState: "idle" | "thinking" | "ready" | "approval" | "error" =
    error ? "error"
      : executing || loading ? "thinking"
      : plan?.requiresApproval ? "approval"
      : plan || chatAnswer ? "ready"
      : "idle";
  const glowColor = {
    idle: "rgba(99,102,241,0.25)",
    thinking: "rgba(59,130,246,0.65)",
    ready: "rgba(34,197,94,0.55)",
    approval: "rgba(249,115,22,0.65)",
    error: "rgba(239,68,68,0.65)",
  }[glowState];

  useEffect(() => setMounted(true), []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
      setError(null);
    }
  }, [open]);

  // Escape to close
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

  async function runSimulate() {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    setPlan(null);
    setPreview(null);
    setChatAnswer(null);
    try {
      const res = await simulateCommand(token, prompt, { ...context, locale });
      if (res.mode === "chat") {
        setChatAnswer(res.answer ?? res.clarification ?? "");
        setPlan(null);
        setPreview(null);
      } else {
        setPlan(res.plan);
        setPreview(res.results);
      }
    } catch (e: any) {
      setError(e?.message ?? t("commandCenter.errorSimulate"));
    } finally {
      setLoading(false);
    }
  }

  async function runExecute() {
    if (!plan) return;
    setExecuting(true);
    setError(null);
    try {
      const idempotencyKey = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await executePlan(token, plan, { approved: true });
      // surface idempotencyKey-aware retries in future UX
      void idempotencyKey;
      setPrompt("");
      setPlan(null);
      setPreview(null);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? t("commandCenter.errorExecute"));
    } finally {
      setExecuting(false);
    }
  }

  if (!mounted || !open) return null;

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
        paddingTop: "12vh",
      }}
    >
      <style>{`
        @keyframes gotchaGlowPulse {
          0%, 100% { box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px var(--gc-glow), 0 0 24px 2px var(--gc-glow), 0 0 60px 6px var(--gc-glow-soft); }
          50%      { box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px var(--gc-glow), 0 0 36px 4px var(--gc-glow), 0 0 88px 12px var(--gc-glow-soft); }
        }
      `}</style>
      <div
        style={{
          width: "min(640px, 92vw)",
          background: "#111317",
          color: "#f2f4f7",
          borderRadius: 12,
          border: "1px solid #242831",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "76vh",
          ["--gc-glow" as any]: glowColor,
          ["--gc-glow-soft" as any]: glowColor.replace(/[\d.]+\)$/, "0.18)"),
          animation: "gotchaGlowPulse 3.6s ease-in-out infinite",
          transition: "--gc-glow 400ms ease",
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSimulate();
          }}
          style={{ padding: 14, borderBottom: "1px solid #1e222a" }}
        >
          <div style={{ fontSize: 11, color: "#8b95a7", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {t("commandCenter.title")}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2, marginBottom: 8 }}>
            {t("commandCenter.subtitle")}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            dir={dir}
            placeholder={
              context.conversationId
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
            }}
          />
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4, display: "flex", gap: 12 }}>
            <span>{t("commandCenter.hintPreview")}</span>
            <span>{t("commandCenter.hintClose")}</span>
            {context.conversationId && <span>· conv: {context.conversationId.slice(0, 8)}</span>}
            {context.contactId && <span>· contact: {context.contactId.slice(0, 8)}</span>}
          </div>
        </form>

        <div style={{ padding: 14, overflow: "auto", flex: 1 }}>
          {loading && <div style={{ color: "#8b95a7" }}>{t("commandCenter.planning")}</div>}
          {error && (
            <div style={{ color: "#ef4444", fontSize: 13 }}>{error}</div>
          )}
          {!loading && chatAnswer && !plan && (
            <div>
              <div style={{ fontSize: 11, color: "#8b95a7", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                {t("commandCenter.title")}
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.5, color: "#e2e8f0", whiteSpace: "pre-wrap" }}>
                {chatAnswer}
              </div>
            </div>
          )}
          {!loading && !plan && !error && !chatAnswer && (
            <div>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                {t("commandCenter.examplesHeader")}
              </div>
              {[
                context.conversationId
                  ? t("commandCenter.exampleConversation1")
                  : t("commandCenter.exampleGlobal1"),
                context.conversationId
                  ? t("commandCenter.exampleConversation2")
                  : t("commandCenter.exampleGlobal2"),
                context.conversationId
                  ? "✨ Draft a reply: apologize for the delay and offer a 10% discount"
                  : "✨ Draft a message: friendly renewal reminder with the customer's name",
              ].map((ex, i) => (
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
                    padding: "8px 12px",
                    borderRadius: 8,
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
          {plan && !loading && (
            <>
              <div style={{ fontSize: 12, color: "#8b95a7", marginBottom: 8 }}>{t("commandCenter.plan")}</div>
              <div style={{ fontSize: 14, marginBottom: 10 }}>{plan.summary}</div>
              <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {plan.steps.map((s: PlannedAction, i: number) => (
                  <li
                    key={i}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "#181b22",
                      marginBottom: 6,
                      border: "1px solid #222631",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <code style={{ fontSize: 13, color: "#93c5fd" }}>{s.tool}</code>
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
                    <div style={{ fontSize: 12, color: "#8b95a7", marginTop: 2 }}>{s.reason}</div>
                  </li>
                ))}
              </ol>
              {plan.requiresApproval && (
                <div style={{ fontSize: 12, color: "#fbbf24", marginTop: 8 }}>
                  {t("commandCenter.requiresApproval")}
                </div>
              )}
              {preview && preview.length > 0 && (
                <details style={{ marginTop: 10, fontSize: 12, color: "#8b95a7" }}>
                  <summary>{t("commandCenter.dryRunPreview")}</summary>
                  <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(preview, null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>

        {plan && !loading && (
          <div
            style={{
              padding: 10,
              borderTop: "1px solid #1e222a",
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setPlan(null);
                setPreview(null);
                setChatAnswer(null);
              }}
              disabled={executing}
              style={{
                background: "transparent",
                border: "1px solid #2d3240",
                color: "#cbd5e1",
                padding: "6px 12px",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {t("commandCenter.reset")}
            </button>
            <button
              type="button"
              onClick={runExecute}
              disabled={executing}
              style={{
                background: plan.requiresApproval ? "#b91c1c" : "#2563eb",
                border: "none",
                color: "white",
                padding: "6px 14px",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {executing
                ? t("commandCenter.executing")
                : plan.requiresApproval
                  ? t("commandCenter.approveExecute")
                  : t("commandCenter.execute")}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
