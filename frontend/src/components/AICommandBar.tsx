"use client";

import { useState } from "react";
import { simulateCommand, executePlan, ExecutionPlan, PlannedAction } from "@/lib/gotcha-api";

interface Props {
  token: string;
  placeholder?: string;
  contextScope?: { conversationId?: string; contactId?: string };
  onExecuted?: (results: any[]) => void;
}

/**
 * F2.3 / F2.4 - Minimal AI Command Bar.
 *
 * A thin functional prototype: user types a natural-language request,
 * the bar shows the plan (dry-run) and lets them Execute it for real.
 * Styling is intentionally minimal so a designer can replace it later
 * without touching behavior.
 */
export default function AICommandBar({ token, placeholder, contextScope, onExecuted }: Props) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSimulate() {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await simulateCommand(token, prompt, contextScope);
      setPlan(res.plan);
      setPreview(res.results);
    } catch (e: any) {
      setError(e?.message ?? "simulation failed");
    } finally {
      setLoading(false);
    }
  }

  async function onExecute(approved: boolean) {
    if (!plan) return;
    setLoading(true);
    setError(null);
    try {
      const res: any = await executePlan(token, plan, { approved });
      onExecuted?.(res.results ?? []);
      setPrompt("");
      setPlan(null);
      setPreview(null);
    } catch (e: any) {
      setError(e?.message ?? "execution failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ai-command-bar" style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSimulate();
        }}
      >
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={placeholder ?? "Ask the AI to do something..."}
          disabled={loading}
          style={{ width: "100%", padding: 8 }}
        />
      </form>

      {error && <div style={{ color: "crimson", marginTop: 8 }}>{error}</div>}

      {plan && (
        <div style={{ marginTop: 12 }}>
          <strong>Plan:</strong> {plan.summary}
          <ul>
            {plan.steps.map((s: PlannedAction, i: number) => (
              <li key={i}>
                <code>{s.tool}</code> - {s.reason} <em>({s.riskLevel})</em>
              </li>
            ))}
          </ul>
          {preview && (
            <details>
              <summary>Dry-run results</summary>
              <pre style={{ fontSize: 12 }}>{JSON.stringify(preview, null, 2)}</pre>
            </details>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button onClick={() => onExecute(plan.requiresApproval)} disabled={loading}>
              {plan.requiresApproval ? "Approve & Execute" : "Execute"}
            </button>
            <button
              onClick={() => {
                setPlan(null);
                setPreview(null);
              }}
              disabled={loading}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
