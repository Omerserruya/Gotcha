"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDynamicParam } from "@/lib/useRouteParam";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import {
  activateVoiceChannelNumber,
  deactivateVoiceChannelNumber,
  deleteVoiceChannel,
  getVoiceChannel,
  getVoiceChannelAIAgent,
  getVoiceChannelFunnel,
  listAIAgents,
  refreshVoiceChannelNumbers,
  updateVoiceChannelAIAgent,
  updateVoiceChannelFunnel,
  type AIAgentSummary,
  type VoiceChannel,
  type VoiceChannelPhoneNumber,
  type VoiceChannelStatus,
} from "@/lib/api";
import { listFunnelSummaries, type FunnelSummary } from "@/lib/api-funnel";
import clsx from "clsx";

const STATUS_CLASS: Record<VoiceChannelStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700 ring-amber-200",
  ACTIVE: "bg-green-50 text-green-700 ring-green-200",
  DISABLED: "bg-gray-100 text-gray-600 ring-gray-200",
  ERROR: "bg-red-50 text-red-700 ring-red-200",
};

const INCOMING_WEBHOOK_URL = "https://gotcha.co.il/api/voice/incoming/voice";

function truncateSid(sid?: string): string {
  if (!sid) return "—";
  if (sid.length <= 14) return sid;
  return `${sid.slice(0, 6)}…${sid.slice(-4)}`;
}

export default function VoiceChannelDetailPage() {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const flags = useVoiceFlags();

  const STATUS_LABEL: Record<VoiceChannelStatus, string> = {
    PENDING: t("settings.voiceChannels.statusPending"),
    ACTIVE: t("settings.voiceChannels.statusActive"),
    DISABLED: t("settings.voiceChannels.statusDisabled"),
    ERROR: t("settings.voiceChannels.statusError"),
  };

  const channelId = useDynamicParam();

  const [channel, setChannel] = useState<VoiceChannel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingNumberId, setPendingNumberId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Phase 6: AI Employee is now a first-class FK on the channel, surfaced
  // here instead of inside the Copilot Configuration sub-page. We track it
  // independently so the picker can save without rebuilding the whole
  // channel row.
  const [aiAgents, setAiAgents] = useState<AIAgentSummary[]>([]);
  const [aiAgentId, setAiAgentId] = useState<string>("");
  const [aiAgentSaving, setAiAgentSaving] = useState(false);
  // Pipeline funnel override (per-channel). Together with the AI Employee
  // these are the only two AI-related decisions that live ON the channel —
  // everything else was deleted from the legacy Copilot Configuration page.
  const [funnels, setFunnels] = useState<FunnelSummary[]>([]);
  const [funnelId, setFunnelId] = useState<string>("");
  const [funnelSaving, setFunnelSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!token || !channelId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getVoiceChannel(token, channelId);
      setChannel(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, [token, channelId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Load AI Employee binding + funnel binding + tenant lists in parallel —
  // all four are small and the cards need them to render.
  useEffect(() => {
    if (!token || !channelId) return;
    let cancelled = false;
    Promise.all([
      getVoiceChannelAIAgent(token, channelId).catch(() => ({ data: { aiAgentId: null as string | null } })),
      listAIAgents(token).catch(() => ({ data: [] as AIAgentSummary[] })),
      getVoiceChannelFunnel(token, channelId).catch(() => ({ data: { funnelId: null as string | null } })),
      listFunnelSummaries(token).catch(() => [] as FunnelSummary[]),
    ]).then(([aiBind, agentList, funnelBind, funnelList]) => {
      if (cancelled) return;
      setAiAgentId(aiBind.data.aiAgentId ?? "");
      setAiAgents(agentList.data ?? []);
      setFunnelId(funnelBind.data.funnelId ?? "");
      setFunnels(funnelList);
    });
    return () => { cancelled = true; };
  }, [token, channelId]);

  async function handleAiAgentChange(nextId: string) {
    if (!token || !channelId || aiAgentSaving) return;
    const prev = aiAgentId;
    setAiAgentId(nextId);
    setAiAgentSaving(true);
    setError(null);
    try {
      await updateVoiceChannelAIAgent(token, channelId, nextId || null);
      flash(t("settings.voiceChannels.detail.aiEmployeeSaved") || "Saved.");
    } catch (err) {
      setAiAgentId(prev);
      setError(err instanceof Error ? err.message : "ai_agent_update_failed");
    } finally {
      setAiAgentSaving(false);
    }
  }

  async function handleFunnelChange(nextId: string) {
    if (!token || !channelId || funnelSaving) return;
    const prev = funnelId;
    setFunnelId(nextId);
    setFunnelSaving(true);
    setError(null);
    try {
      await updateVoiceChannelFunnel(token, channelId, nextId || null);
      flash("Saved.");
    } catch (err) {
      setFunnelId(prev);
      setError(err instanceof Error ? err.message : "funnel_update_failed");
    } finally {
      setFunnelSaving(false);
    }
  }

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3000);
  }

  async function handleRefresh() {
    if (!token || !channelId || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await refreshVoiceChannelNumbers(token, channelId);
      setChannel((prev) => (prev ? { ...prev, numbers: res.data } : prev));
      flash(t("settings.voiceChannels.detail.syncSuccess"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "refresh_failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleToggle(number: VoiceChannelPhoneNumber) {
    if (!token || !channelId || pendingNumberId) return;
    const targetActive = !number.isActive;

    // Optimistic update.
    setChannel((prev) =>
      prev
        ? {
            ...prev,
            numbers: prev.numbers.map((n) =>
              n.id === number.id ? { ...n, isActive: targetActive } : n,
            ),
          }
        : prev,
    );
    setPendingNumberId(number.id);
    setError(null);

    try {
      const res = targetActive
        ? await activateVoiceChannelNumber(token, channelId, number.id)
        : await deactivateVoiceChannelNumber(token, channelId, number.id);
      setChannel((prev) =>
        prev
          ? {
              ...prev,
              numbers: prev.numbers.map((n) => (n.id === number.id ? res.data : n)),
            }
          : prev,
      );
      // Notify the flags cache that channel reachability changed — either
      // direction can flip `hasActiveVoiceChannel` for the tenant.
      window.dispatchEvent(new Event("voice-channel:activated"));
    } catch (err) {
      // Revert optimistic change.
      setChannel((prev) =>
        prev
          ? {
              ...prev,
              numbers: prev.numbers.map((n) =>
                n.id === number.id ? { ...n, isActive: number.isActive } : n,
              ),
            }
          : prev,
      );
      setError(err instanceof Error ? err.message : "toggle_failed");
    } finally {
      setPendingNumberId(null);
    }
  }

  async function handleDelete() {
    if (!token || !channelId || deleting) return;
    const confirmed = window.confirm(t("settings.voiceChannels.detail.deleteConfirm"));
    if (!confirmed) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteVoiceChannel(token, channelId);
      router.push("/settings/voice-channels");
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete_failed");
      setDeleting(false);
    }
  }

  if (user?.role !== "ADMIN") {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400 text-sm">{t("settings.voiceChannels.adminRequired")}</p>
      </div>
    );
  }

  if (flags.loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm py-16">
        {t("settings.voiceChannels.loading")}
      </div>
    );
  }

  if (!flags.voiceCopilotEnabled) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
        <h1 className="text-2xl font-semibold text-gray-800 mb-2">404</h1>
        <p className="text-sm text-gray-500">{t("settings.voiceChannels.pageNotAvailable")}</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-20">
      {/* Breadcrumb back link */}
      <div>
        <Link
          href="/settings/voice-channels"
          className="text-xs text-gray-500 hover:text-primary-600 inline-flex items-center gap-1"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          {t("settings.voiceChannels.detail.backLink")}
        </Link>
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-10 animate-pulse h-32" />
      ) : !channel ? (
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-10 text-center">
          <p className="text-sm text-gray-500">{error ?? t("settings.voiceChannels.detail.notFound")}</p>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 md:p-6">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-gray-900 truncate">{channel.friendlyName}</h1>
                <p className="text-xs text-gray-400 mt-1 font-mono">
                  {channel.accountSidFingerprint}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/settings/voice-channels/${channelId}/routing`}
                  className="text-xs font-medium px-2.5 py-1 rounded-md bg-primary-50 text-primary-700 ring-1 ring-primary-200 hover:bg-primary-100"
                >
                  {t("settings.voiceChannelRouting.title")}
                </Link>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-50 text-gray-600 ring-1 ring-gray-200">
                  {t("settings.voiceChannels.authBYO")}
                </span>
                <span
                  className={clsx(
                    "text-[11px] font-medium px-2 py-0.5 rounded-full ring-1",
                    STATUS_CLASS[channel.status],
                  )}
                >
                  {STATUS_LABEL[channel.status]}
                </span>
              </div>
            </div>
          </div>

          {channel.config?.outboundProvisioningFailed && (
            <div className="bg-amber-50 text-amber-800 text-sm px-4 py-3 rounded-xl ring-1 ring-amber-200 flex items-center justify-between gap-3">
              <span>{t("settings.voiceChannels.detail.outboundProvisioningFailed")}</span>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="shrink-0 px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-100 hover:bg-amber-200 ring-1 ring-amber-300 rounded-lg transition disabled:opacity-50"
              >
                {t("settings.voiceChannels.detail.retryProvisioning")}
              </button>
            </div>
          )}

          {toast && (
            <div className="bg-green-50 text-green-700 text-sm px-4 py-2.5 rounded-xl ring-1 ring-green-200">
              {toast}
            </div>
          )}

          {error && (
            <div className="bg-red-50 text-red-700 text-sm px-4 py-2.5 rounded-xl ring-1 ring-red-200">
              {error}
            </div>
          )}

          {/* AI Employee — the AIAgent that drives call-pilot turns on
              this channel. Phase 6 promoted this to a real FK column
              (`voice_channels.ai_agent_id`). The AI Employee's own config
              (language, persona, tone, goals, guardrails, etc.) is the
              single source of truth — edit it in Settings → AI Employees. */}
          <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 md:p-6">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <h2 className="font-semibold text-gray-900">AI Employee</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  The AI Employee that drives call-pilot turns on this channel. All
                  the agent-level configuration (language, persona, tone, goals,
                  guardrails) is set on the employee — edit it in Settings → AI
                  Employees.
                </p>
              </div>
              {aiAgentId && (
                <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md uppercase tracking-wider bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
                  Attached
                </span>
              )}
            </div>
            <select
              value={aiAgentId}
              onChange={(e) => handleAiAgentChange(e.target.value)}
              disabled={aiAgentSaving}
              className="w-full md:w-96 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300 disabled:opacity-50"
            >
              <option value="">— None —</option>
              {aiAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role ? ` · ${a.role}` : ""}
                  {a.status && a.status !== "active" ? ` · ${a.status}` : ""}
                </option>
              ))}
            </select>
            {aiAgents.length === 0 && (
              <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                No AI Employees exist yet. Create one in Settings → AI Employees first.
              </p>
            )}
          </div>

          {/* Pipeline funnel — per-channel override of the department-scoped
              funnel resolution. Drives stage-aware copilot during calls
              answered on this number. Independent of the AI Employee
              because the funnel is a CRM/sales-process decision, not an
              agent personality decision. */}
          <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 md:p-6">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <h2 className="font-semibold text-gray-900">Pipeline funnel</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Which funnel the live copilot uses for calls answered on this
                  channel. Leave on <em>Auto</em> to fall back to the
                  department-scoped funnel (or the tenant default).{" "}
                  <Link href="/settings/funnels" className="text-indigo-600 hover:underline">
                    Manage funnels →
                  </Link>
                </p>
              </div>
              {funnelId && (
                <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md uppercase tracking-wider bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100">
                  Channel override
                </span>
              )}
            </div>
            <select
              value={funnelId}
              onChange={(e) => handleFunnelChange(e.target.value)}
              disabled={funnelSaving}
              className="w-full md:w-96 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300 disabled:opacity-50"
            >
              <option value="">— Auto (department default) —</option>
              {funnels.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.funnelId}
                  {f.departmentId ? ` · dept ${f.departmentId}` : " · tenant default"}
                  {f.isActive ? " · active" : ""}
                  {" · "}{f.stageCount} stages
                </option>
              ))}
            </select>
            {funnels.length === 0 && (
              <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                No funnels exist yet.{" "}
                <Link href="/settings/funnels" className="font-semibold underline">
                  Create one first
                </Link>{" "}
                to enable stage-driven goals.
              </p>
            )}
          </div>

          {/* Phone numbers */}
          <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-5 md:p-6">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
              <div>
                <h2 className="font-semibold text-gray-900">{t("settings.voiceChannels.detail.phoneNumbersTitle")}</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {t("settings.voiceChannels.detail.phoneNumbersSubtitle")}
                </p>
              </div>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="px-3 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 ring-1 ring-primary-200 rounded-lg transition disabled:opacity-50 whitespace-nowrap"
              >
                {refreshing ? t("settings.voiceChannels.detail.refreshing") : t("settings.voiceChannels.detail.refreshButton")}
              </button>
            </div>

            {channel.numbers.length === 0 ? (
              <p className="text-sm text-gray-500 py-6 text-center">
                {t("settings.voiceChannels.detail.noNumbers")}
              </p>
            ) : (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-start text-[11px] uppercase tracking-wide text-gray-400">
                      <th className="font-medium px-2 py-2 text-start">{t("settings.voiceChannels.detail.colE164")}</th>
                      <th className="font-medium px-2 py-2 text-start">{t("settings.voiceChannels.detail.colFriendlyName")}</th>
                      <th className="font-medium px-2 py-2 text-start">{t("settings.voiceChannels.detail.colTwilioSid")}</th>
                      <th className="font-medium px-2 py-2 text-start">{t("settings.voiceChannels.detail.colWebhook")}</th>
                      <th className="font-medium px-2 py-2 text-end">{t("settings.voiceChannels.detail.colActive")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channel.numbers.map((number) => {
                      const isPending = pendingNumberId === number.id;
                      return (
                        <tr
                          key={number.id}
                          className="border-t border-gray-100 align-middle"
                        >
                          <td className="px-2 py-3 font-mono text-gray-900 whitespace-nowrap">
                            {number.e164}
                          </td>
                          <td className="px-2 py-3 text-gray-700">
                            {number.friendlyName || "—"}
                          </td>
                          <td className="px-2 py-3 text-gray-500 font-mono text-xs whitespace-nowrap">
                            {truncateSid(number.twilioSid)}
                          </td>
                          <td className="px-2 py-3">
                            {number.isActive ? (
                              <span
                                className="text-[11px] text-gray-500 font-mono"
                                title={INCOMING_WEBHOOK_URL}
                              >
                                {INCOMING_WEBHOOK_URL}
                              </span>
                            ) : (
                              <span className="text-[11px] text-gray-300 italic">{t("settings.voiceChannels.detail.webhookInactive")}</span>
                            )}
                          </td>
                          <td className="px-2 py-3 text-end">
                            <button
                              onClick={() => handleToggle(number)}
                              disabled={isPending}
                              className={clsx(
                                "relative w-10 h-5 rounded-full transition-colors disabled:opacity-50",
                                number.isActive ? "bg-primary-500" : "bg-gray-300",
                              )}
                              aria-pressed={number.isActive}
                              aria-label={number.isActive ? t("settings.voiceChannels.detail.toggleDeactivate") : t("settings.voiceChannels.detail.toggleActivate")}
                            >
                              <span
                                className={clsx(
                                  "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                                  number.isActive ? "left-5" : "left-0.5",
                                )}
                              />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div className="bg-white rounded-2xl ring-1 ring-red-100 shadow-sm p-5 md:p-6">
            <h2 className="font-semibold text-gray-900">{t("settings.voiceChannels.detail.dangerZone")}</h2>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {t("settings.voiceChannels.detail.dangerZoneDesc")}
            </p>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 min-h-[40px] text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 ring-1 ring-red-200 rounded-xl transition disabled:opacity-50"
            >
              {deleting ? t("settings.voiceChannels.detail.deleting") : t("settings.voiceChannels.detail.deleteButton")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
