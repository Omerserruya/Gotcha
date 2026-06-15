"use client";

/**
 * In-conversation approval card.
 *
 * Rendered at the top of the inbox view when the conversation has a
 * PENDING ApprovalRequest. Tool-specific preview (create_lead renders
 * as a person card; send_message as a chat bubble; others fall back to
 * clean label/value pairs), policy context, last two messages inline,
 * and approve / reject actions.
 *
 * See memory/bug_f4_approval_wrong_surface.md - this is the surface
 * approval was always meant to live on.
 */
import { useEffect, useMemo, useState } from "react";
import {
  approveApproval,
  getApprovalDetail,
  listApprovals,
  rejectApproval,
  type ApprovalDetailResponse,
} from "@/lib/gotcha-api";

interface Props {
  token: string;
  conversationId: string;
  onResolved?: (outcome: "approved" | "rejected") => void;
}

// ─── Tool metadata ──────────────────────────────────────────
// Friendly names + icons for the known tools. Anything not listed
// falls through to a humanized slug.
const TOOL_META: Record<string, { label: string; icon: string; system?: string }> = {
  integration_create_lead: { label: "Create Lead", icon: "🎯", system: "Zoho CRM" },
  integration_update_deal: { label: "Update Deal", icon: "📝", system: "Zoho CRM" },
  integration_contact_search: { label: "Search Contact", icon: "🔍", system: "Zoho CRM" },
  integration_create_deal: { label: "Create Deal", icon: "🤝", system: "HubSpot" },
  integration_process_refund: { label: "Process Refund", icon: "💰", system: "Shopify" },
  send_message: { label: "Send Message", icon: "💬" },
  create_broadcast: { label: "Create Broadcast", icon: "📣" },
  schedule_broadcast: { label: "Schedule Broadcast", icon: "📅" },
  merge_contacts: { label: "Merge Contacts", icon: "🔗" },
  tag_contact: { label: "Tag Contact", icon: "🏷️" },
  link_customer_identifier: { label: "Link Identifier", icon: "🔗" },
};

function humanizeTool(tool: string): { label: string; icon: string; system?: string } {
  if (TOOL_META[tool]) return TOOL_META[tool];
  const cleaned = tool
    .replace(/^integration_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { label: cleaned, icon: "⚡" };
}

// Unwrap Zoho's `{ data: [{ ... }] }` wrapper so the preview renders the
// actual record, not the envelope.
function unwrapRecord(params: Record<string, unknown>): Record<string, unknown> {
  const data = (params as any).data;
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    return data[0] as Record<string, unknown>;
  }
  return params;
}

// ─── Tool-specific previews ─────────────────────────────────

function LeadPreview({ params }: { params: Record<string, unknown> }) {
  const r = unwrapRecord(params) as Record<string, any>;
  const fullName = [r.First_Name, r.Last_Name].filter(Boolean).join(" ").trim();
  const fields: Array<{ icon: string; label: string; value?: string | null }> = [
    { icon: "👤", label: "Name", value: fullName || r.Name || null },
    { icon: "📧", label: "Email", value: r.Email || null },
    { icon: "📱", label: "Phone", value: r.Phone || r.Mobile || null },
    { icon: "🏢", label: "Company", value: r.Company || null },
    { icon: "🌐", label: "Website", value: r.Website || null },
    { icon: "🎯", label: "Source", value: r.Lead_Source || null },
  ].filter((f) => f.value);

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-indigo-50 to-white border-b border-gray-100 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
        New lead preview
      </div>
      <div className="p-3 space-y-1.5">
        {fields.map((f) => (
          <div key={f.label} className="flex items-baseline gap-2 text-[13px]">
            <span aria-hidden>{f.icon}</span>
            <span className="text-gray-500 w-16 shrink-0">{f.label}</span>
            <span className="text-gray-900 font-medium break-all" dir="auto">
              {f.value}
            </span>
          </div>
        ))}
        {r.Description && (
          <div className="pt-2 mt-2 border-t border-gray-100">
            <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">
              Notes
            </div>
            <div className="text-[13px] text-gray-700 leading-relaxed" dir="auto">
              {String(r.Description)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MessagePreview({ params }: { params: Record<string, unknown> }) {
  const body = (params as any).body || (params as any).text || "";
  const channel = (params as any).channel;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">
        Message to send {channel ? `· ${channel}` : ""}
      </div>
      <div
        className="inline-block max-w-full bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-[13px] text-gray-900 leading-relaxed"
        dir="auto"
      >
        {String(body)}
      </div>
    </div>
  );
}

function GenericPreview({ params }: { params: Record<string, unknown> }) {
  const record = unwrapRecord(params);
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return (
      <div className="text-[12px] text-gray-500 italic p-3 border border-dashed border-gray-200 rounded">
        No parameters
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2 text-[13px]">
          <span className="text-gray-500 w-28 shrink-0">{k}</span>
          <span className="text-gray-900 font-mono text-[12px] break-all" dir="auto">
            {typeof v === "string" ? v : JSON.stringify(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ToolPreview({ tool, params }: { tool: string; params: Record<string, unknown> }) {
  if (tool === "integration_create_lead") return <LeadPreview params={params} />;
  if (tool === "send_message") return <MessagePreview params={params} />;
  return <GenericPreview params={params} />;
}

// ─── Main card ──────────────────────────────────────────────

export default function ApprovalCard({ token, conversationId, onResolved }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApprovalDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await listApprovals(token, { status: "PENDING", conversationId });
        if (cancelled) return;
        setPendingId(res.data?.[0]?.id ?? null);
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
      .then((d) => !cancelled && setDetail(d))
      .catch((e: any) => !cancelled && setError(e?.message ?? "failed to load approval"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, pendingId]);

  const toolMeta = useMemo(
    () => (detail ? humanizeTool(detail.approval.tool) : null),
    [detail],
  );

  if (!pendingId) return null;
  if (loading && !detail) {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-xl p-3 mb-3 text-sm text-amber-900 flex items-center gap-2">
        <span className="inline-block w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
        Loading approval…
      </div>
    );
  }
  if (!detail || !toolMeta) return null;

  const a = detail.approval;
  const riskTone =
    a.riskLevel === "high"
      ? "bg-rose-100 text-rose-700 ring-1 ring-rose-200"
      : a.riskLevel === "medium"
      ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
      : "bg-gray-100 text-gray-700 ring-1 ring-gray-200";

  async function onApprove() {
    if (!detail) return;
    setBusy(true);
    setError(null);
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
    setError(null);
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

  const recent = detail.recentMessages.slice(-2);

  return (
    <div className="border border-amber-200 bg-gradient-to-b from-amber-50 to-white rounded-xl shadow-sm overflow-hidden mb-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-amber-100 bg-amber-50/60">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-500 text-white text-[11px]">
            ⏸
          </span>
          <span className="text-[13px] font-semibold text-amber-900">
            Action paused for your approval
          </span>
        </div>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${riskTone}`}
        >
          {a.riskLevel} risk
        </span>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Tool identity */}
        <div className="flex items-baseline gap-2">
          <span className="text-xl leading-none">{toolMeta.icon}</span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-gray-900 leading-tight">
              {toolMeta.label}
              {toolMeta.system && (
                <span className="ml-1.5 text-[11px] font-medium text-gray-500">
                  · in {toolMeta.system}
                </span>
              )}
            </div>
            {a.policyRuleName && (
              <div className="text-[11px] text-gray-500 mt-0.5">
                Policy: <em className="not-italic text-gray-700">{a.policyRuleName}</em>
              </div>
            )}
          </div>
        </div>

        {/* Tool-specific preview */}
        <ToolPreview tool={a.tool} params={a.params} />

        {/* Context: customer snapshot + recent chat */}
        {(detail.contact || recent.length > 0) && (
          <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 space-y-2">
            {detail.contact && (
              <div className="flex items-center gap-2 text-[12px] text-gray-700">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-[11px] font-semibold">
                  {(detail.contact.displayName ?? "?").charAt(0).toUpperCase()}
                </span>
                <span className="font-medium text-gray-900">
                  {detail.contact.displayName ?? "Unknown contact"}
                </span>
                {detail.contact.email && (
                  <span className="text-gray-500 text-[11px]">· {detail.contact.email}</span>
                )}
              </div>
            )}
            {recent.length > 0 && (
              <div className="space-y-1 text-[12px]">
                {recent.map((m) => (
                  <div key={m.id} className="flex items-start gap-2" dir="auto">
                    <span className="shrink-0 text-gray-500 w-3 pt-0.5 text-[10px]">
                      {m.direction === "INBOUND" ? "▸" : "◂"}
                    </span>
                    <span
                      className={
                        m.direction === "INBOUND"
                          ? "text-gray-900"
                          : "text-gray-600 italic"
                      }
                    >
                      {(m.body ?? "").slice(0, 140)}
                      {(m.body ?? "").length > 140 ? "…" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {a.reason && (
          <div className="text-[11px] text-gray-500 italic">Why held: {a.reason}</div>
        )}

        {error && (
          <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
            {error}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/60">
        {!rejectOpen ? (
          <div className="flex gap-2">
            <button
              onClick={onApprove}
              disabled={busy}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? (
                <>
                  <span className="inline-block w-3 h-3 border-2 border-white/60 border-t-white rounded-full animate-spin" />
                  Running…
                </>
              ) : (
                <>✓ Approve & run</>
              )}
            </button>
            <button
              onClick={() => setRejectOpen(true)}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 text-sm font-medium text-gray-700 disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Why are you rejecting? (required - used to craft the bot's fallback reply)"
              className="w-full text-[12px] p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-200 focus:border-rose-300"
              rows={2}
              dir="auto"
            />
            <div className="flex gap-2">
              <button
                onClick={onReject}
                disabled={busy || !rejectReason.trim()}
                className="flex-1 px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium shadow-sm disabled:opacity-50 transition-colors"
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
                className="px-3 py-2 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
