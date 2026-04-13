"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  simulateCommand,
  executePlan,
  ExecutionPlan,
  PlannedAction,
} from "@/lib/gotcha-api";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [mounted, setMounted] = useState(false);

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
    try {
      const res = await simulateCommand(token, prompt, context);
      setPlan(res.plan);
      setPreview(res.results);
    } catch (e: any) {
      setError(e?.message ?? "simulation failed");
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
      setError(e?.message ?? "execution failed");
    } finally {
      setExecuting(false);
    }
  }

  if (!mounted || !open) return null;

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
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
      <div
        style={{
          width: "min(640px, 92vw)",
          background: "#111317",
          color: "#f2f4f7",
          borderRadius: 12,
          boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
          border: "1px solid #242831",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "76vh",
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSimulate();
          }}
          style={{ padding: 14, borderBottom: "1px solid #1e222a" }}
        >
          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              context.conversationId
                ? "Ask the AI to operate this conversation..."
                : context.contactId
                  ? "Ask the AI to operate this customer..."
                  : "Ask the AI to operate the business..."
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
            <span>↵ to preview</span>
            <span>ESC to close</span>
            {context.conversationId && <span>· conv: {context.conversationId.slice(0, 8)}</span>}
            {context.contactId && <span>· contact: {context.contactId.slice(0, 8)}</span>}
          </div>
        </form>

        <div style={{ padding: 14, overflow: "auto", flex: 1 }}>
          {loading && <div style={{ color: "#8b95a7" }}>Planning...</div>}
          {error && (
            <div style={{ color: "#ef4444", fontSize: 13 }}>{error}</div>
          )}
          {plan && !loading && (
            <>
              <div style={{ fontSize: 12, color: "#8b95a7", marginBottom: 8 }}>Plan</div>
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
                  ⚠ Contains high-risk steps — executing requires approval.
                </div>
              )}
              {preview && preview.length > 0 && (
                <details style={{ marginTop: 10, fontSize: 12, color: "#8b95a7" }}>
                  <summary>Dry-run preview</summary>
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
              Reset
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
                ? "Executing..."
                : plan.requiresApproval
                  ? "Approve & Execute"
                  : "Execute"}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
