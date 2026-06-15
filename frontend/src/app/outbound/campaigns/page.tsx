"use client";

/**
 * Broadcasts page - newsletter / mass-message composer.
 *
 * 3-step wizard (Compose → Audience → Schedule & send) with the audience
 * step doing the heavy lifting: chips + schema-aware rules + live count
 * + preview drawer all in one pane. Validation has been folded into the
 * audience step's live count (the previous separate "validate" page was
 * a friction point and could only ever say what the audience step
 * already shows).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getBroadcasts,
  createBroadcast,
  updateBroadcast,
  sendBroadcast,
  cancelBroadcast,
  resendBroadcast,
  deleteBroadcast,
  getTemplates,
  getChannelAccounts,
  addBroadcastRecipients,
  getAudienceSchema,
} from "@/lib/api";
import ChannelAccountPicker from "@/components/ChannelAccountPicker";
import { getSocket } from "@/lib/socket";
import { AIComposeScope, AIComposeTrigger, AIComposePanel } from "@/components/ai/AIComposeInline";
import {
  AudienceBuilder,
  buildAudienceDefinition,
  emptyAudience,
  type AudienceState,
  type PickedContact,
} from "@/components/broadcasts/AudienceBuilder";
import { SchedulePicker } from "@/components/broadcasts/SchedulePicker";

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
  audience?: any;
}

interface ChannelAccount {
  id: string;
  channel: string;
  displayName: string;
  connectionStatus: string;
  externalId?: string;
}

/** Per-template-variable mapping. Backend resolves at materialize time:
 *  - {source:"crm",field:"First_Name"} → recipient.raw["First_Name"]
 *  - {source:"static",value:"Hi"}      → same value for everyone */
type VariableMapping =
  | { source: "static"; value: string }
  | { source: "crm"; field: string };

interface WizardState {
  // Compose
  name: string;
  channel: string;
  channelAccountId: string;
  templateId: string;
  body: string;
  /** Mapping spec keyed by template variable id ("1", "2", … or named). */
  variables: Record<string, VariableMapping>;
  /** Per-campaign override for IMAGE/VIDEO/DOCUMENT WhatsApp template headers. */
  headerMediaUrl: string;
  // Audience
  audience: AudienceState;
  // Schedule
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

const STEPS = [
  "outbound.broadcasts.wizardCompose",
  "outbound.broadcasts.wizardAudience",
  "outbound.broadcasts.wizardSchedule",
];

const STEP_SUBS = [
  "outbound.broadcasts.composeSubtitle",
  "outbound.broadcasts.audienceSubtitle",
  "outbound.broadcasts.scheduleSubtitle",
];

function emptyWizard(): WizardState {
  return {
    name: "",
    channel: "WHATSAPP",
    channelAccountId: "",
    templateId: "",
    body: "",
    variables: {},
    headerMediaUrl: "",
    audience: emptyAudience(),
    sendNow: true,
    scheduledAt: "",
  };
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

  // Panel
  const [showPanel, setShowPanel] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [wizard, setWizard] = useState<WizardState>(emptyWizard());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createdBroadcastId, setCreatedBroadcastId] = useState<string | null>(null);

  // Audience live count surfaced from AudienceBuilder, used by the Schedule step + footer.
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const connectedAccounts = channelAccounts.filter((a) => a.connectionStatus === "CONNECTED");

  const channelDisplayName = useMemo(() => {
    return connectedAccounts.find((a) => a.id === wizard.channelAccountId)?.displayName ?? wizard.channel;
  }, [connectedAccounts, wizard.channelAccountId, wizard.channel]);

  useEffect(() => {
    if (!token) return;
    fetchBroadcasts();
    fetchTemplates();
    fetchChannelAccounts();
  }, [token]);

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
    setAudienceCount(null);
    setShowPanel(true);
  }

  function openEdit(bc: Broadcast) {
    setEditingId(bc.id);
    // Restore audience state from persisted definition if possible.
    const restoredAudience = audienceFromDefinition(bc.audience) ?? emptyAudience();
    setWizard({
      ...emptyWizard(),
      name: bc.name,
      channel: bc.channel,
      channelAccountId: bc.channelAccountId ?? "",
      templateId: bc.templateId ?? "",
      body: bc.body ?? "",
      variables: variablesFromBroadcast((bc as any).variables),
      headerMediaUrl: (bc as any).headerMediaUrl ?? "",
      audience: restoredAudience,
      scheduledAt: bc.scheduledAt ? toLocalInput(new Date(bc.scheduledAt)) : "",
      sendNow: !bc.scheduledAt,
    });
    setStep(0);
    setError("");
    setCreatedBroadcastId(bc.id);
    setAudienceCount(null);
    setShowPanel(true);
  }

  function closePanel() {
    setShowPanel(false);
    setEditingId(null);
    setCreatedBroadcastId(null);
    setStep(0);
    setError("");
  }

  function setW<K extends keyof WizardState>(key: K, val: WizardState[K]) {
    setWizard((prev) => ({ ...prev, [key]: val }));
  }

  // ─── Step transitions ─────────────────────────────────────────────────────

  async function handleNext() {
    setError("");

    if (step === 0) {
      if (!wizard.name.trim()) {
        setError("outbound.broadcasts.errorName");
        return;
      }
      if (!wizard.channelAccountId) {
        setError("outbound.broadcasts.errorChannel");
        return;
      }
      if (!token) return;
      setSaving(true);
      try {
        const payload = {
          name: wizard.name.trim(),
          channel: wizard.channel,
          channelAccountId: wizard.channelAccountId,
          templateId: wizard.templateId || undefined,
          body: wizard.body || undefined,
          variables: wizard.variables ?? {},
          headerMediaUrl: wizard.headerMediaUrl?.trim() || "",
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
      // Persist the audience definition (or, for Import mode, materialize
      // recipients directly).
      if (token && createdBroadcastId) {
        setSaving(true);
        try {
          if (wizard.audience.mode === "import") {
            const lines = wizard.audience.importText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            if (lines.length > 0) {
              await addBroadcastRecipients(
                token,
                createdBroadcastId,
                lines.map((externalId) => ({ externalId })),
              );
            }
            // Clear any audience definition so send doesn't try to
            // re-resolve on top of materialized rows.
            await updateBroadcast(token, createdBroadcastId, { audience: null });
          } else {
            const audience = buildAudienceDefinition(wizard.audience, wizard.channel);
            await updateBroadcast(token, createdBroadcastId, { audience: audience ?? null });
          }
        } catch (err: any) {
          setError(err.message || "common.error");
          setSaving(false);
          return;
        } finally {
          setSaving(false);
        }
      }
      setStep(2);
      return;
    }
  }

  function handleBack() {
    if (step > 0) setStep((s) => s - 1);
  }

  async function handleFinish() {
    if (!token || !createdBroadcastId) return;
    setSaving(true);
    setError("");
    try {
      if (!wizard.sendNow && wizard.scheduledAt) {
        await updateBroadcast(token, createdBroadcastId, {
          scheduledAt: new Date(wizard.scheduledAt).toISOString(),
        });
      } else if (wizard.sendNow) {
        // Clear any prior schedule so the worker treats it as immediate.
        await updateBroadcast(token, createdBroadcastId, { scheduledAt: null });
      }
      await sendBroadcast(token, createdBroadcastId);
      closePanel();
      fetchBroadcasts();
    } catch (err: any) {
      setError(err.message || "common.error");
    } finally {
      setSaving(false);
    }
  }

  // ─── Send/Cancel/Delete on cards ─────────────────────────────────────────
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
    } catch (err: any) {
      alert(err.message || t("common.error"));
    }
  }
  async function handleResend(bc: Broadcast) {
    if (!token) return;
    try {
      const res = await resendBroadcast(token, bc.id);
      const clone = res.data as Broadcast;
      // Refresh the list and open the wizard on the new draft so the
      // operator can tweak audience/schedule if needed before hitting Send.
      await fetchBroadcasts();
      openEdit(clone);
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

  const onAudienceCountChange = useCallback((count: number | null, loading: boolean) => {
    setAudienceCount(count);
    setAudienceLoading(loading);
  }, []);

  const audienceReadyToAdvance = useMemo(() => {
    if (wizard.audience.mode === "import") {
      return wizard.audience.importText.trim().length > 0;
    }
    if (wizard.audience.mode === "everyone") return true;
    if (audienceCount === null) return wizard.audience.picked.length > 0 || wizard.audience.rules.length > 0;
    return audienceCount > 0;
  }, [wizard.audience, audienceCount]);

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
            const isTerminal =
              bc.status === "COMPLETED" ||
              bc.status === "FAILED" ||
              bc.status === "CANCELLED" ||
              bc.status === "SENDING";

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
                      {(bc.status === "COMPLETED" || bc.status === "FAILED" || bc.status === "CANCELLED") && (
                        <button
                          onClick={() => handleResend(bc)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-primary-50 text-primary-600 hover:bg-primary-100 transition font-medium"
                        >
                          {t("outbound.broadcasts.resend")}
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

                  {isExpanded && isTerminal && (
                    <div className="mt-4 pt-4 border-t border-gray-50">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
                        {t("outbound.broadcasts.analytics")}
                      </p>
                      <ProgressBar label={t("outbound.broadcasts.statSent")} value={bc.sentCount} total={bc.totalRecipients} color="bg-blue-400" />
                      <ProgressBar label={t("outbound.broadcasts.statDelivered")} value={bc.deliveredCount} total={bc.totalRecipients} color="bg-green-400" />
                      <ProgressBar label={t("outbound.broadcasts.statRead")} value={bc.readCount} total={bc.totalRecipients} color="bg-purple-400" />
                      <ProgressBar label={t("outbound.broadcasts.statReplied")} value={bc.repliedCount} total={bc.totalRecipients} color="bg-primary-400" />
                      {bc.failedCount > 0 && (
                        <ProgressBar label={t("outbound.broadcasts.statFailed")} value={bc.failedCount} total={bc.totalRecipients} color="bg-red-400" />
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
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={closePanel} />
          <div className="fixed inset-y-0 right-0 w-full md:w-[68%] bg-white shadow-2xl z-50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <div>
                <h2 className="text-base font-bold text-gray-900">
                  {editingId ? t("outbound.broadcasts.editTitle") : t("outbound.broadcasts.createTitle")}
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">{t(STEP_SUBS[step])}</p>
              </div>
              <div className="flex items-center gap-4">
                <StepIndicator current={step} total={3} />
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

            {error && (
              <div className="px-6 py-2 bg-red-50 border-b border-red-100">
                <p className="text-sm text-red-600">{t(error) !== error ? t(error) : error}</p>
              </div>
            )}

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {/* ── Step 1: Compose ── */}
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
                      className={inputCls}
                    >
                      <option value="">
                        {wizard.channel === "WHATSAPP"
                          ? "Select a template…"
                          : t("outbound.broadcasts.noTemplate")}
                      </option>
                      {templates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </select>
                    {wizard.channel === "WHATSAPP" && (
                      <p className="text-xs text-gray-500 mt-1">
                        WhatsApp requires a pre-approved template for outbound broadcasts.
                        Free-text isn't allowed by Meta outside the 24-hour customer-service window.
                      </p>
                    )}
                  </div>

                  {wizard.templateId && (
                    <>
                      <TemplateMediaHeader
                        templateId={wizard.templateId}
                        templates={templates as any}
                        value={wizard.headerMediaUrl}
                        onChange={(v) => setW("headerMediaUrl", v)}
                      />
                      <TemplatePreview
                        templateId={wizard.templateId}
                        templates={templates as any}
                        variables={wizard.variables}
                      />
                      <VariableMappingForm
                        templateId={wizard.templateId}
                        templates={templates as any}
                        module={wizard.audience.module}
                        value={wizard.variables}
                        onChange={(v) => setW("variables", v)}
                        t={t}
                      />
                    </>
                  )}

                  {wizard.channel !== "WHATSAPP" && !wizard.templateId && (
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

              {/* ── Step 2: Audience ── */}
              {step === 1 && (
                <div className="max-w-3xl">
                  <AudienceBuilder
                    channel={wizard.channel}
                    channelDisplayName={channelDisplayName}
                    state={wizard.audience}
                    onChange={(s) => setW("audience", s)}
                    onCountChange={onAudienceCountChange}
                  />
                </div>
              )}

              {/* ── Step 3: Schedule & send ── */}
              {step === 2 && (
                <div className="max-w-xl space-y-6">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800 mb-3">
                      {t("outbound.broadcasts.scheduleTitle")}
                    </h3>
                    <SchedulePicker
                      sendNow={wizard.sendNow}
                      scheduledAt={wizard.scheduledAt}
                      onChangeSendNow={(v) => setW("sendNow", v)}
                      onChangeScheduledAt={(v) => setW("scheduledAt", v)}
                    />
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-gray-800 mb-3">
                      {t("outbound.broadcasts.reviewTitle")}
                    </h3>
                    <div className="bg-gray-50 rounded-2xl border border-gray-100 divide-y divide-gray-100">
                      <ReviewRow label={t("outbound.broadcasts.fieldName")} value={wizard.name} />
                      <ReviewRow label={t("outbound.broadcasts.fieldChannel")} value={channelDisplayName} />
                      {wizard.templateId && (
                        <ReviewRow
                          label={t("outbound.broadcasts.fieldTemplate")}
                          value={templates.find((tt) => tt.id === wizard.templateId)?.name ?? wizard.templateId}
                        />
                      )}
                      <ReviewRow
                        label={t("outbound.broadcasts.reviewRecipients")}
                        value={
                          audienceLoading
                            ? t("outbound.broadcasts.liveCountLoading")
                            : audienceCount === null
                              ? "-"
                              : String(audienceCount)
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

            {/* Footer */}
            <div className="shrink-0 px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3 bg-white">
              <button
                type="button"
                onClick={step === 0 ? closePanel : handleBack}
                className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 transition"
              >
                {step === 0 ? t("common.cancel") : t("common.back")}
              </button>

              {/* Inline count summary in footer for steps after Compose */}
              {step >= 1 && audienceCount !== null && (
                <div className="hidden md:flex items-center gap-2 text-xs text-gray-500">
                  <span className={clsx(
                    "inline-block w-2 h-2 rounded-full",
                    audienceCount > 0 ? "bg-emerald-400" : "bg-amber-400"
                  )} />
                  <span>{audienceCount} {t("outbound.broadcasts.recipients").toLowerCase()}</span>
                </div>
              )}

              {step < 2 ? (
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={
                    saving ||
                    (step === 1 && !audienceReadyToAdvance && !saving)
                  }
                  className="px-6 py-2.5 rounded-xl text-sm font-medium text-white bg-primary-500 hover:bg-primary-600 transition shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
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
                  {wizard.sendNow ? t("outbound.broadcasts.send") : t("outbound.broadcasts.schedule")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-4">
      <span className="text-xs font-medium text-gray-500 shrink-0">{label}</span>
      <span className="text-sm text-gray-800 text-right truncate">{value}</span>
    </div>
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Best-effort restore of an AudienceState from a persisted audience
 * definition. Filter rules come back without their human labels (the
 * schema endpoint owns those) - the rule editor will repopulate
 * label/type when the operator clicks the field.
 */
function audienceFromDefinition(def: any): AudienceState | null {
  if (!def || typeof def !== "object") return null;
  const out: AudienceState = emptyAudience();
  if (def.module === "leads" || def.module === "contacts") {
    out.module = def.module;
  }

  const restoreCrmPicks = (raw: any): PickedContact[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c) => c && typeof c.id === "string")
      .map((c: any) => ({
        id: c.id,
        source: "crm" as const,
        displayName: typeof c.displayName === "string" ? c.displayName : undefined,
        phone: typeof c.phone === "string" ? c.phone : undefined,
        email: typeof c.email === "string" ? c.email : undefined,
      }));
  };

  // Legacy "manual" and "pick" definitions both surface as Smart mode in
  // the new UI - the unified Find&Filter screen handles chips-only just
  // fine, so there's no reason to expose two near-identical tabs.
  if (def.type === "manual" && Array.isArray(def.contactIds)) {
    out.mode = "smart";
    out.picked = [
      ...def.contactIds.map((id: string) => ({ id, source: "local" as const })),
      ...restoreCrmPicks(def.crmContacts),
    ];
    return out;
  }
  if (def.type === "filter" && def.rules?.all) {
    out.mode = "smart";
    out.rules = def.rules.all.map((r: any) => ({
      id: Math.random().toString(36).slice(2),
      field: r.field,
      op: r.op,
      value: r.value,
    }));
    return out;
  }
  if (def.type === "composite") {
    if (def.everyone) out.mode = "everyone";
    else out.mode = "smart"; // chips-only OR rules-only OR both ⇒ Smart
    out.picked = [
      ...(def.contactIds ?? []).map((id: string) => ({ id, source: "local" as const })),
      ...restoreCrmPicks(def.crmContacts),
    ];
    out.rules = (def.rules?.all ?? []).map((r: any) => ({
      id: Math.random().toString(36).slice(2),
      field: r.field,
      op: r.op,
      value: r.value,
    }));
    return out;
  }
  return null;
}

/** Restore wizard.variables from a persisted Broadcast.variables JSON.
 *  Accepts the new mapping shape and the legacy flat shape ({1: "Hi"}). */
function variablesFromBroadcast(raw: unknown): Record<string, VariableMapping> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, VariableMapping> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const m = val as { source?: string; field?: string; value?: unknown };
      if (m.source === "crm" && typeof m.field === "string") {
        out[key] = { source: "crm", field: m.field };
      } else if (m.source === "static") {
        out[key] = { source: "static", value: m.value == null ? "" : String(m.value) };
      } else {
        out[key] = { source: "static", value: "" };
      }
    } else {
      out[key] = { source: "static", value: val == null ? "" : String(val) };
    }
  }
  return out;
}

// ─── Template variable → CRM field mapping form ───────────────────────────────

interface CrmFieldDef {
  name: string;
  label: string;
  type: string;
}

function VariableMappingForm({
  templateId,
  templates,
  module,
  value,
  onChange,
  t,
}: {
  templateId: string;
  templates: Array<{ id: string; variables?: Array<{ key: string; sample?: string }>; body?: string }>;
  module: "leads" | "contacts";
  value: Record<string, VariableMapping>;
  onChange: (v: Record<string, VariableMapping>) => void;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const { token } = useAuth();
  const [crmFields, setCrmFields] = useState<CrmFieldDef[]>([]);

  // Derive the variable list from the template's declared variables, with
  // a fallback to scanning {{n}} placeholders in the body. This keeps the
  // form working for templates that pre-date the explicit variables array.
  const tpl = templates.find((tt) => tt.id === templateId);
  const declaredVars = Array.isArray(tpl?.variables) ? tpl!.variables : [];
  const bodyKeys = useMemo(() => {
    const re = /\{\{\s*([\w-]+)\s*\}\}/g;
    const set = new Set<string>();
    const body = tpl?.body ?? "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) set.add(m[1]);
    return Array.from(set);
  }, [tpl?.body]);
  const varKeys: string[] = declaredVars.length
    ? declaredVars.map((v) => v.key)
    : bodyKeys;

  useEffect(() => {
    if (!token || varKeys.length === 0) return;
    let cancelled = false;
    getAudienceSchema(token, module)
      .then((res) => {
        if (cancelled) return;
        const fields = ((res.data.crm as any)?.schema?.fields ?? []) as CrmFieldDef[];
        setCrmFields(fields);
      })
      .catch(() => {
        if (!cancelled) setCrmFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, module, varKeys.length]);

  if (varKeys.length === 0) return null;

  function setKey(key: string, mapping: VariableMapping) {
    onChange({ ...value, [key]: mapping });
  }

  return (
    <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3 space-y-2 min-w-0">
      <div className="text-xs font-semibold text-violet-900">
        {t("outbound.broadcasts.varsTitle")}
      </div>
      <div className="text-[11px] text-violet-700/80">
        {t("outbound.broadcasts.varsHelp")}
      </div>
      <div className="space-y-2">
        {varKeys.map((key) => {
          const sample = declaredVars.find((v) => v.key === key)?.sample;
          const current = value[key] ?? { source: "static" as const, value: "" };
          return (
            <div
              key={key}
              className="flex flex-wrap items-center gap-2 bg-white rounded-lg border border-gray-200 p-2 min-w-0"
            >
              <code className="px-2 py-1 text-xs font-mono bg-gray-100 rounded shrink-0">{`{{${key}}}`}</code>
              {sample && (
                <span className="text-[11px] text-gray-400 truncate max-w-[140px]">
                  {t("outbound.broadcasts.varsSample", { sample })}
                </span>
              )}
              <select
                value={current.source}
                onChange={(e) => {
                  if (e.target.value === "crm") setKey(key, { source: "crm", field: "" });
                  else setKey(key, { source: "static", value: "" });
                }}
                className="text-xs px-2 py-1 rounded border border-gray-200 bg-gray-50 shrink-0"
              >
                <option value="static">{t("outbound.broadcasts.varsStatic")}</option>
                <option value="crm">{t("outbound.broadcasts.varsCrm")}</option>
              </select>
              {current.source === "static" ? (
                <input
                  type="text"
                  value={current.value}
                  onChange={(e) => setKey(key, { source: "static", value: e.target.value })}
                  placeholder={sample || ""}
                  className="flex-1 min-w-[140px] text-xs px-2 py-1 rounded border border-gray-200"
                />
              ) : (
                <select
                  value={current.field}
                  onChange={(e) => setKey(key, { source: "crm", field: e.target.value })}
                  className="flex-1 min-w-[140px] max-w-full text-xs px-2 py-1 rounded border border-gray-200 bg-white truncate"
                >
                  <option value="">{t("outbound.broadcasts.varsPickField")}</option>
                  {crmFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label} ({f.name})
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Per-campaign media header override ──────────────────────────────────────

/** When the selected template has an IMAGE/VIDEO/DOCUMENT header, expose
 *  a URL input so the operator can ship a campaign-specific media asset
 *  (e.g., today's promo image) instead of the template's example URL.
 *  Pre-fills with the template's example URL on first render. */
function TemplateMediaHeader({
  templateId,
  templates,
  value,
  onChange,
}: {
  templateId: string;
  templates: Array<{ id: string; headerType?: string | null; headerContent?: string | null }>;
  value: string;
  onChange: (v: string) => void;
}) {
  const tpl = templates.find((tt) => tt.id === templateId);
  const headerType = tpl?.headerType ?? null;
  const isMedia = headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT";

  // Pre-fill once with the template's example URL so the operator sees a
  // sensible default instead of an empty box. Picks up template changes too.
  useEffect(() => {
    if (!isMedia) return;
    if (value) return;
    if (tpl?.headerContent) onChange(tpl.headerContent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, isMedia]);

  if (!isMedia) return null;

  const lower = headerType.toLowerCase();
  return (
    <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-3 space-y-2">
      <div className="text-xs font-semibold text-amber-900">Campaign {lower}</div>
      <div className="text-[11px] text-amber-700/80">
        This template uses an {lower} header. Set a public URL - it will be sent as the live {lower} to every recipient in this campaign.
      </div>
      <input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-xs px-2 py-1.5 rounded border border-gray-200 bg-white"
        placeholder={
          headerType === "IMAGE"
            ? "https://example.com/campaign.jpg"
            : headerType === "VIDEO"
            ? "https://example.com/campaign.mp4"
            : "https://example.com/campaign.pdf"
        }
      />
    </div>
  );
}

// ─── Template body preview ────────────────────────────────────────────────────

/** Renders the template body with each {{var}} substituted by the operator's
 *  current mapping - static value, the literal CRM field name (so the user
 *  can see what will be filled in per recipient), or the declared sample
 *  value when nothing is mapped yet. Pure read-only display. */
function TemplatePreview({
  templateId,
  templates,
  variables,
}: {
  templateId: string;
  templates: Array<{
    id: string;
    body?: string;
    variables?: Array<{ key: string; sample?: string }>;
  }>;
  variables: Record<string, VariableMapping>;
}) {
  const tpl = templates.find((tt) => tt.id === templateId);
  if (!tpl?.body) return null;

  const declared = Array.isArray(tpl.variables) ? tpl.variables : [];
  const sampleByKey = new Map(declared.map((v) => [v.key, v.sample]));

  const rendered = tpl.body.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, rawKey: string) => {
    const key = rawKey;
    const mapping = variables[key];
    if (mapping?.source === "static" && mapping.value) return mapping.value;
    if (mapping?.source === "crm" && mapping.field) return `«${mapping.field}»`;
    return sampleByKey.get(key) || `{{${key}}}`;
  });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 min-w-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-700">Preview</span>
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          Template body
        </span>
      </div>
      <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-sm text-gray-800 whitespace-pre-wrap break-words leading-relaxed">
        {rendered}
      </div>
    </div>
  );
}
