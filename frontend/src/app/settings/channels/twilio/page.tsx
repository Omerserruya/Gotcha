"use client";

// Twilio (voice) configuration - a real Settings-owned page, reached from the
// Twilio channel card on /settings/channels (no more 404). Back ALWAYS returns
// to Channels. State is truthful: a draft (PENDING) is never shown as connected;
// only an ACTIVE channel with a usable number is. Deep number/routing/copilot
// config still lives on the per-channel detail page, linked from here.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { RequirePermission } from "@/components/RequirePermission";
import ConfirmModal from "@/components/ConfirmModal";
import { listVoiceChannels, deleteVoiceChannel, refreshVoiceChannelNumbers, type VoiceChannel } from "@/lib/api";

function StateBadge({ state }: { state: string }) {
  const { t } = useI18n();
  const map: Record<string, { cls: string; label: string }> = {
    CONNECTED: { cls: "bg-green-50 text-green-600 ring-green-200", label: t("channels.statusConnected") },
    REQUIRES_ACTION: { cls: "bg-amber-50 text-amber-700 ring-amber-200", label: t("channels.statusRequiresAction") },
    PENDING: { cls: "bg-yellow-50 text-yellow-700 ring-yellow-200", label: t("channels.statusPending") },
    ERROR: { cls: "bg-red-50 text-red-600 ring-red-200", label: t("channels.statusError") },
    DISCONNECTED: { cls: "bg-gray-100 text-gray-500 ring-gray-200", label: t("channels.statusDisconnected") },
  };
  const c = map[state] || map.DISCONNECTED;
  return <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ring-1 ${c.cls}`}>{c.label}</span>;
}

// Truthful per-channel state (mirrors the card aggregate).
function channelState(vc: any): string {
  const activeNumber = (vc.numbers || []).some((n: any) => n.isActive);
  if (vc.status === "ACTIVE" && activeNumber) return vc.healthStatus === "ERROR" ? "REQUIRES_ACTION" : "CONNECTED";
  if (vc.status === "ERROR") return "ERROR";
  if (vc.status === "PENDING") return "PENDING";
  return "DISCONNECTED";
}

function TwilioSettingsInner() {
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ open: boolean; id: string; name: string }>({ open: false, id: "", name: "" });

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await listVoiceChannels(token);
      setChannels(r.data || []);
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const refresh = async (id: string) => {
    if (!token) return;
    setBusy(id);
    setMsg(null);
    try {
      await refreshVoiceChannelNumbers(token, id);
      setMsg({ kind: "ok", text: t("channels.twilioPage.refreshed") });
      await load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("common.error") });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (id: string) => {
    if (!token) return;
    setBusy(id);
    setMsg(null);
    try {
      await deleteVoiceChannel(token, id);
      setConfirmDel({ open: false, id: "", name: "" });
      setMsg({ kind: "ok", text: t("channels.twilioPage.disconnected") });
      await load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? t("common.error") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link href="/settings/channels" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
        <svg className="h-4 w-4 rtl:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        {t("channels.twilioPage.back")}
      </Link>

      <div className="mb-6 mt-3 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-50">
            <svg className="h-6 w-6 text-[#F22F46]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.6 0 12 0zm0 20.4c-4.6 0-8.4-3.8-8.4-8.4S7.4 3.6 12 3.6s8.4 3.8 8.4 8.4-3.8 8.4-8.4 8.4zm4.9-11.2a2.05 2.05 0 11-4.1 0 2.05 2.05 0 014.1 0zm0 5.6a2.05 2.05 0 11-4.1 0 2.05 2.05 0 014.1 0zm-5.6 0a2.05 2.05 0 11-4.1 0 2.05 2.05 0 014.1 0zm0-5.6a2.05 2.05 0 11-4.1 0 2.05 2.05 0 014.1 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t("channels.twilio")}</h1>
            <p className="mt-0.5 text-sm text-gray-500">{t("channels.twilioPage.subtitle")}</p>
          </div>
        </div>
        <a href="/settings/voice-channels/new?return=/settings/channels/twilio" className="shrink-0 rounded-lg bg-primary-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-600">
          {t("channels.voiceConnect")}
        </a>
      </div>

      {msg && (
        <div className={`mb-6 rounded-xl px-4 py-2.5 text-sm border ${msg.kind === "ok" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-gray-50" />
      ) : channels.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-500">{t("channels.twilioPage.none")}</p>
          <a href="/settings/voice-channels/new?return=/settings/channels/twilio" className="mt-3 inline-block rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600">
            {t("channels.voiceConnect")}
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {channels.map((vc) => {
            const anyVc = vc as any;
            const state = channelState(vc);
            const numbers = (vc.numbers || []).filter((n) => n.isActive);
            const caps = (anyVc.capabilities || {}) as Record<string, unknown>;
            const webhookOk = Boolean(anyVc.webhookSecret) || Boolean(vc.hasAuthToken);
            return (
              <div key={vc.id} className="rounded-2xl border border-gray-200 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-gray-900">{vc.friendlyName || t("channels.twilio")}</span>
                    <StateBadge state={state} />
                  </div>
                  <div className="flex items-center gap-2">
                    <button disabled={busy !== null} onClick={() => refresh(vc.id)} className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                      {t("channels.twilioPage.reconnect")}
                    </button>
                    <Link href={`/settings/voice-channels/${vc.id}?return=/settings/channels/twilio`} className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">
                      {t("channels.twilioPage.configure")}
                    </Link>
                    <button disabled={busy !== null} onClick={() => setConfirmDel({ open: true, id: vc.id, name: vc.friendlyName })} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                      {t("channels.twilioPage.disconnect")}
                    </button>
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500">{t("channels.twilioPage.number")}</dt>
                    <dd className="font-medium text-gray-800" dir="ltr">{numbers.map((n) => n.e164).join(", ") || t("channels.twilioPage.noNumber")}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500">{t("channels.twilioPage.account")}</dt>
                    <dd className="font-mono text-gray-700" dir="ltr">{vc.accountSidFingerprint || "-"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500">{t("channels.twilioPage.inbound")}</dt>
                    <dd className={caps.inbound !== false ? "text-green-700" : "text-gray-400"}>{caps.inbound !== false ? t("channels.twilioPage.on") : t("channels.twilioPage.off")}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500">{t("channels.twilioPage.outbound")}</dt>
                    <dd className={caps.outbound !== false ? "text-green-700" : "text-gray-400"}>{caps.outbound !== false ? t("channels.twilioPage.on") : t("channels.twilioPage.off")}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500">{t("channels.twilioPage.webhook")}</dt>
                    <dd className={webhookOk ? "text-green-700" : "text-amber-700"}>{webhookOk ? t("channels.twilioPage.configured") : t("channels.twilioPage.missing")}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500">{t("channels.twilioPage.health")}</dt>
                    <dd className={anyVc.healthStatus === "ERROR" ? "text-red-600" : anyVc.healthStatus === "OK" ? "text-green-700" : "text-gray-500"}>
                      {anyVc.healthStatus ? String(anyVc.healthStatus) : t("channels.twilioPage.unknown")}
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmDel.open}
        title={t("channels.twilioPage.disconnectTitle")}
        message={t("channels.twilioPage.disconnectConfirm")}
        confirmText={t("channels.twilioPage.disconnect")}
        danger
        loading={busy === confirmDel.id}
        onConfirm={() => disconnect(confirmDel.id)}
        onCancel={() => setConfirmDel({ open: false, id: "", name: "" })}
      />
    </div>
  );
}

export default function TwilioSettingsPage() {
  return (
    <RequirePermission perm="channels:manage:read" redirectTo="/settings/channels">
      <TwilioSettingsInner />
    </RequirePermission>
  );
}
