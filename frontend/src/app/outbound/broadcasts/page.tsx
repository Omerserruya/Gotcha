"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getBroadcasts,
  createBroadcast,
  updateBroadcast,
  sendBroadcast,
  validateBroadcast,
  cancelBroadcast,
  deleteBroadcast,
  getTemplates,
  getChannelAccounts,
  addBroadcastRecipients,
} from "@/lib/api";
import ChannelAccountPicker from "@/components/ChannelAccountPicker";
import { getSocket } from "@/lib/socket";
import clsx from "clsx";
import { AIComposeScope, AIComposeTrigger, AIComposePanel } from "@/components/ai/AIComposeInline";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Broadcast {
  id: string;
  name: string;
  channel: string;
  channelAccountId?: string;
  status: string;
  body?: string;
  templateId?: string;
  scheduledAt?: string;
  sentAt?: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  repliedCount: number;
  failedCount: number;
  lastError?: string | null;
  createdAt: string;
}

interface ChannelAccount {
  id: string;
  channel: string;
  displayName: string;
  connectionStatus: string;
  externalId?: string;
}

type SegmentField = "channel" | "tag" | "phone" | "email" | "lastSeenAfter";
type SegmentOperator = "equals" | "contains" | "startsWith";

interface SegmentRule {
  id: string;
  field: SegmentField;
  operator: SegmentOperator;
  value: string;
}

type RecipientTab = "segment" | "import" | "all";

interface WizardState {
  // Step 1
  name: string;
  channel: string;
  channelAccountId: string;
  templateId: string;
  body: string;
  // Step 2
  recipientTab: RecipientTab;
  segmentRules: SegmentRule[];
  importText: string;
  // Step 3
  sendNow: boolean;
  scheduledAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_BADGES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-500",
  SCHEDULED: "bg-blue-50 text-blue-600 ring-1 ring-blue-200",
  SENDING: "bg-yellow-50 text-yellow-600 ring-1 ring-yellow-200",
  COMPLETED: "bg-green-50 text-green-600 ring-1 ring-green-200",
  CANCELLED: "bg-red-50 text-red-500 ring-1 ring-red-200",
  FAILED: "bg-red-50 text-red-600 ring-1 ring-red-200",
};

const inputCls =
  "w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition";

const selectCls = inputCls;

const SEGMENT_FIELDS: { value: SegmentField; label: string }[] = [
  { value: "channel", label: "outbound.broadcasts.segmentFieldChannel" },
  { value: "tag", label: "outbound.broadcasts.segmentFieldTag" },
  { value: "phone", label: "outbound.broadcasts.segmentFieldPhone" },
  { value: "email", label: "outbound.broadcasts.segmentFieldEmail" },
  { value: "lastSeenAfter", label: "outbound.broadcasts.segmentFieldLastSeen" },
];

const SEGMENT_OPERATORS: { value: SegmentOperator; label: string }[] = [
  { value: "equals", label: "outbound.broadcasts.operatorEquals" },
  { value: "contains", label: "outbound.broadcasts.operatorContains" },
  { value: "startsWith", label: "outbound.broadcasts.operatorStartsWith" },
];

const STEPS = [
  "outbound.broadcasts.step1",
  "outbound.broadcasts.step2",
  "outbound.broadcasts.step3",
  "outbound.broadcasts.step4",
];

function emptyWizard(): WizardState {
  return {
    name: "",
    channel: "WHATSAPP",
    channelAccountId: "",
    templateId: "",
    body: "",
    recipientTab: "segment",
    segmentRules: [],
    importText: "",
    sendNow: true,
    scheduledAt: "",
  };
}

function newRule(): SegmentRule {
  return { id: Math.random().toString(36).slice(2), field: "tag", operator: "contains", value: "" };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span>
          {value} <span className="text-gray-300">/ {total}</span> ({pct}%)
        </span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={clsx("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Step indicator
function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-0">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center">
          <div
            className={clsx(
              "w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-all",
              i < current
                ? "bg-primary-500 text-white"
                : i === current
                ? "bg-primary-100 text-primary-600 ring-2 ring-primary-300"
                : "bg-gray-100 text-gray-400"
            )}
          >
            {i < current ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            ) : (
              i + 1
            )}
          </div>
          {i < total - 1 && (
            <div className={clsx("h-0.5 w-8", i < current ? "bg-primary-400" : "bg-gray-200")} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BroadcastsPage() {
  const { token } = useAuth();
  const { t } = useI18n();

  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<any[]>([]);
  const [channelAccounts, setChannelAccounts] = useState<ChannelAccount[]>([]);

  // Panel state
  const [showPanel, setShowPanel] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [wizard, setWizard] = useState<WizardState>(emptyWizard());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createdBroadcastId, setCreatedBroadcastId] = useState<string | null>(null);

  // Validation state
  const [validation, setValidation] = useState<any>(null);
  const [validating, setValidating] = useState(false);

  // Import drag state
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Only show connected channels
  const connectedAccounts = channelAccounts.filter(
    (a) => a.connectionStatus === "CONNECTED"
  );

  useEffect(() => {
    if (!token) return;
    fetchBroadcasts();
    fetchTemplates();
    fetchChannelAccounts();
  }, [token]);

  // Realtime updates — listen for broadcast:updated / broadcast:deleted.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleUpdate = (data: any) => {
      if (!data?.id) return;
      setBroadcasts((prev) => {
        const idx = prev.findIndex((b) => b.id === data.id);
        if (idx === -1) return [data, ...prev];
        const next = prev.slice();
        next[idx] = { ...next[idx], ...data };
        return next;
      });
    };

    const handleDelete = (data: any) => {
      if (!data?.id) return;
      setBroadcasts((prev) => prev.filter((b) => b.id !== data.id));
    };

    socket.on("broadcast:updated", handleUpdate);
    socket.on("broadcast:deleted", handleDelete);
    return () => {
      socket.off("broadcast:updated", handleUpdate);
      socket.off("broadcast:deleted", handleDelete);
    };
  }, [token]);

  async function fetchBroadcasts() {
    if (!token) return;
    setLoading(true);
    try {
      const res = await getBroadcasts(token);
      setBroadcasts(res.data ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchTemplates() {
    if (!token) return;
    try {
      const res = await getTemplates(token);
      setTemplates(res.data ?? []);
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchChannelAccounts() {
    if (!token) return;
    try {
      const res = await getChannelAccounts(token);
      // Hide Meta channels — Facebook / Instagram / Messenger DMs cannot be
      // initiated by the business; outbound is restricted to user-initiated
      // 24h messaging windows, so they don't belong in a broadcast picker.
      const blocked = new Set(["INSTAGRAM", "MESSENGER", "FACEBOOK"]);
      setChannelAccounts(
        (res.data ?? []).filter(
          (a: any) => !blocked.has(String(a.channel || "").toUpperCase()),
        ),
      );
    } catch (err) {
      console.error(err);
    }
  }

  function openCreate() {
    setEditingId(null);
    setWizard(emptyWizard());
    setStep(0);
    setError("");
    setCreatedBroadcastId(null);
    setShowPanel(true);
  }

  function openEdit(bc: Broadcast) {
    setEditingId(bc.id);
    setWizard({
      ...emptyWizard(),
      name: bc.name,
      channel: bc.channel,
      channelAccountId: bc.channelAccountId ?? "",
      templateId: bc.templateId ?? "",
      body: bc.body ?? "",
      scheduledAt: bc.scheduledAt ?? "",
      sendNow: !bc.scheduledAt,
    });
    setStep(0);
    setError("");
    setCreatedBroadcastId(bc.id);
    setShowPanel(true);
  }

  function closePanel() {
    setShowPanel(false);
    setEditingId(null);
    setCreatedBroadcastId(null);
    setStep(0);
    setError("");
  }

  // ── Wizard navigation ────────────────────────────────────────────────────

  function setW<K extends keyof WizardState>(key: K, val: WizardState[K]) {
    setWizard((prev) => ({ ...prev, [key]: val }));
  }

  async function handleNext() {
    setError("");

    if (step === 0) {
      // Validate step 1
      if (!wizard.name.trim()) {
        setError("outbound.broadcasts.errorName");
        return;
      }
      if (!wizard.channelAccountId) {
        setError("outbound.broadcasts.errorChannel");
        return;
      }
      // Create/update broadcast on step 1 completion
      if (!token) return;
      setSaving(true);
      try {
        const payload = {
          name: wizard.name.trim(),
          channel: wizard.channel,
          channelAccountId: wizard.channelAccountId,
          templateId: wizard.templateId || undefined,
          body: wizard.body || undefined,
        };
        if (editingId || createdBroadcastId) {
          const id = editingId ?? createdBroadcastId!;
          await updateBroadcast(token, id, payload);
          setCreatedBroadcastId(id);
        } else {
          const res = await createBroadcast(token, payload);
          setCreatedBroadcastId(res.data?.id ?? null);
        }
        setStep(1);
      } catch (err: any) {
        setError(err.message || "common.error");
      } finally {
        setSaving(false);
      }
      return;
    }

    if (step === 1) {
      // Add recipients if we have a broadcast id
      if (token && createdBroadcastId) {
        const recipients = parseRecipients();
        if (recipients.length > 0) {
          setSaving(true);
          try {
            await addBroadcastRecipients(token, createdBroadcastId, recipients);
          } catch (err: any) {
            // Non-fatal: log but continue
            console.warn("addBroadcastRecipients:", err.message);
          } finally {
            setSaving(false);
          }
        }
      }
      // Trigger validation when entering step 2
      setStep(2);
      if (token && createdBroadcastId) {
        setValidation(null);
        setValidating(true);
        try {
          const res = await validateBroadcast(token, createdBroadcastId);
          setValidation(res.data ?? null);
        } catch (err: any) {
          console.warn("validateBroadcast:", err.message);
        } finally {
          setValidating(false);
        }
      }
      return;
    }

    if (step === 2) {
      setStep(3);
      return;
    }
  }

  function handleBack() {
    if (step > 0) setStep((s) => s - 1);
  }

  // ── Final submit (step 3) ────────────────────────────────────────────────

  async function handleFinish() {
    if (!token || !createdBroadcastId) return;
    setSaving(true);
    setError("");
    try {
      // Update scheduled time if not sending now
      if (!wizard.sendNow && wizard.scheduledAt) {
        await updateBroadcast(token, createdBroadcastId, {
          scheduledAt: new Date(wizard.scheduledAt).toISOString(),
        });
      }
      if (wizard.sendNow) {
        await sendBroadcast(token, createdBroadcastId);
      }
      closePanel();
      fetchBroadcasts();
    } catch (err: any) {
      setError(err.message || "common.error");
    } finally {
      setSaving(false);
    }
  }

  // ── Recipients parsing ───────────────────────────────────────────────────

  function parseRecipients(): { externalId: string }[] {
    if (wizard.recipientTab === "import") {
      return wizard.importText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((externalId) => ({ externalId }));
    }
    // segment / all: server-side resolution; return empty for now
    return [];
  }

  function parsedCount(): number {
    return parseRecipients().length;
  }

  // ── CSV file import ──────────────────────────────────────────────────────

  function handleFileUpload(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      // Extract first column from CSV
      const lines = text.split("\n").map((l) => l.split(",")[0].trim()).filter(Boolean);
      setW("importText", lines.join("\n"));
    };
    reader.readAsText(file);
  }

  // ── Send/Cancel actions on cards ─────────────────────────────────────────

  async function handleSend(id: string) {
    if (!token) return;
    try {
      await sendBroadcast(token, id);
      fetchBroadcasts();
    } catch (err: any) {
      alert(err.message || t("common.error"));
    }
  }

  async function handleCancel(id: string) {
    if (!token) return;
    try {
      await cancelBroadcast(token, id);
      // Realtime socket will refresh; no manual fetch needed.
    } catch (err: any) {
      alert(err.message || t("common.error"));
    }
  }

  async function handleDelete(id: string) {
    if (!token) return;
    if (!confirm(t("outbound.broadcasts.deleteConfirm"))) return;
    try {
      await deleteBroadcast(token, id);
      setBroadcasts((prev) => prev.filter((b) => b.id !== id));
    } catch (err: any) {
      alert(err.message || t("common.error"));
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          {broadcasts.length} {t("outbound.broadcasts.count")}
        </p>
        <button
          onClick={openCreate}
          className="bg-primary-500 hover:bg-primary-600 text-white px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("outbound.broadcasts.create")}
        </button>
      </div>

      {/* Broadcast Cards */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
        </div>
      ) : broadcasts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
          <svg
            className="w-10 h-10 text-gray-300 mx-auto mb-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
            />
          </svg>
          <p className="text-gray-400 text-sm">{t("common.noResults")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {broadcasts.map((bc) => {
            const isExpanded = expandedId === bc.id;
            const canSend = bc.status === "DRAFT";
            const canCancel = bc.status === "SCHEDULED" || bc.status === "SENDING";
            const canDelete = bc.status !== "SENDING";
            const isTerminal = bc.status === "COMPLETED" || bc.status === "FAILED" || bc.status === "CANCELLED" || bc.status === "SENDING";

            return (
              <div key={bc.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-4 md:p-5">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-gray-900 text-sm">{bc.name}</h3>
                        <span
                          className={clsx(
                            "px-2 py-0.5 rounded-full text-xs font-medium",
                            STATUS_BADGES[bc.status] ?? "bg-gray-100 text-gray-500"
                          )}
                        >
                          {bc.status}
                        </span>
                        <span className="text-xs text-gray-400">{bc.channel}</span>
                      </div>
                      {bc.body && (
                        <p className="text-xs text-gray-500 mt-1 line-clamp-2">{bc.body}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-1">
                        {t("outbound.broadcasts.recipients")}: {bc.totalRecipients}
                        {bc.scheduledAt &&
                          ` · ${t("outbound.broadcasts.scheduledAt")} ${new Date(bc.scheduledAt).toLocaleString()}`}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isTerminal && (
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : bc.id)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition"
                        >
                          {isExpanded ? t("outbound.broadcasts.hideStats") : t("outbound.broadcasts.view")}
                        </button>
                      )}
                      {bc.status === "DRAFT" && (
                        <button
                          onClick={() => openEdit(bc)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-primary-50 text-primary-600 hover:bg-primary-100 transition"
                        >
                          {t("common.edit")}
                        </button>
                      )}
                      {canSend && (
                        <button
                          onClick={() => handleSend(bc.id)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition font-medium"
                        >
                          {t("outbound.broadcasts.send")}
                        </button>
                      )}
                      {canCancel && (
                        <button
                          onClick={() => handleCancel(bc.id)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition"
                        >
                          {t("outbound.broadcasts.cancel")}
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => handleDelete(bc.id)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition"
                          title={t("common.delete")}
                        >
                          {t("common.delete")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Error banner — show any captured broadcast-level error */}
                  {bc.lastError && (
                    <div className="mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-100 text-xs text-red-700 flex items-start gap-2">
                      <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0-10.036A9 9 0 1021 12a9 9 0 00-9-9.286zM12 15.75h.008v.008H12v-.008z" />
                      </svg>
                      <span className="leading-relaxed break-words">
                        <strong className="font-semibold">{t("outbound.broadcasts.stoppedError")}: </strong>
                        {bc.lastError}
                      </span>
                    </div>
                  )}

                  {/* Analytics */}
                  {isExpanded && isTerminal && (
                    <div className="mt-4 pt-4 border-t border-gray-50">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
                        {t("outbound.broadcasts.analytics")}
                      </p>
                      <ProgressBar
                        label={t("outbound.broadcasts.statSent")}
                        value={bc.sentCount}
                        total={bc.totalRecipients}
                        color="bg-blue-400"
                      />
                      <ProgressBar
                        label={t("outbound.broadcasts.statDelivered")}
                        value={bc.deliveredCount}
                        total={bc.totalRecipients}
                        color="bg-green-400"
                      />
                      <ProgressBar
                        label={t("outbound.broadcasts.statRead")}
                        value={bc.readCount}
                        total={bc.totalRecipients}
                        color="bg-purple-400"
                      />
                      <ProgressBar
                        label={t("outbound.broadcasts.statReplied")}
                        value={bc.repliedCount}
                        total={bc.totalRecipients}
                        color="bg-primary-400"
                      />
                      {bc.failedCount > 0 && (
                        <ProgressBar
                          label={t("outbound.broadcasts.statFailed")}
                          value={bc.failedCount}
                          total={bc.totalRecipients}
                          color="bg-red-400"
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Slide-over Panel ── */}
      {showPanel && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
            onClick={closePanel}
          />

          {/* Panel */}
          <div className="fixed inset-y-0 right-0 w-full md:w-[65%] bg-white shadow-2xl z-50 flex flex-col">
            {/* Panel Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <div>
                <h2 className="text-base font-bold text-gray-900">
                  {editingId
                    ? t("outbound.broadcasts.editTitle")
                    : t("outbound.broadcasts.createTitle")}
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {t(STEPS[step])}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <StepIndicator current={step} total={4} />
                <button
                  onClick={closePanel}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Error bar */}
            {error && (
              <div className="px-6 py-2 bg-red-50 border-b border-red-100">
                <p className="text-sm text-red-600">{t(error) !== error ? t(error) : error}</p>
              </div>
            )}

            {/* Panel Body */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {/* ── Step 1: Basic Info ── */}
              {step === 0 && (
                <div className="space-y-5 max-w-xl">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      {t("outbound.broadcasts.fieldName")}
                    </label>
                    <input
                      type="text"
                      value={wizard.name}
                      onChange={(e) => setW("name", e.target.value)}
                      className={inputCls}
                      placeholder={t("outbound.broadcasts.fieldName")}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      {t("outbound.broadcasts.fieldChannel")}
                    </label>
                    <ChannelAccountPicker
                      accounts={connectedAccounts}
                      value={wizard.channelAccountId}
                      onChange={(accountId, channel) => {
                        setWizard((prev) => ({ ...prev, channelAccountId: accountId, channel }));
                      }}
                      placeholder={t("outbound.broadcasts.selectChannel")}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      {t("outbound.broadcasts.fieldTemplate")}
                    </label>
                    <select
                      value={wizard.templateId}
                      onChange={(e) => setW("templateId", e.target.value)}
                      className={selectCls}
                    >
                      <option value="">{t("outbound.broadcasts.noTemplate")}</option>
                      {templates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!wizard.templateId && (
                    <AIComposeScope
                      surface="scheduled"
                      channel={wizard.channel}
                      currentValue={wizard.body}
                      onApply={(text) => setW("body", text)}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-sm font-medium text-gray-700">
                          {t("outbound.broadcasts.fieldBody")}
                        </label>
                        <AIComposeTrigger />
                      </div>
                      <textarea
                        value={wizard.body}
                        onChange={(e) => setW("body", e.target.value)}
                        rows={5}
                        className={inputCls}
                        placeholder={t("outbound.broadcasts.bodyPlaceholder")}
                      />
                      <AIComposePanel />
                    </AIComposeScope>
                  )}
                </div>
              )}

              {/* ── Step 2: Recipients ── */}
              {step === 1 && (
                <div className="max-w-2xl space-y-4">
                  {/* Tab switcher */}
                  <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
                    {(["segment", "import", "all"] as RecipientTab[]).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setW("recipientTab", tab)}
                        className={clsx(
                          "px-4 py-1.5 rounded-lg text-sm font-medium transition",
                          wizard.recipientTab === tab
                            ? "bg-white text-gray-900 shadow-sm"
                            : "text-gray-500 hover:text-gray-700"
                        )}
                      >
                        {t(`outbound.broadcasts.tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`)}
                      </button>
                    ))}
                  </div>

                  {/* CRM Segment builder */}
                  {wizard.recipientTab === "segment" && (
                    <div className="space-y-3">
                      <p className="text-sm text-gray-500">
                        {t("outbound.broadcasts.segmentDesc")}
                      </p>

                      {wizard.segmentRules.length === 0 && (
                        <div className="border border-dashed border-gray-200 rounded-xl p-6 text-center text-sm text-gray-400">
                          {t("outbound.broadcasts.segmentEmpty")}
                        </div>
                      )}

                      <div className="space-y-2">
                        {wizard.segmentRules.map((rule, idx) => (
                          <div key={rule.id} className="flex items-center gap-2">
                            {idx > 0 && (
                              <span className="text-xs font-medium text-gray-400 w-8 text-center shrink-0">
                                AND
                              </span>
                            )}
                            {idx === 0 && <div className="w-8 shrink-0" />}

                            <select
                              value={rule.field}
                              onChange={(e) => {
                                const rules = [...wizard.segmentRules];
                                rules[idx] = { ...rule, field: e.target.value as SegmentField };
                                setW("segmentRules", rules);
                              }}
                              className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
                            >
                              {SEGMENT_FIELDS.map((f) => (
                                <option key={f.value} value={f.value}>
                                  {t(f.label)}
                                </option>
                              ))}
                            </select>

                            <select
                              value={rule.operator}
                              onChange={(e) => {
                                const rules = [...wizard.segmentRules];
                                rules[idx] = { ...rule, operator: e.target.value as SegmentOperator };
                                setW("segmentRules", rules);
                              }}
                              className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
                            >
                              {SEGMENT_OPERATORS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {t(o.label)}
                                </option>
                              ))}
                            </select>

                            <input
                              type={rule.field === "lastSeenAfter" ? "date" : "text"}
                              value={rule.value}
                              onChange={(e) => {
                                const rules = [...wizard.segmentRules];
                                rules[idx] = { ...rule, value: e.target.value };
                                setW("segmentRules", rules);
                              }}
                              placeholder={t("outbound.broadcasts.segmentValue")}
                              className="flex-[2] px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
                            />

                            <button
                              type="button"
                              onClick={() =>
                                setW(
                                  "segmentRules",
                                  wizard.segmentRules.filter((_, i) => i !== idx)
                                )
                              }
                              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition shrink-0"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => setW("segmentRules", [...wizard.segmentRules, newRule()])}
                        className="flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 font-medium transition"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        {t("outbound.broadcasts.addRule")}
                      </button>

                      <div className="mt-4 p-3 bg-blue-50 rounded-xl text-sm text-blue-600">
                        {t("outbound.broadcasts.segmentEstimate")}
                      </div>
                    </div>
                  )}

                  {/* Import tab */}
                  {wizard.recipientTab === "import" && (
                    <div className="space-y-4">
                      <p className="text-sm text-gray-500">{t("outbound.broadcasts.importDesc")}</p>

                      <textarea
                        value={wizard.importText}
                        onChange={(e) => setW("importText", e.target.value)}
                        rows={8}
                        className={inputCls}
                        placeholder={t("outbound.broadcasts.importPlaceholder")}
                      />

                      {/* Drag-drop CSV */}
                      <div
                        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragOver(false);
                          const file = e.dataTransfer.files[0];
                          if (file) handleFileUpload(file);
                        }}
                        onClick={() => fileInputRef.current?.click()}
                        className={clsx(
                          "border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition",
                          dragOver
                            ? "border-primary-400 bg-primary-50"
                            : "border-gray-200 hover:border-primary-300 hover:bg-gray-50"
                        )}
                      >
                        <svg
                          className="w-8 h-8 text-gray-300 mx-auto mb-2"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={1.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                          />
                        </svg>
                        <p className="text-sm text-gray-400">{t("outbound.broadcasts.importDrop")}</p>
                        <p className="text-xs text-gray-300 mt-1">.csv</p>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".csv"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFileUpload(file);
                          }}
                        />
                      </div>

                      {parsedCount() > 0 && (
                        <p className="text-sm text-green-600 font-medium">
                          {parsedCount()} {t("outbound.broadcasts.importCount")}
                        </p>
                      )}
                    </div>
                  )}

                  {/* All contacts tab */}
                  {wizard.recipientTab === "all" && (
                    <div className="space-y-3">
                      <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                        <p className="text-sm text-amber-700 font-medium">
                          {t("outbound.broadcasts.allContactsWarning")}
                        </p>
                        <p className="text-xs text-amber-500 mt-1">
                          {t("outbound.broadcasts.allContactsDesc")}
                        </p>
                      </div>
                      <div className="p-3 bg-blue-50 rounded-xl text-sm text-blue-600">
                        {t("outbound.broadcasts.segmentEstimate")}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Step 3: Validate ── */}
              {step === 2 && (
                <div className="max-w-xl space-y-4">
                  <h3 className="text-sm font-semibold text-gray-800 mb-3">
                    {t("outbound.broadcasts.validateTitle")}
                  </h3>
                  {validating && (
                    <div className="flex items-center justify-center py-12">
                      <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                    </div>
                  )}
                  {!validating && validation && (
                    <div className="space-y-4">
                      {/* Summary stats */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-green-50 rounded-xl p-4 text-center">
                          <p className="text-2xl font-bold text-green-600">{validation.reachableCount}</p>
                          <p className="text-xs text-green-500">{t("outbound.broadcasts.validateReachable")}</p>
                        </div>
                        <div className="bg-red-50 rounded-xl p-4 text-center">
                          <p className="text-2xl font-bold text-red-600">{validation.invalidCount}</p>
                          <p className="text-xs text-red-500">{t("outbound.broadcasts.validateInvalid")}</p>
                        </div>
                        <div className="bg-yellow-50 rounded-xl p-4 text-center">
                          <p className="text-2xl font-bold text-yellow-600">{validation.optedOutCount}</p>
                          <p className="text-xs text-yellow-500">{t("outbound.broadcasts.validateOptedOut")}</p>
                        </div>
                        <div className="bg-blue-50 rounded-xl p-4 text-center">
                          <p className="text-2xl font-bold text-blue-600">${validation.estimatedCost}</p>
                          <p className="text-xs text-blue-500">{t("outbound.broadcasts.validateEstCost")}</p>
                        </div>
                      </div>
                      {/* Warnings */}
                      {validation.warnings?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                          <p className="text-sm font-medium text-amber-700 mb-2">{t("outbound.broadcasts.validateWarnings")}</p>
                          {validation.warnings.map((w: string, i: number) => (
                            <p key={i} className="text-xs text-amber-600">• {w}</p>
                          ))}
                        </div>
                      )}
                      {/* Invalid reasons */}
                      {validation.invalidReasons?.length > 0 && (
                        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                          <p className="text-sm font-medium text-red-700 mb-2">{t("outbound.broadcasts.validateInvalidReasons")}</p>
                          {validation.invalidReasons.map((r: string, i: number) => (
                            <p key={i} className="text-xs text-red-500">• {r}</p>
                          ))}
                        </div>
                      )}
                      {!validation.canSend && (
                        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-600 font-medium">
                          {t("outbound.broadcasts.validateCannotSend")}
                        </div>
                      )}
                    </div>
                  )}
                  {!validating && !validation && (
                    <div className="text-sm text-gray-400 text-center py-8">
                      {t("outbound.broadcasts.validateNoData")}
                    </div>
                  )}
                </div>
              )}

              {/* ── Step 4: Schedule & Send ── */}
              {step === 3 && (
                <div className="max-w-xl space-y-6">
                  {/* Scheduling */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800 mb-3">
                      {t("outbound.broadcasts.scheduleTitle")}
                    </h3>

                    <label className="flex items-center gap-3 cursor-pointer mb-4">
                      <div
                        onClick={() => setW("sendNow", !wizard.sendNow)}
                        className={clsx(
                          "relative w-10 h-5.5 rounded-full transition-colors",
                          wizard.sendNow ? "bg-primary-500" : "bg-gray-200"
                        )}
                        style={{ height: "22px", width: "40px" }}
                      >
                        <span
                          className={clsx(
                            "absolute top-0.5 w-4.5 h-4.5 bg-white rounded-full shadow transition-transform",
                            wizard.sendNow ? "translate-x-[18px]" : "translate-x-0.5"
                          )}
                          style={{ width: "18px", height: "18px" }}
                        />
                      </div>
                      <span className="text-sm font-medium text-gray-700">
                        {t("outbound.broadcasts.sendNow")}
                      </span>
                    </label>

                    {!wizard.sendNow && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1.5">
                          {t("outbound.broadcasts.scheduleAt")}
                        </label>
                        <input
                          type="datetime-local"
                          value={wizard.scheduledAt}
                          onChange={(e) => setW("scheduledAt", e.target.value)}
                          className={inputCls}
                          min={new Date().toISOString().slice(0, 16)}
                        />
                      </div>
                    )}
                  </div>

                  {/* Review summary */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800 mb-3">
                      {t("outbound.broadcasts.reviewTitle")}
                    </h3>
                    <div className="bg-gray-50 rounded-2xl border border-gray-100 divide-y divide-gray-100">
                      <ReviewRow label={t("outbound.broadcasts.fieldName")} value={wizard.name} />
                      <ReviewRow
                        label={t("outbound.broadcasts.fieldChannel")}
                        value={
                          connectedAccounts.find((a) => a.id === wizard.channelAccountId)
                            ?.displayName ?? wizard.channel
                        }
                      />
                      {wizard.templateId && (
                        <ReviewRow
                          label={t("outbound.broadcasts.fieldTemplate")}
                          value={
                            templates.find((t) => t.id === wizard.templateId)?.name ??
                            wizard.templateId
                          }
                        />
                      )}
                      <ReviewRow
                        label={t("outbound.broadcasts.reviewRecipients")}
                        value={
                          wizard.recipientTab === "import"
                            ? `${parsedCount()} ${t("outbound.broadcasts.importCount")}`
                            : wizard.recipientTab === "all"
                            ? t("outbound.broadcasts.allContactsLabel")
                            : `${wizard.segmentRules.length} ${t("outbound.broadcasts.segmentRules")}`
                        }
                      />
                      <ReviewRow
                        label={t("outbound.broadcasts.reviewSchedule")}
                        value={
                          wizard.sendNow
                            ? t("outbound.broadcasts.sendNow")
                            : wizard.scheduledAt
                            ? new Date(wizard.scheduledAt).toLocaleString()
                            : t("outbound.broadcasts.notScheduled")
                        }
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Panel Footer */}
            <div className="shrink-0 px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3 bg-white">
              <button
                type="button"
                onClick={step === 0 ? closePanel : handleBack}
                className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 transition"
              >
                {step === 0 ? t("common.cancel") : t("common.back")}
              </button>

              {step < 3 ? (
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={saving || validating || (step === 2 && validation != null && !validation.canSend)}
                  className="px-6 py-2.5 rounded-xl text-sm font-medium text-white bg-primary-500 hover:bg-primary-600 transition shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {(saving || validating) && (
                    <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  )}
                  {t("common.next")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFinish}
                  disabled={saving || (!wizard.sendNow && !wizard.scheduledAt)}
                  className="px-6 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-600 transition shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
                    <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  )}
                  {wizard.sendNow
                    ? t("outbound.broadcasts.send")
                    : t("outbound.broadcasts.schedule")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Small helper component for review rows
function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-4">
      <span className="text-xs font-medium text-gray-500 shrink-0">{label}</span>
      <span className="text-sm text-gray-800 text-right truncate">{value}</span>
    </div>
  );
}
