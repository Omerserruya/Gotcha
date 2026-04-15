"use client";

/**
 * In-conversation approval card.
 *
 * Rendered at the top of the inbox view when the conversation has a
 * PENDING ApprovalRequest. Rich context for the human: summary, reason,
 * tool params rendered human-readable, risk chips, recent message
 * snippet, contact snapshot, and approve / reject / modify actions.
 *
 * See memory/bug_f4_approval_wrong_surface.md — this is the surface
 * approval was always meant to live on.
 */
import { useEffect, useState } from "react";
import {
  approveApproval,
  getApprovalDetail,
  listApprovals,
  rejectApproval,
  type ApprovalDetailResponse,
  type ApprovalRequestRow,
} from "@/lib/gotcha-api";

interface Props {
  token: string;
  conversationId: string;
  onResolved?: (outcome: "approved" | "rejected") => void;
}

export default function ApprovalCard({ token, conversationId, onResolved }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApprovalDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Poll for pending approvals on this conversation. 10s cadence — fast
  // enough to feel responsive, slow enough to not hammer the API.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await listApprovals(token, { status: "PENDING", conversationId });
        if (cancelled) return;
        const first = res.data?.[0] ?? null;
        setPendingId(first?.id ?? null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "failed to check approvals");
      }
    }
    check();
    const id = setInterval(check, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, conversationId]);

  useEffect(() => {
    if (!pendingId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getApprovalDetail(token, pendingId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: any) => !cancelled && setError(e?.message ?? "failed to load approval"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, pendingId]);

  if (!pendingId) return null;
  if (loading && !detail) {
    return (
      <div className="p-3 border-l-4 border-amber-400 bg-amber-50 text-sm text-amber-900">
        Loading approval…
      </div>
    );
  }
  if (!detail) return null;

  const a = detail.approval;
  const risk = a.riskLevel.toUpperCase();
  const riskColor =
    a.riskLevel === "high"
      ? "bg-red-100 text-red-700 border-red-300"
      : a.riskLevel === "medium"
      ? "bg-amber-100 text-amber-700 border-amber-300"
      : "bg-gray-100 text-gray-700 border-gray-300";

  async function onApprove() {
    if (!detail) return;
    setBusy(true);
    try {
      await approveApproval(token, detail.approval.id);
      setPendingId(null);
      setDetail(null);
      onResolved?.("approved");
    } catch (e: any) {
      setError(e?.message ?? "approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!detail) return;
    if (!rejectReason.trim()) {
      setError("rejection reason is required");
      return;
    }
    setBusy(true);
    try {
      await rejectApproval(token, detail.approval.id, rejectReason.trim());
      setPendingId(null);
      setDetail(null);
      setRejectOpen(false);
      setRejectReason("");
      onResolved?.("rejected");
    } catch (e: any) {
      setError(e?.message ?? "reject failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-red-200 bg-red-50 rounded-lg p-4 mb-3 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-red-600">🛑</span>
          <strong className="text-sm text-red-900">AI action pending approval</strong>
        </div>
        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 border rounded ${riskColor}`}>
          {risk}
        </span>
      </div>

      <div className="text-sm text-gray-900 mb-2">{a.summary}</div>

      {a.reason && (
        <div className="text-xs text-gray-600 italic mb-3">Why: {a.reason}</div>
      )}

      <div className="bg-white rounded border border-gray-200 p-2 mb-3 text-xs">
        <div className="text-gray-500 uppercase tracking-wider text-[10px] mb-1">
          Tool: <code className="font-mono">{a.tool}</code>
        </div>
        <div className="space-y-0.5">
          {Object.entries(a.params).map(([k, v]) => (
            <div key={k}>
              <span className="text-gray-500">{k}</span> ={" "}
              <span className="text-gray-900">
                {typeof v === "string" ? v : JSON.stringify(v)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {a.policyRuleName && (
        <div className="text-[11px] text-gray-600 mb-2">
          Policy: <em>{a.policyRuleName}</em>
        </div>
      )}

      {detail.recentMessages.length > 0 && (
        <details className="text-[11px] text-gray-600 mb-3">
          <summary className="cursor-pointer">Recent messages ({detail.recentMessages.length})</summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {detail.recentMessages.map((m) => (
              <li key={m.id}>
                <span className="font-semibold">
                  {m.direction === "INBOUND" ? "👤" : "🤖"}{" "}
                  {m.senderName ?? (m.direction === "INBOUND" ? "customer" : "bot")}:
                </span>{" "}
                {(m.body ?? "").slice(0, 80)}
                {(m.body ?? "").length > 80 ? "…" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      {detail.contact && (
        <div className="text-[11px] text-gray-600 mb-3">
          Customer: <strong>{detail.contact.displayName ?? "(unnamed)"}</strong>
          {detail.contact.email && ` · ${detail.contact.email}`}
          {detail.contact.tags &&
            (detail.contact.tags as string[]).length > 0 &&
            ` · ${(detail.contact.tags as string[]).join(", ")}`}
        </div>
      )}

      {error && <div className="text-xs text-red-700 mb-2">{error}</div>}

      {!rejectOpen ? (
        <div className="flex gap-2">
          <button
            onClick={onApprove}
            disabled={busy}
            className="flex-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded disabled:opacity-50"
          >
            {busy ? "Running…" : "Approve & Run"}
          </button>
          <button
            onClick={() => setRejectOpen(true)}
            disabled={busy}
            className="flex-1 px-3 py-2 bg-white border border-gray-300 hover:bg-gray-50 text-sm rounded disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why are you rejecting? (required — used to craft the bot's fallback reply)"
            className="w-full text-xs p-2 border border-gray-300 rounded"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              onClick={onReject}
              disabled={busy || !rejectReason.trim()}
              className="flex-1 px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded disabled:opacity-50"
            >
              {busy ? "Rejecting…" : "Confirm reject"}
            </button>
            <button
              onClick={() => {
                setRejectOpen(false);
                setRejectReason("");
                setError(null);
              }}
              disabled={busy}
              className="px-3 py-2 bg-white border border-gray-300 hover:bg-gray-50 text-sm rounded"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
