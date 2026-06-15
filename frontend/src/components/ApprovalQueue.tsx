"use client";

import { useEffect, useState } from "react";
import { getApprovalQueue } from "@/lib/gotcha-api";

interface Props {
  token: string;
  refreshMs?: number;
}

interface PendingItem {
  id: string;
  action: string;
  createdAt: string;
  metadata: {
    reason?: string;
    riskLevel?: string;
    params?: Record<string, unknown>;
  };
}

/**
 * F4.3 - Minimal Approval Queue.
 * Lists high-risk actions that were blocked by the executor and surfaces
 * them for review. "Approve" here is advisory - real approval re-runs
 * the executor with approved=true from the originating command path.
 */
export default function ApprovalQueue({ token, refreshMs = 15000 }: Props) {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res: any = await getApprovalQueue(token);
      setItems(res.data ?? []);
    } catch (e: any) {
      setError(e?.message ?? "failed to load queue");
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, refreshMs);
    return () => clearInterval(id);
  }, [token, refreshMs]);

  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
      <strong>Pending high-risk actions ({items.length})</strong>
      {error && <div style={{ color: "crimson" }}>{error}</div>}
      {items.length === 0 && <div style={{ color: "#888" }}>Nothing awaiting approval.</div>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {items.map((it) => (
          <li key={it.id} style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
            <code>{it.action}</code>{" "}
            <em style={{ color: "#b15" }}>({it.metadata.riskLevel ?? "high"})</em>
            <div style={{ fontSize: 12, color: "#555" }}>
              {it.metadata.reason ?? "no reason recorded"} -{" "}
              {new Date(it.createdAt).toLocaleString()}
            </div>
            {it.metadata.params && (
              <pre style={{ fontSize: 11, background: "#f6f6f6", padding: 4 }}>
                {JSON.stringify(it.metadata.params, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
