"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import {
  listApprovals,
  approveApproval,
  rejectApproval,
  type ApprovalRequestRow,
} from "@/lib/gotcha-api";

type StatusTab = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

const TABS: Array<{ key: StatusTab; label: string }> = [
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "EXPIRED", label: "Expired" },
];

export default function ApprovalsPage() {
  const { token } = useAuth();
  const [tab, setTab] = useState<StatusTab>("PENDING");
  const [items, setItems] = useState<ApprovalRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function load() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listApprovals(token, { status: tab });
      setItems(res.data ?? []);
    } catch (e: any) {
      setError(e?.message ?? "failed to load approvals");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    if (tab !== "PENDING") return;
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tab]);

  async function onApprove(id: string) {
    if (!token) return;
    setActingId(id);
    try {
      await approveApproval(token, id);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "approve failed");
    } finally {
      setActingId(null);
    }
  }

  async function onReject(id: string) {
    if (!token) return;
    if (!rejectReason.trim()) {
      setError("rejection reason is required");
      return;
    }
    setActingId(id);
    try {
      await rejectApproval(token, id, rejectReason.trim());
      setRejectId(null);
      setRejectReason("");
      await load();
    } catch (e: any) {
      setError(e?.message ?? "reject failed");
    } finally {
      setActingId(null);
    }
  }

  if (!token) return null;

  return (
    <AppLayout>
      <div className="p-6 max-w-5xl">
        <header className="mb-5">
          <h1 className="text-xl font-semibold text-gray-900">Approvals</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Bot-initiated actions paused for human review. Approving resumes the conversation and
            runs the action; rejecting hands the thread off to an agent.
          </p>
        </header>

        <div className="flex items-center gap-1 border-b border-gray-200 mb-4">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={clsx(
                "px-4 py-2 text-sm font-medium -mb-px border-b-2 transition",
                tab === t.key
                  ? "text-violet-700 border-violet-600"
                  : "text-gray-500 border-transparent hover:text-gray-700",
              )}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={load}
            className="ml-auto mb-2 text-xs text-gray-500 hover:text-gray-700"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-3 px-4 py-2 text-sm bg-red-50 border border-red-200 text-red-700 rounded-lg">
            {error}
          </div>
        )}

        {loading && items.length === 0 && (
          <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>
        )}

        {!loading && items.length === 0 && (
          <div className="bg-white rounded-xl shadow-subtle p-10 text-center">
            <p className="text-sm text-gray-500">
              {tab === "PENDING"
                ? "Nothing awaiting approval right now."
                : `No ${tab.toLowerCase()} approvals.`}
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {items.map((a) => (
            <li
              key={a.id}
              className="bg-white rounded-xl shadow-subtle border border-gray-100 p-4"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <RiskChip level={a.riskLevel} />
                    <code className="text-[11px] font-mono text-gray-500">{a.tool}</code>
                    {a.policyRuleName && (
                      <span className="text-[11px] text-gray-500">· {a.policyRuleName}</span>
                    )}
                  </div>
                  <div className="text-sm font-medium text-gray-900">{a.summary}</div>
                  {a.reason && (
                    <div className="text-xs text-gray-600 italic mt-1">Why: {a.reason}</div>
                  )}
                </div>
                <div className="text-right text-[11px] text-gray-400 shrink-0">
                  <div>{new Date(a.createdAt).toLocaleString()}</div>
                  <div>requested by {a.requestedBy}</div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-md p-2 mb-2 text-xs">
                <div className="text-gray-400 uppercase tracking-wider text-[10px] mb-1">
                  Parameters
                </div>
                <div className="space-y-0.5 font-mono">
                  {Object.entries(a.params).map(([k, v]) => (
                    <div key={k} className="truncate">
                      <span className="text-gray-500">{k}</span>{" "}
                      <span className="text-gray-800">
                        {typeof v === "string" ? v : JSON.stringify(v)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {a.status === "PENDING" && rejectId !== a.id && (
                <div className="flex items-center gap-2">
                  <a
                    href={`/conversations?c=${a.conversationId}`}
                    className="text-xs text-violet-600 hover:underline"
                  >
                    Open conversation →
                  </a>
                  <div className="ml-auto flex gap-2">
                    <button
                      onClick={() => setRejectId(a.id)}
                      disabled={actingId === a.id}
                      className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => onApprove(a.id)}
                      disabled={actingId === a.id}
                      className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50"
                    >
                      {actingId === a.id ? "Running…" : "Approve & Run"}
                    </button>
                  </div>
                </div>
              )}

              {a.status === "PENDING" && rejectId === a.id && (
                <div className="space-y-2 mt-2 pt-2 border-t border-gray-100">
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Why are you rejecting? (required — used to craft the bot's fallback reply)"
                    rows={2}
                    className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => {
                        setRejectId(null);
                        setRejectReason("");
                        setError(null);
                      }}
                      disabled={actingId === a.id}
                      className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => onReject(a.id)}
                      disabled={actingId === a.id || !rejectReason.trim()}
                      className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
                    >
                      {actingId === a.id ? "Rejecting…" : "Confirm reject"}
                    </button>
                  </div>
                </div>
              )}

              {a.status !== "PENDING" && (
                <div className="text-[11px] text-gray-500 flex items-center gap-2 pt-1">
                  <span>
                    {a.status.toLowerCase()} by {a.decidedBy ?? "system"}
                    {a.decidedAt && ` · ${new Date(a.decidedAt).toLocaleString()}`}
                  </span>
                  {a.decisionReason && <span>— {a.decisionReason}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </AppLayout>
  );
}

function RiskChip({ level }: { level: "low" | "medium" | "high" }) {
  const style =
    level === "high"
      ? "bg-red-100 text-red-700 border-red-200"
      : level === "medium"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 border rounded ${style}`}>
      {level}
    </span>
  );
}
