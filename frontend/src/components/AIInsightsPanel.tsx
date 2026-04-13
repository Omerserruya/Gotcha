"use client";

import { useEffect, useState } from "react";
import { getSuggestions, getCustomerState, generateFollowup } from "@/lib/gotcha-api";

interface Props {
  token: string;
  conversationId: string;
  contactId?: string;
  onInsertReply?: (body: string) => void;
}

/**
 * F5.1 / F5.5 / F7.4 — AI Insights sidebar.
 *
 * Shows suggested replies (with reasoning), customer state summary,
 * and a one-click follow-up generator. Click a suggestion to insert
 * it into the conversation input (via onInsertReply prop).
 */
export default function AIInsightsPanel({
  token,
  conversationId,
  contactId,
  onInsertReply,
}: Props) {
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [state, setState] = useState<any | null>(null);
  const [followup, setFollowup] = useState<{ body: string; reason: string } | null>(null);
  const [loadingFollowup, setLoadingFollowup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sres: any = await getSuggestions(token, conversationId);
        setSuggestions(sres.data ?? []);
      } catch (e: any) {
        setError(e?.message ?? "failed to load suggestions");
      }
    })();
  }, [token, conversationId]);

  useEffect(() => {
    if (!contactId) return;
    (async () => {
      try {
        const sres: any = await getCustomerState(token, contactId);
        setState(sres.data ?? null);
      } catch {
        // non-fatal
      }
    })();
  }, [token, contactId]);

  async function onGenerateFollowup() {
    setLoadingFollowup(true);
    try {
      const res: any = await generateFollowup(token, conversationId);
      setFollowup(res.data);
    } catch (e: any) {
      setError(e?.message ?? "failed to generate follow-up");
    } finally {
      setLoadingFollowup(false);
    }
  }

  return (
    <aside
      style={{
        padding: 12,
        borderLeft: "1px solid #ddd",
        width: 320,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div>
        <strong>Suggested replies</strong>
        {error && <div style={{ color: "crimson", fontSize: 12 }}>{error}</div>}
        {suggestions.length === 0 && <div style={{ color: "#888" }}>No suggestions yet.</div>}
        {suggestions.map((s, i) => (
          <div
            key={i}
            style={{ borderBottom: "1px solid #eee", padding: "6px 0", cursor: "pointer" }}
            onClick={() => onInsertReply?.(s.body ?? s.text ?? "")}
          >
            <div style={{ fontSize: 13 }}>{s.body ?? s.text ?? "(no body)"}</div>
            {s.reason && <div style={{ fontSize: 11, color: "#888" }}>↳ {s.reason}</div>}
          </div>
        ))}
      </div>

      {state && (
        <div>
          <strong>Customer</strong>
          <div style={{ fontSize: 12 }}>{state.displayName ?? state.contactId}</div>
          <div style={{ fontSize: 11, color: "#555" }}>
            Tags: {state.tags?.join(", ") || "—"}
          </div>
          {state.recentSummaries?.[0]?.summary && (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              <em>{state.recentSummaries[0].summary}</em>
            </div>
          )}
          {state.recentDecisions?.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 11 }}>
                Recent decisions ({state.recentDecisions.length})
              </summary>
              <ul style={{ fontSize: 11, paddingLeft: 16 }}>
                {state.recentDecisions.map((d: any, i: number) => (
                  <li key={i}>
                    {d.action} — {d.reason ?? "-"}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div>
        <button onClick={onGenerateFollowup} disabled={loadingFollowup}>
          {loadingFollowup ? "Generating..." : "Generate follow-up"}
        </button>
        {followup && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <div>{followup.body}</div>
            <div style={{ color: "#888" }}>↳ {followup.reason}</div>
            <button
              onClick={() => onInsertReply?.(followup.body)}
              style={{ marginTop: 4 }}
            >
              Insert
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
