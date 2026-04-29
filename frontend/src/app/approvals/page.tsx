"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { getSocket } from "@/lib/socket";
import {
  listApprovals,
  approveApproval,
  rejectApproval,
  type ApprovalRequestRow,
} from "@/lib/gotcha-api";
import {
  RiskChip,
  ToolPreview,
  formatRequestedBy,
  humanizeTool,
} from "@/components/approvals/tool-rendering";

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
  const knownIds = useRef<Set<string>>(new Set());

  async function load() {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listApprovals(token, { status: tab });
      const next = res.data ?? [];
      setItems(next);
      knownIds.current = new Set(next.map((a) => a.id));
    } catch (e: any) {
      setError(e?.message ?? "failed to load approvals");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tab]);

  // Live updates: subscribe to approval:* socket events. New PENDING rows
  // arriving via `approval:created` re-fetch the list and play a soft chime.
  // Status transitions (approved/rejected/expired) just refresh.
  useEffect(() => {
    if (!token) return;
    const socket = getSocket();
    if (!socket) return;

    const onCreated = (payload: any) => {
      // Only react when we're on a tab where the new row would belong.
      if (tab === "PENDING" && payload?.id && !knownIds.current.has(payload.id)) {
        playApprovalChime();
        load();
      }
    };
    const onChanged = () => load();

    socket.on("approval:created", onCreated);
    socket.on("approval:approved", onChanged);
    socket.on("approval:rejected", onChanged);
    socket.on("approval:expired", onChanged);
    return () => {
      socket.off("approval:created", onCreated);
      socket.off("approval:approved", onChanged);
      socket.off("approval:rejected", onChanged);
      socket.off("approval:expired", onChanged);
    };
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
      <div className="p-6 max-w-4xl">
        <header className="mb-5">
          <h1 className="text-xl font-semibold text-gray-900">Approvals</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Bot-initiated actions paused for human review. Approving resumes the
            conversation and runs the action; rejecting hands the thread off to an agent.
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
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-10 text-center">
            <p className="text-sm text-gray-500">
              {tab === "PENDING"
                ? "Nothing awaiting approval right now."
                : `No ${tab.toLowerCase()} approvals.`}
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {items.map((a) => (
            <ApprovalListCard
              key={a.id}
              row={a}
              actingId={actingId}
              rejectingId={rejectId}
              rejectReason={rejectReason}
              onStartReject={(id) => setRejectId(id)}
              onCancelReject={() => {
                setRejectId(null);
                setRejectReason("");
                setError(null);
              }}
              onChangeReason={setRejectReason}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </ul>
      </div>
    </AppLayout>
  );
}

// ─── Single card on the list ─────────────────────────────────────

function ApprovalListCard({
  row,
  actingId,
  rejectingId,
  rejectReason,
  onStartReject,
  onCancelReject,
  onChangeReason,
  onApprove,
  onReject,
}: {
  row: ApprovalRequestRow;
  actingId: string | null;
  rejectingId: string | null;
  rejectReason: string;
  onStartReject: (id: string) => void;
  onCancelReject: () => void;
  onChangeReason: (v: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const tool = humanizeTool(row.tool);
  const isRejecting = rejectingId === row.id;
  const busy = actingId === row.id;

  const statusTone =
    row.status === "APPROVED"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : row.status === "REJECTED"
      ? "bg-rose-50 text-rose-700 ring-rose-200"
      : row.status === "EXPIRED"
      ? "bg-gray-100 text-gray-600 ring-gray-200"
      : "bg-amber-50 text-amber-800 ring-amber-200";

  return (
    <li className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header: tool identity + risk + status */}
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-gray-100">
        <div className="flex items-start gap-3 min-w-0">
          <span className="text-2xl leading-none mt-0.5" aria-hidden>
            {tool.icon}
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-gray-900 leading-tight truncate">
              {tool.label}
              {tool.system && (
                <span className="ml-1.5 text-[12px] font-medium text-gray-500">
                  · {tool.system}
                </span>
              )}
            </div>
            <div className="text-[12px] text-gray-600 mt-0.5 leading-snug">
              {row.summary}
            </div>
            {row.policyRuleName && (
              <div className="text-[11px] text-gray-400 mt-0.5">
                Policy: <span className="text-gray-600">{row.policyRuleName}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <RiskChip level={row.riskLevel} />
          {row.status !== "PENDING" && (
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ring-1 ${statusTone}`}
            >
              {row.status.toLowerCase()}
            </span>
          )}
        </div>
      </div>

      {/* Parameter preview */}
      <div className="px-5 py-4">
        <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-2">
          Parameters
        </div>
        <ToolPreview tool={row.tool} params={row.params} />
        {row.reason && (
          <div className="mt-3 text-[12px] text-gray-600 leading-relaxed">
            <span className="text-gray-400">Why held:</span> {row.reason}
          </div>
        )}
      </div>

      {/* Meta: requested / decided / time */}
      <div className="px-5 py-2.5 border-t border-gray-100 bg-gray-50/40 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-gray-500">
        <Meta label="Created" value={new Date(row.createdAt).toLocaleString()} />
        <Meta label="Requested by" value={formatRequestedBy(row.requestedBy, row.requestedByName)} />
        {row.status !== "PENDING" ? (
          <Meta
            label={row.status === "EXPIRED" ? "Expired" : "Decided by"}
            value={
              row.status === "EXPIRED"
                ? row.decidedAt
                  ? new Date(row.decidedAt).toLocaleString()
                  : "—"
                : (row.decidedByName ?? row.decidedBy ?? "system")
                  + (row.decidedAt ? ` · ${new Date(row.decidedAt).toLocaleTimeString()}` : "")
            }
          />
        ) : (
          <Meta
            label="Expires"
            value={row.expiresAt ? new Date(row.expiresAt).toLocaleTimeString() : "—"}
          />
        )}
      </div>

      {/* Actions / decision footer */}
      {row.status === "PENDING" && !isRejecting && (
        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2">
          <a
            href={`/conversations?c=${row.conversationId}`}
            className="text-xs text-violet-600 hover:underline"
          >
            Open conversation →
          </a>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => onStartReject(row.id)}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md disabled:opacity-50"
            >
              Reject
            </button>
            <button
              onClick={() => onApprove(row.id)}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-md disabled:opacity-50"
            >
              {busy ? "Running…" : "Approve & run"}
            </button>
          </div>
        </div>
      )}

      {row.status === "PENDING" && isRejecting && (
        <div className="px-5 py-3 border-t border-gray-100 space-y-2 bg-rose-50/30">
          <textarea
            value={rejectReason}
            onChange={(e) => onChangeReason(e.target.value)}
            placeholder="Why are you rejecting? (required — used to craft the bot's fallback reply)"
            rows={2}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-rose-200"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={onCancelReject}
              disabled={busy}
              className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md"
            >
              Cancel
            </button>
            <button
              onClick={() => onReject(row.id)}
              disabled={busy || !rejectReason.trim()}
              className="px-3 py-1.5 text-xs bg-rose-600 hover:bg-rose-700 text-white rounded-md disabled:opacity-50"
            >
              {busy ? "Rejecting…" : "Confirm reject"}
            </button>
          </div>
        </div>
      )}

      {row.status !== "PENDING" && row.decisionReason && (
        <div className="px-5 py-2 border-t border-gray-100 text-[11px] text-gray-500 bg-gray-50/40">
          <span className="text-gray-400">Note:</span> {row.decisionReason}
        </div>
      )}
    </li>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold">
        {label}
      </div>
      <div className="text-[12px] text-gray-700 truncate">{value}</div>
    </div>
  );
}

// ─── Chime: synthesised tone via WebAudio so we don't ship an asset ────

let chimeCtx: AudioContext | null = null;
function playApprovalChime() {
  if (typeof window === "undefined") return;
  try {
    if (!chimeCtx) {
      chimeCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = chimeCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const tones = [880, 1320]; // soft two-note chime: A5 → E6
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + i * 0.12);
      gain.gain.setValueAtTime(0, now + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.15, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.4);
    });
  } catch {
    // Audio API unavailable / blocked — silent fail; the visual update still happens.
  }
}
